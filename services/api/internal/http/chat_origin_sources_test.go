package http

import (
	"database/sql"
	"errors"
	"testing"

	"github.com/gofiber/fiber/v2"
	"raven/services/api/internal/database"
)

// chatOriginSourceOneByOne is how a copy's source used to be decided, one access check
// per person. The set version must agree with it for everyone.
func chatOriginSourceOneByOne(s *Server, conversationID, viewerID string) (*ChatOriginSource, error) {
	access, err := s.chatAccessFor(s.db, conversationID, viewerID)
	if err == nil {
		if access.Kind == chatKindSaved || access.Kind == chatKindRaven {
			return nil, nil
		}
		source := &ChatOriginSource{ConversationID: conversationID, Kind: access.Kind, Name: access.Name, TreeID: access.TreeID}
		if access.Kind == chatKindDM && access.PeerID != "" {
			peer, err := chatUserRef(s.db, access.PeerID)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			source.Name, source.PeerID = peer.DisplayName, access.PeerID
		}
		return source, nil
	}
	var expected *fiber.Error
	if !errors.As(err, &expected) {
		return nil, err
	}
	source := &ChatOriginSource{ConversationID: conversationID, Kind: chatKindNest}
	err = s.db.QueryRow(
		`SELECT c.name, c.tree_id FROM chat_conversations c JOIN trees t ON t.id = c.tree_id
		 WHERE c.id = ? AND c.kind = 'nest' AND c.status = 'active' AND t.visibility = 'public'`,
		conversationID,
	).Scan(&source.Name, &source.TreeID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return source, err
}

func TestChatOriginSourcesMatchOneByOne(t *testing.T) {
	s, aliceToken := newTestServer(t)
	alice := chatAlice(t, s, aliceToken)
	bob := chatNewPerson(t, s, "bob")
	carol := chatNewPerson(t, s, "carol")
	muted := chatNewPerson(t, s, "muted")
	admin, _ := newAdmin(t, s, "root")
	chatBefriend(t, s, alice, bob)
	chatBefriend(t, s, alice, muted)
	group := chatNewGroup(t, s, alice, "secret-plans", bob, muted)
	dm := chatOpenDM(t, s, alice, bob)
	private := chatNewTree(t, s, alice, "hall", carol, muted)
	privateNest := chatNewTextNest(t, s, alice.token, private.id, "general", "")
	public := chatNewTree(t, s, alice, "square")
	publicNest := chatNewTextNest(t, s, alice.token, public.id, "plaza", "")
	if _, err := s.db.Exec(`UPDATE trees SET visibility = 'public' WHERE id = ?`, public.id); err != nil {
		t.Fatal(err)
	}
	saved := chatSave(t, s, alice, 201, chatSend(t, s, alice.token, dm.ID, "note").ID).Saved[0].ConversationID
	// muted may not read messages at all.
	if _, err := s.db.Exec(`INSERT INTO user_capability_overrides (user_id, capability, allowed, updated_at) VALUES (?, ?, FALSE, ?)`,
		muted.user.ID, database.CapabilityMessagesRead, database.Now()); err != nil {
		t.Fatal(err)
	}

	viewers := []string{alice.user.ID, bob.user.ID, carol.user.ID, muted.user.ID, admin.ID}
	for _, conversationID := range []string{group.ID, dm.ID, privateNest.ID, publicNest.ID, saved, "missing"} {
		got, err := s.chatOriginSourcesFor(s.db, conversationID, viewers)
		if err != nil {
			t.Fatal(err)
		}
		for _, viewer := range viewers {
			want, _ := chatOriginSourceOneByOne(s, conversationID, viewer)
			have := got[viewer]
			if (want == nil) != (have == nil) || (want != nil && *want != *have) {
				t.Errorf("conversation %s, viewer %s: set %+v, one by one %+v", conversationID, viewer, have, want)
			}
		}
	}
}

// Deleting a message for everyone erases its copies only in conversations whose locks it
// holds; a copy that appeared elsewhere since the copies were listed makes it start again.
func TestChatEraseCopiesNeedsTheirLocks(t *testing.T) {
	s, alice, bob, dm := chatPair(t)
	group := chatNewGroup(t, s, alice, "crew", bob)
	original := chatSend(t, s, alice.token, dm.ID, "hello")
	copied := chatForward(t, s, alice, group.ID, 201, []string{original.ID}, nil)[0]

	tx, err := s.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.chatEraseCopiesTx(tx, original.ID, alice.user.ID, database.Now(), map[string]bool{dm.ID: true}); !errors.Is(err, errChatCopiesMoved) {
		t.Fatalf("copy outside the held locks: %v", err)
	}
	_ = tx.Rollback()

	chatDo(t, s, "DELETE", alice.token, "/v1/chat/conversations/"+dm.ID+"/messages/"+original.ID+"?for=everyone", nil, 200)
	if got := chatHistoryFind(t, s, bob, group.ID, copied.ID); got.DeletedAt == nil {
		t.Fatalf("copy not erased: %+v", got)
	}
}
