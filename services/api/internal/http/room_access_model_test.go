package http

import (
	"fmt"
	"math/rand"
	"net/http"
	"testing"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
)

func insertTestRule(t *testing.T, server *Server, treeID, subject, scope, kind, target string, level roomLevel, expiresAt *string) {
	t.Helper()
	now := database.Now()
	if _, err := server.db.Exec(
		`INSERT INTO tree_access_rules (id, tree_id, subject_user_id, scope, scope_rank, kind, target_id, level, expires_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (tree_id, subject_user_id, scope, kind, target_id) DO UPDATE SET level = excluded.level, expires_at = excluded.expires_at`,
		auth.NewID(), treeID, subject, scope, accessScopeRank[scope], kind, target, int(level), expiresAt, now, now,
	); err != nil {
		t.Fatal(err)
	}
}

// The closest rule wins, and the two ways of working that out agree.
func TestRoomLevelSQLMatchesModel(t *testing.T) {
	server, owner := newTestServer(t)
	tree := createTestTree(t, server, owner, "Rooms")
	users := []string{testUserID(t, server, "alice")}
	for _, name := range []string{"bob", "carol", "mona"} {
		user, _ := createTestUser(t, server, name)
		addTestTreeMember(t, server, owner, tree, name)
		users = append(users, user.ID)
	}
	postJSON(t, server, owner, "/v1/trees/"+tree+"/members/"+users[3]+"/role", map[string]string{"role": "moderator"}, http.StatusOK)
	rooms := []roomKey{}
	for i := 0; i < 3; i++ {
		rooms = append(rooms, roomKey{layoutKindVoice, createTestNest(t, server, owner, "/v1/trees/"+tree+"/nests", fmt.Sprintf("Voice %d", i))})
		id, err := server.createTextNestCore(tree, users[0], fmt.Sprintf("Text %d", i), "")
		if err != nil {
			t.Fatal(err)
		}
		rooms = append(rooms, roomKey{layoutKindText, id})
	}
	labels := []string{"l1", "l2", "l3"}
	now := database.Now()
	for _, label := range labels {
		if _, err := server.db.Exec(`INSERT INTO tree_labels (id, tree_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, label, tree, label, now, now); err != nil {
			t.Fatal(err)
		}
	}
	random := rand.New(rand.NewSource(1))
	past, future := database.Timestamp(time.Now().Add(-time.Hour)), database.Timestamp(time.Now().Add(time.Hour))
	for round := 0; round < 40; round++ {
		for _, statement := range []string{`DELETE FROM tree_access_rules`, `DELETE FROM tree_room_labels`} {
			if _, err := server.db.Exec(statement); err != nil {
				t.Fatal(err)
			}
		}
		for _, room := range rooms {
			for _, label := range labels {
				if random.Intn(3) == 0 {
					if _, err := server.db.Exec(`INSERT INTO tree_room_labels (tree_id, kind, room_id, label_id) VALUES (?, ?, ?, ?)`, tree, room.Kind, room.ID, label); err != nil {
						t.Fatal(err)
					}
				}
			}
		}
		for i := 0; i < random.Intn(10); i++ {
			subject := ""
			if random.Intn(2) == 0 {
				subject = users[random.Intn(len(users))]
			}
			var expires *string
			switch random.Intn(4) {
			case 0:
				expires = &past
			case 1:
				expires = &future
			}
			level := roomLevel(random.Intn(3))
			room := rooms[random.Intn(len(rooms))]
			switch random.Intn(3) {
			case 0:
				insertTestRule(t, server, tree, subject, accessScopeAll, room.Kind, "", level, expires)
			case 1:
				insertTestRule(t, server, tree, subject, accessScopeLabel, "", labels[random.Intn(len(labels))], level, expires)
			default:
				insertTestRule(t, server, tree, subject, accessScopeRoom, room.Kind, room.ID, level, expires)
			}
		}
		model, err := loadAccessModel(server.db, tree)
		if err != nil {
			t.Fatal(err)
		}
		model = model.at(database.Now())
		for _, user := range users {
			for _, room := range rooms {
				want, _ := model.resolve(user, model.Roles[user], room)
				got, err := server.roomLevelOf(server.db, tree, room, user)
				if err != nil {
					t.Fatal(err)
				}
				if got != want {
					t.Fatalf("round %d: SQL says %v, model says %v for %s in %v: %+v", round, got, want, user, room, model.Rules)
				}
			}
		}
	}
}

func TestClosestRuleWins(t *testing.T) {
	room := roomKey{layoutKindText, "r"}
	rule := func(subject, scope, kind, target string, level roomLevel) accessRule {
		return accessRule{Subject: subject, Scope: scope, Kind: kind, TargetID: target, Level: level}
	}
	everyoneAll := rule("", accessScopeAll, layoutKindText, "", roomLevelNone)
	everyoneRoom := rule("", accessScopeRoom, layoutKindText, "r", roomLevelNone)
	labelView := rule("", accessScopeLabel, "", "a", roomLevelView)
	labelFull := rule("", accessScopeLabel, "", "b", roomLevelFull)
	bobAll := rule("bob", accessScopeAll, layoutKindText, "", roomLevelFull)
	modNone := rule("mod", accessScopeRoom, layoutKindText, "r", roomLevelNone)
	voice := rule("", accessScopeAll, layoutKindVoice, "", roomLevelNone)
	for _, c := range []struct {
		name  string
		rules []accessRule
		user  string
		role  string
		want  roomLevel
	}{
		{"no rules", nil, "bob", treeRoleMember, roomLevelFull},
		{"not in the tree", nil, "bob", "", roomLevelNone},
		{"everyone, all text", []accessRule{everyoneAll}, "bob", treeRoleMember, roomLevelNone},
		{"another kind", []accessRule{voice}, "bob", treeRoleMember, roomLevelFull},
		{"a label beats all", []accessRule{everyoneAll, labelFull}, "bob", treeRoleMember, roomLevelFull},
		{"a room beats a label", []accessRule{labelFull, everyoneRoom}, "bob", treeRoleMember, roomLevelNone},
		{"labels that disagree allow least", []accessRule{labelFull, labelView}, "bob", treeRoleMember, roomLevelView},
		{"the person beats everyone", []accessRule{everyoneRoom, bobAll}, "bob", treeRoleMember, roomLevelFull},
		{"someone else's rule", []accessRule{everyoneRoom, bobAll}, "ann", treeRoleMember, roomLevelNone},
		{"everyone leaves moderators alone", []accessRule{everyoneRoom}, "mod", treeRoleModerator, roomLevelFull},
		{"a moderator's own rule", []accessRule{modNone}, "mod", treeRoleModerator, roomLevelNone},
		{"the owner is never limited", []accessRule{everyoneRoom, rule("own", accessScopeRoom, layoutKindText, "r", roomLevelNone)}, "own", treeRoleOwner, roomLevelFull},
	} {
		model := accessModel{Rules: c.rules, Labels: map[roomKey][]string{room: {"a", "b"}}}
		if got, _ := model.resolve(c.user, c.role, room); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
