package http

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
	"raven/services/api/internal/relay"

	"github.com/gofiber/fiber/v2"
)

// sseKeepaliveInterval is how often an idle event stream sends a comment line. It keeps
// reverse proxies and CDNs from closing the connection as idle, lets the client detect a
// silently dead stream, and lets the server notice a client that went away.
const sseKeepaliveInterval = 15 * time.Second

// streamSessionCheckTicks is how many keepalive intervals pass between checks that a
// stream's session is still signed in. Revoking or signing out closes the stream at once
// (see closeSession); this catches a session that simply expired.
const streamSessionCheckTicks = 20

// streamFrameBuffer is how many events may wait for one client. A client that falls
// further behind than this is disconnected rather than left with a hole in what it knows.
const streamFrameBuffer = 256

const (
	streamEventNest = "nest-update"
	streamEventChat = "chat"
)

type streamFrame struct {
	event      string
	data       []byte
	enqueuedAt time.Time
}

// streamClient is one open event stream: one signed-in app window.
type streamClient struct {
	userID        string
	authSessionID string
	// chat is false for clients that predate text chat; they are never sent chat events.
	chat   bool
	frames chan streamFrame
	// done is closed, once, when the stream must end: the client went away, could not
	// keep up, or its session was signed out.
	done chan struct{}
	once sync.Once
	// stillValid, when set, is asked now and then whether the session is still good.
	stillValid func() bool
	metrics    *serverMetrics
}

func (c *streamClient) end() {
	c.once.Do(func() { close(c.done) })
}

type eventBroker struct {
	mu      sync.Mutex
	clients map[*streamClient]struct{}
	byUser  map[string]map[*streamClient]struct{}
	metrics *serverMetrics
}

type LiveUpdate struct {
	Type string `json:"type"`
	// TreeID names the tree an update is about, so a client can refresh that tree alone.
	TreeID    string `json:"treeId,omitempty"`
	NestID    string `json:"nestId,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	// ActorID and ActorName identify who an update is about. They are only set on updates
	// delivered to a specific audience (see publishTo), never on broadcasts.
	ActorID   string `json:"actorId,omitempty"`
	ActorName string `json:"actorName,omitempty"`
	// Vote is set on "call.vote" updates, which go only to the people in that vote.
	Vote *CallVoteUpdate `json:"vote,omitempty"`
	// Share and Reason are set on "workshop.share.*" updates, which go only to the people
	// who may see that share.
	Share  *relay.ShareInfo `json:"share,omitempty"`
	Reason string           `json:"reason,omitempty"`
	// Event is set on "event.invited" and "event.reminder" updates, which go only to
	// the event's invitees.
	Event *EventNotice `json:"event,omitempty"`
	At   string          `json:"at"`
}

func newEventBroker() *eventBroker {
	return &eventBroker{
		clients: map[*streamClient]struct{}{},
		byUser:  map[string]map[*streamClient]struct{}{},
	}
}

// subscribe opens a stream for a user with no session attached. Requests use
// subscribeSession; this is for callers that only need to listen.
func (b *eventBroker) subscribe(userID string) *streamClient {
	return b.subscribeSession(userID, "", true)
}

func (b *eventBroker) subscribeSession(userID, authSessionID string, chat bool) *streamClient {
	client := &streamClient{
		userID:        userID,
		authSessionID: authSessionID,
		chat:          chat,
		frames:        make(chan streamFrame, streamFrameBuffer),
		done:          make(chan struct{}),
		metrics:       b.metrics,
	}
	b.mu.Lock()
	b.clients[client] = struct{}{}
	streams := b.byUser[userID]
	if streams == nil {
		streams = map[*streamClient]struct{}{}
		b.byUser[userID] = streams
	}
	streams[client] = struct{}{}
	b.mu.Unlock()
	if b.metrics != nil {
		b.metrics.streamsOpened.Add(1)
		b.metrics.streamsOpen.Add(1)
	}
	return client
}

// unsubscribe is called when a stream's writer returns. It is safe after the broker has
// already dropped the client.
func (b *eventBroker) unsubscribe(client *streamClient) {
	b.mu.Lock()
	b.removeLocked(client, "client_closed")
	b.mu.Unlock()
}

// removeLocked forgets a client and ends its stream. The first reason given is the one
// counted; later calls for the same client do nothing.
func (b *eventBroker) removeLocked(client *streamClient, reason string) {
	if _, ok := b.clients[client]; !ok {
		return
	}
	delete(b.clients, client)
	if streams := b.byUser[client.userID]; streams != nil {
		delete(streams, client)
		if len(streams) == 0 {
			delete(b.byUser, client.userID)
		}
	}
	client.end()
	if b.metrics != nil {
		b.metrics.streamsOpen.Add(-1)
		b.metrics.streamsClosed.inc(reason)
	}
}

// closeWhere ends every stream the predicate picks out.
func (b *eventBroker) closeWhere(reason string, match func(*streamClient) bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for client := range b.clients {
		if match(client) {
			b.removeLocked(client, reason)
		}
	}
}

// closeSession ends the streams of one signed-in session, so a device that was signed
// out stops receiving anything at that moment rather than at its next request.
func (b *eventBroker) closeSession(authSessionID string) {
	if authSessionID == "" {
		return
	}
	b.closeWhere("session_ended", func(client *streamClient) bool { return client.authSessionID == authSessionID })
}

// closeUser ends every stream of one account, on all its devices.
func (b *eventBroker) closeUser(userID string) {
	if userID == "" {
		return
	}
	b.closeWhere("session_ended", func(client *streamClient) bool { return client.userID == userID })
}

// closeChatStreams ends an account's streams that carry chat, so the client opens new
// ones under whatever it is allowed now.
func (b *eventBroker) closeChatStreams(userID string) {
	if userID == "" {
		return
	}
	b.closeWhere("session_ended", func(client *streamClient) bool { return client.userID == userID && client.chat })
}

// closeAll ends every stream. Used when the server is shutting down.
func (b *eventBroker) closeAll() {
	b.closeWhere("shutdown", func(*streamClient) bool { return true })
}

// publish delivers an update to every connected client.
func (b *eventBroker) publish(update LiveUpdate) {
	payload, err := json.Marshal(update)
	if err != nil {
		return
	}
	frame := streamFrame{event: streamEventNest, data: payload, enqueuedAt: time.Now()}
	b.mu.Lock()
	defer b.mu.Unlock()
	for client := range b.clients {
		b.sendLocked(client, frame)
	}
}

// publishTo delivers an update only to the listed users' streams. Use it for anything
// that names a person, so it is not broadcast to the whole server.
func (b *eventBroker) publishTo(update LiveUpdate, userIDs []string) {
	if len(userIDs) == 0 {
		return
	}
	payload, err := json.Marshal(update)
	if err != nil {
		return
	}
	b.sendToUsers(streamFrame{event: streamEventNest, data: payload, enqueuedAt: time.Now()}, userIDs, false)
}

// publishChat delivers a chat event to the listed users' streams and to nobody else.
// Chat events carry message text, so there is deliberately no broadcast form of this.
func (b *eventBroker) publishChat(payload []byte, userIDs []string) {
	if len(userIDs) == 0 {
		return
	}
	b.sendToUsers(streamFrame{event: streamEventChat, data: payload, enqueuedAt: time.Now()}, userIDs, true)
}

func (b *eventBroker) sendToUsers(frame streamFrame, userIDs []string, chatOnly bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, userID := range userIDs {
		for client := range b.byUser[userID] {
			if chatOnly && !client.chat {
				continue
			}
			b.sendLocked(client, frame)
		}
	}
}

// sendLocked queues a frame without ever blocking the publisher. A client whose queue is
// full is not keeping up; skipping one event would leave it wrong without knowing, so its
// stream is ended instead and it catches up in full when it reconnects.
func (b *eventBroker) sendLocked(client *streamClient, frame streamFrame) {
	select {
	case client.frames <- frame:
	default:
		b.removeLocked(client, "lagged")
	}
}

func (s *Server) nestEvents(c *fiber.Ctx) error {
	c.Set("Content-Type", "text/event-stream")
	c.Set("Cache-Control", "no-cache, no-transform")
	c.Set("Connection", "keep-alive")
	// Reverse proxies buffer upstream responses by default, which holds events back until
	// a buffer fills. This header tells nginx to pass the stream through as written.
	c.Set("X-Accel-Buffering", "no")

	user := currentUser(c)
	userID := user.ID
	sessionID := authSessionID(c)
	capabilities, err := s.userCapabilities(user)
	if err != nil {
		return err
	}
	// An account without messages gets a stream with no chat in it at all.
	client := s.events.subscribeSession(userID, sessionID, clientSupportsChat(c) && capabilities.ReadMessages)
	client.stillValid = func() bool { return s.authSessionActive(sessionID, userID) }
	c.Context().SetBodyStreamWriter(func(w *bufio.Writer) {
		defer s.events.unsubscribe(client)
		// This runs outside Fiber's handler chain. An escaped panic here would end the
		// whole process, and every other stream with it.
		defer func() {
			if recovered := recover(); recovered != nil {
				log.Printf("event stream: recovered from panic: %v", recovered)
			}
		}()
		streamEvents(w, client, sseKeepaliveInterval)
	})
	return nil
}

// clientSupportsChat reports whether the caller advertised that it understands chat
// events. Older clients ignore unknown event names, but there is no reason to send them
// message text they will never show.
func clientSupportsChat(c *fiber.Ctx) bool {
	for _, capability := range splitCSV(c.Get("X-Raven-Capabilities")) {
		if capability == chatCapability {
			return true
		}
	}
	return false
}

// authSessionActive reports whether a session is still signed in and unexpired.
func (s *Server) authSessionActive(sessionID, userID string) bool {
	if sessionID == "" {
		return false
	}
	var expiresAt string
	err := s.db.QueryRow(`SELECT expires_at FROM auth_sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, sessionID, userID).Scan(&expiresAt)
	return err == nil && !sessionExpired(expiresAt)
}

// streamEvents writes a client's events as server-sent events until the client goes away
// or its stream is ended, sending a comment line whenever the stream has been idle for
// `keepalive`.
func streamEvents(w *bufio.Writer, client *streamClient, keepalive time.Duration) {
	write := func(frame string) bool {
		if _, err := w.WriteString(frame); err != nil {
			return false
		}
		return w.Flush() == nil
	}
	// Open the stream immediately so the client and any proxy see it established.
	if !write(": connected\n\n") {
		return
	}
	ticker := time.NewTicker(keepalive)
	defer ticker.Stop()
	ticks := 0
	for {
		select {
		case <-client.done:
			return
		case frame := <-client.frames:
			if !write("event: " + frame.event + "\ndata: " + string(frame.data) + "\n\n") {
				return
			}
			if client.metrics != nil && frame.event == streamEventChat {
				client.metrics.streamWriteLag.observeSince(frame.enqueuedAt)
			}
		case <-ticker.C:
			if !write(": keepalive\n\n") {
				return
			}
			ticks++
			if client.stillValid != nil && ticks%streamSessionCheckTicks == 0 && !client.stillValid() {
				return
			}
		}
	}
}

func (s *Server) appendEvent(nestID, sessionID, userID, eventType string, metadata map[string]any) error {
	now := database.Now()
	var raw *string
	if metadata != nil {
		bytes, err := json.Marshal(metadata)
		if err != nil {
			return err
		}
		value := string(bytes)
		raw = &value
	}
	_, err := s.db.Exec(
		`INSERT INTO nest_event_log (id, nest_id, session_id, user_id, event_type, metadata_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		auth.NewID(), nestID, nullableString(sessionID), nullableString(userID), eventType, raw, now,
	)
	return err
}

// broadcastNestUpdate tells the people who can see a nest that something about it
// changed. Despite the name it is not sent to everyone: see nestAudience.
func (s *Server) broadcastNestUpdate(nestID, updateType string) {
	s.publishNest(LiveUpdate{Type: updateType, NestID: nestID, At: database.Now()})
}

func (s *Server) broadcastSessionUpdate(nestID, sessionID, updateType string) {
	s.publishNest(LiveUpdate{Type: updateType, NestID: nestID, SessionID: sessionID, At: database.Now()})
}

func (s *Server) publishNest(update LiveUpdate) {
	treeID, audience, err := s.nestAudience(update.NestID)
	if err != nil {
		log.Printf("event stream: audience for nest update %s: %v", update.Type, err)
		return
	}
	update.TreeID = treeID
	s.events.publishTo(update, audience)
}

// nestAudience lists who hears about a voice nest. For a nest in a tree that is the
// tree's members. For one outside any tree it is whoever started it, the people in it or
// invited to it, and anyone waiting to be let in.
func (s *Server) nestAudience(nestID string) (string, []string, error) {
	return s.nestAudienceIn(s.db, nestID)
}

func (s *Server) nestAudienceIn(q chatQuerier, nestID string) (string, []string, error) {
	var treeID sql.NullString
	var nestType, creatorID string
	err := q.QueryRow(`SELECT tree_id, type, creator_user_id FROM nests WHERE id = ?`, nestID).Scan(&treeID, &nestType, &creatorID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	if treeID.Valid && treeID.String != "" && nestType == "persistent" {
		members, err := treeMemberIDsIn(q, treeID.String)
		return treeID.String, members, err
	}
	rows, err := q.Query(
		`SELECT user_id FROM nest_members WHERE nest_id = ? AND state IN ('joined', 'invited')
		 UNION
		 SELECT user_id FROM nest_join_requests WHERE nest_id = ? AND status = 'pending'`,
		nestID, nestID,
	)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	audience := []string{creatorID}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return "", nil, err
		}
		if id != creatorID {
			audience = append(audience, id)
		}
	}
	return "", audience, rows.Err()
}

func (s *Server) treeMemberIDs(treeID string) ([]string, error) {
	return treeMemberIDsIn(s.db, treeID)
}

func treeMemberIDsIn(q chatQuerier, treeID string) ([]string, error) {
	rows, err := q.Query(`SELECT user_id FROM tree_members WHERE tree_id = ? AND state = 'joined'`, treeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// publishTree tells a tree's members that something about it changed. `also` adds people
// who are not members but are affected: someone just removed, or someone asking to join.
func (s *Server) publishTree(treeID, updateType string, also ...string) {
	members, err := s.treeMemberIDs(treeID)
	if err != nil {
		log.Printf("event stream: audience for tree update %s: %v", updateType, err)
		return
	}
	s.publishTreeTo(treeID, updateType, append(members, also...))
}

// publishTreeTo is publishTree for an audience worked out beforehand, which is needed
// once the tree's rows are gone.
func (s *Server) publishTreeTo(treeID, updateType string, userIDs []string) {
	seen := map[string]struct{}{}
	audience := make([]string, 0, len(userIDs))
	for _, id := range userIDs {
		if _, dup := seen[id]; dup || id == "" {
			continue
		}
		seen[id] = struct{}{}
		audience = append(audience, id)
	}
	s.events.publishTo(LiveUpdate{Type: updateType, TreeID: treeID, At: database.Now()}, audience)
}

// publishToUser sends one person something that is about them alone: they were removed
// from a tree, their role changed, or what their account may do changed.
func (s *Server) publishToUser(userID, updateType, treeID string) {
	s.events.publishTo(LiveUpdate{Type: updateType, TreeID: treeID, At: database.Now()}, []string{userID})
}

func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func normalizeNestType(value, fallback string) string {
	if value == "" {
		value = fallback
	}
	if value == "permanent" {
		value = "persistent"
	}
	if value != "persistent" && value != "temporary" {
		return ""
	}
	return value
}
