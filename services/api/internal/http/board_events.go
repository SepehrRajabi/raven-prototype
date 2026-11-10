package http

import (
	"database/sql"
	"log"
	"strings"
	"time"
	_ "time/tzdata" // occurrences are computed in the creator's zone, wherever the API runs
	"unicode/utf8"

	"github.com/gofiber/fiber/v2"

	"raven/services/api/internal/auth"
	"raven/services/api/internal/database"
)

// Scheduled events: a gathering in one room of a space. Members see them in the lobby;
// invitees are told when invited, reminded ten minutes before each occurrence and, when
// the scheduler asks, sent one message from Raven that is updated in place on every edit.
// An event lives only until its last occurrence ends: there is no history.

const (
	treeEventTitleRunes = 80
	treeEventDescRunes  = 1000
	// treeEventStoredRunes is the hard limit on a stored description, mention tokens in full.
	treeEventStoredRunes = 4000
	treeEventMaxInvitees = 500
	// treeEventUpcoming is how far ahead the upcoming list looks.
	treeEventUpcoming = 30 * 24 * time.Hour
	// treeEventReminder is how long before an occurrence its invitees are reminded.
	treeEventReminder = 10 * time.Minute
	// treeEventDefaultLength is how long an occurrence lasts with neither end nor duration.
	treeEventDefaultLength = time.Hour
	treeEventMaxLength     = 7 * 24 * time.Hour
	// treeEventMaxRepeatLength keeps one occurrence of a series from running into the next.
	treeEventMaxRepeatLength = 24 * time.Hour
)

var errEventOrder = fiber.NewError(fiber.StatusBadRequest, "That order doesn’t match the pinned events in this space.")
var errEventMissing = fiber.NewError(fiber.StatusNotFound, "That event isn’t there.")
var errBoardPinsFull = fiber.NewError(fiber.StatusBadRequest, "A space can have at most 5 pinned notes and events.")

type TreeEventOccurrence struct {
	StartsAt string `json:"startsAt"`
	EndsAt   string `json:"endsAt"`
}

type TreeEvent struct {
	ID              string  `json:"id"`
	Title           string  `json:"title"`
	Description     string  `json:"description"`
	HostUserID      string  `json:"hostUserId"`
	HostName        string  `json:"hostName"`
	NestID          *string `json:"nestId"`
	ConversationID  *string `json:"conversationId"`
	RoomName        string  `json:"roomName"`
	StartsAt        string  `json:"startsAt"`
	EndsAt          *string `json:"endsAt"`
	DurationMinutes *int    `json:"durationMinutes"`
	RRule           *string `json:"rrule"`
	TZ              string  `json:"tz"`
	InviteAll       bool    `json:"inviteAll"`
	// InviteeIDs is filled only for people who manage the board.
	InviteeIDs        []string            `json:"inviteeIds"`
	SendInviteMessage bool                `json:"sendInviteMessage"`
	Pinned            bool                `json:"pinned"`
	Occurrence        TreeEventOccurrence `json:"occurrence"`

	treeID    string
	createdAt string
	sched     eventSchedule
	next      eventOccurrence
	prev      eventOccurrence
	hasPrev   bool
}

// EventNotice rides on "event.invited" and "event.reminder" updates, which go only to
// invitees, so the client can word a notification without fetching anything.
type EventNotice struct {
	ID       string `json:"id"`
	TreeID   string `json:"treeId"`
	Title    string `json:"title"`
	Space    string `json:"space"`
	Room     string `json:"room"`
	Host     string `json:"host"`
	StartsAt string `json:"startsAt"`
}

func (s *Server) registerEventRoutes(service fiber.Router) {
	service.Get("/trees/:id/events", s.chatRoute("list events", s.getTreeEvents))
	service.Post("/trees/:id/events", s.chatRoute("create event", s.createTreeEvent))
	// Registered before ":eventId" so "order" is not read as an event id.
	service.Post("/trees/:id/events/order", s.chatRoute("order events", s.orderTreeEvents))
	service.Post("/trees/:id/events/:eventId/pin", s.chatRoute("pin event", s.pinTreeEvent))
	service.Post("/trees/:id/events/:eventId", s.chatRoute("edit event", s.editTreeEvent))
	service.Delete("/trees/:id/events/:eventId", s.chatRoute("delete event", s.deleteTreeEvent))
}

const treeEventColumns = `e.id, e.tree_id, e.title, e.description, e.host_user_id, e.nest_id, e.conversation_id,
	COALESCE(n.name, c.name, ''), e.starts_at, e.ends_at, e.duration_minutes, e.rrule, e.tz, e.invite_all,
	e.send_invite_message, e.pinned, e.created_at`

const treeEventJoins = `FROM tree_events e
	LEFT JOIN nests n ON n.id = e.nest_id
	LEFT JOIN chat_conversations c ON c.id = e.conversation_id`

// treeEventTargetLive is true when an event's room still exists.
const treeEventTargetLive = `((e.nest_id IS NOT NULL AND n.status = 'active') OR (e.conversation_id IS NOT NULL AND c.status = 'active'))`

func scanTreeEvent(row interface{ Scan(...any) error }) (TreeEvent, error) {
	var event TreeEvent
	var nest, conversation, ends, rrule sql.NullString
	var duration sql.NullInt64
	if err := row.Scan(&event.ID, &event.treeID, &event.Title, &event.Description, &event.HostUserID, &nest, &conversation,
		&event.RoomName, &event.StartsAt, &ends, &duration, &rrule, &event.TZ, &event.InviteAll,
		&event.SendInviteMessage, &event.Pinned, &event.createdAt); err != nil {
		return event, err
	}
	// A stored row is always valid; if one is not, its zero schedule reads as over.
	event, _ = finishTreeEvent(event, nest, conversation, ends, rrule, duration)
	return event, nil
}

// treeEventSchedule builds a schedule from stored or submitted fields.
func treeEventSchedule(startsAt string, endsAt *string, duration *int, rrule *string, tz string) (eventSchedule, error) {
	first, err := time.Parse(time.RFC3339, startsAt)
	if err != nil {
		return eventSchedule{}, err
	}
	length := treeEventDefaultLength
	if endsAt != nil {
		end, err := time.Parse(time.RFC3339, *endsAt)
		if err != nil {
			return eventSchedule{}, err
		}
		length = end.Sub(first)
	} else if duration != nil {
		length = time.Duration(*duration) * time.Minute
	}
	zone, err := time.LoadLocation(tz)
	if err != nil {
		return eventSchedule{}, err
	}
	sched := eventSchedule{First: first, Length: length, Zone: zone}
	if rrule != nil {
		rule, err := parseEventRule(*rrule)
		if err != nil {
			return eventSchedule{}, err
		}
		sched.Rule = &rule
	}
	return sched, nil
}

// treeEvents lists a space's events that still have an occurrence to come or under way,
// pinned ones first in their order, then by when they next start.
func (s *Server) treeEvents(q chatQuerier, treeID string, now time.Time, withInvitees bool) ([]TreeEvent, error) {
	rows, err := q.Query(
		`SELECT `+treeEventColumns+`, COALESCE(e.pin_position, 0) `+treeEventJoins+`
		 WHERE e.tree_id = ? AND `+treeEventTargetLive+` ORDER BY e.pinned DESC, e.pin_position, e.starts_at, e.id`,
		treeID,
	)
	if err != nil {
		return nil, err
	}
	events := []TreeEvent{}
	for rows.Next() {
		var event TreeEvent
		var position int
		var nest, conversation, ends, rrule sql.NullString
		var duration sql.NullInt64
		if err := rows.Scan(&event.ID, &event.treeID, &event.Title, &event.Description, &event.HostUserID, &nest, &conversation,
			&event.RoomName, &event.StartsAt, &ends, &duration, &rrule, &event.TZ, &event.InviteAll,
			&event.SendInviteMessage, &event.Pinned, &event.createdAt, &position); err != nil {
			rows.Close()
			return nil, err
		}
		event, err = finishTreeEvent(event, nest, conversation, ends, rrule, duration)
		if err != nil {
			continue
		}
		if !event.at(now) {
			continue
		}
		events = append(events, event)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range events {
		events[i].HostName = s.spaceNameOf(treeID, User{ID: events[i].HostUserID, DisplayName: s.globalNameOf(events[i].HostUserID)})
		if withInvitees && !events[i].InviteAll {
			if events[i].InviteeIDs, err = treeEventInviteeRows(q, events[i].ID); err != nil {
				return nil, err
			}
		}
	}
	return events, nil
}

func finishTreeEvent(event TreeEvent, nest, conversation, ends, rrule sql.NullString, duration sql.NullInt64) (TreeEvent, error) {
	event.NestID = nullStringPtr(nest)
	event.ConversationID = nullStringPtr(conversation)
	event.EndsAt = nullStringPtr(ends)
	event.RRule = nullStringPtr(rrule)
	if duration.Valid {
		minutes := int(duration.Int64)
		event.DurationMinutes = &minutes
	}
	event.InviteeIDs = []string{}
	sched, err := treeEventSchedule(event.StartsAt, event.EndsAt, event.DurationMinutes, event.RRule, event.TZ)
	if err != nil {
		log.Printf("board events: schedule of %s: %v", event.ID, err)
		return event, err
	}
	event.sched = sched
	return event, nil
}

// at places the event at now: its next or current occurrence and the one before. It is
// false once the series is over.
func (event *TreeEvent) at(now time.Time) bool {
	next, ok, prev, hasPrev := event.sched.around(now)
	event.next, event.prev, event.hasPrev = next, prev, hasPrev
	if !ok {
		return false
	}
	event.Occurrence = TreeEventOccurrence{StartsAt: next.Start.Format(boardTimeLayout), EndsAt: next.End.Format(boardTimeLayout)}
	return true
}

func (s *Server) globalNameOf(userID string) string {
	var name string
	if err := s.db.QueryRow(
		`SELECT COALESCE(NULLIF(TRIM(up.display_name), ''), u.username) FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id WHERE u.id = ?`,
		userID,
	).Scan(&name); err != nil {
		return ""
	}
	return name
}

func treeEventInviteeRows(q chatQuerier, eventID string) ([]string, error) {
	rows, err := q.Query(`SELECT user_id FROM tree_event_invitees WHERE event_id = ? ORDER BY user_id`, eventID)
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

// treeEventInvitees is everyone invited who is still in the space: every member for an
// event open to the whole space.
func (s *Server) treeEventInvitees(event TreeEvent) ([]string, error) {
	if event.InviteAll {
		return s.treeMemberIDs(event.treeID)
	}
	rows, err := s.db.Query(
		`SELECT i.user_id FROM tree_event_invitees i
		 JOIN tree_members tm ON tm.tree_id = ? AND tm.user_id = i.user_id AND tm.state = 'joined'
		 WHERE i.event_id = ?`,
		event.treeID, event.ID,
	)
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

func (s *Server) loadTreeEvent(treeID, eventID string) (TreeEvent, error) {
	row := s.db.QueryRow(`SELECT `+treeEventColumns+` `+treeEventJoins+` WHERE e.id = ? AND e.tree_id = ?`, eventID, treeID)
	event, err := scanTreeEvent(row)
	if err == sql.ErrNoRows {
		return event, errEventMissing
	}
	if err != nil {
		return event, err
	}
	event.at(time.Now())
	event.HostName = s.spaceNameOf(treeID, User{ID: event.HostUserID, DisplayName: s.globalNameOf(event.HostUserID)})
	return event, nil
}

// boardPinCount is what counts toward the five pins of a lobby: notes still showing
// plus pinned events.
func (s *Server) boardPinCount(treeID string, now time.Time) (int, error) {
	var notes, events int
	if err := s.db.QueryRow(
		`SELECT COUNT(*) FROM tree_notes WHERE tree_id = ? AND (ends_at IS NULL OR ends_at > ?)`,
		treeID, now.UTC().Format(boardTimeLayout),
	).Scan(&notes); err != nil {
		return 0, err
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM tree_events WHERE tree_id = ? AND pinned = TRUE`, treeID).Scan(&events); err != nil {
		return 0, err
	}
	return notes + events, nil
}

type treeEventInput struct {
	Title             string   `json:"title"`
	Description       string   `json:"description"`
	HostUserID        string   `json:"hostUserId"`
	NestID            *string  `json:"nestId"`
	ConversationID    *string  `json:"conversationId"`
	StartsAt          string   `json:"startsAt"`
	EndsAt            *string  `json:"endsAt"`
	DurationMinutes   *int     `json:"durationMinutes"`
	RRule             *string  `json:"rrule"`
	TZ                string   `json:"tz"`
	InviteAll         bool     `json:"inviteAll"`
	InviteeIDs        []string `json:"inviteeIds"`
	SendInviteMessage bool     `json:"sendInviteMessage"`
	Pinned            bool     `json:"pinned"`
}

func blankToNil(value *string) *string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	return &trimmed
}

// clean checks an event as submitted and returns it ready to store. The room, host,
// invitees and mentions are checked against the space.
func (s *Server) cleanTreeEvent(treeID string, actor User, input treeEventInput, now time.Time) (TreeEvent, []string, error) {
	bad := func(message string) error { return fiber.NewError(fiber.StatusBadRequest, message) }
	event := TreeEvent{treeID: treeID, InviteAll: input.InviteAll, SendInviteMessage: input.SendInviteMessage, Pinned: input.Pinned}
	event.Title = strings.TrimSpace(input.Title)
	event.Description = strings.TrimSpace(input.Description)
	if event.Title == "" {
		return event, nil, bad("Write a title first.")
	}
	for _, text := range []string{event.Title, event.Description} {
		if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
			return event, nil, bad("That event contains text Raven cannot store.")
		}
	}
	if utf8.RuneCountInString(event.Title) > treeEventTitleRunes {
		return event, nil, bad("A title can be at most 80 characters.")
	}
	if noteShownLength(event.Description) > treeEventDescRunes || utf8.RuneCountInString(event.Description) > treeEventStoredRunes {
		return event, nil, bad("A description can be at most 1000 characters.")
	}
	if err := s.validateSpaceMentions(s.db, treeID, event.Title, event.Description); err != nil {
		return event, nil, err
	}

	// The room: exactly one, a voice or text room of this space.
	event.NestID, event.ConversationID = blankToNil(input.NestID), blankToNil(input.ConversationID)
	if (event.NestID == nil) == (event.ConversationID == nil) {
		return event, nil, bad("Choose a room for the event.")
	}
	var roomQuery, roomID string
	if event.NestID != nil {
		roomQuery, roomID = `SELECT name FROM nests WHERE id = ? AND tree_id = ? AND status = 'active' AND type = 'persistent'`, *event.NestID
	} else {
		roomQuery, roomID = `SELECT name FROM chat_conversations WHERE id = ? AND tree_id = ? AND kind = 'nest' AND status = 'active'`, *event.ConversationID
	}
	if err := s.db.QueryRow(roomQuery, roomID, treeID).Scan(&event.RoomName); err != nil {
		if err == sql.ErrNoRows {
			return event, nil, bad("Choose a room of this space.")
		}
		return event, nil, err
	}

	// The host: a member, you unless chosen.
	event.HostUserID = strings.TrimSpace(input.HostUserID)
	if event.HostUserID == "" {
		event.HostUserID = actor.ID
	}
	if ok, err := s.isJoinedTreeMember(treeID, event.HostUserID); err != nil {
		return event, nil, err
	} else if !ok {
		return event, nil, bad("The host must be a member of this space.")
	}

	// Times.
	start, err := time.Parse(time.RFC3339, strings.TrimSpace(input.StartsAt))
	if err != nil {
		return event, nil, bad("That start time isn’t valid.")
	}
	event.StartsAt = start.UTC().Format(boardTimeLayout)
	event.EndsAt = blankToNil(input.EndsAt)
	if event.EndsAt != nil && input.DurationMinutes != nil {
		return event, nil, bad("Give an end time or a duration, not both.")
	}
	length := treeEventDefaultLength
	if event.EndsAt != nil {
		end, err := time.Parse(time.RFC3339, *event.EndsAt)
		if err != nil {
			return event, nil, bad("That end time isn’t valid.")
		}
		formatted := end.UTC().Format(boardTimeLayout)
		event.EndsAt = &formatted
		length = end.Sub(start)
	} else if input.DurationMinutes != nil {
		minutes := *input.DurationMinutes
		event.DurationMinutes = &minutes
		length = time.Duration(minutes) * time.Minute
	}
	if length <= 0 {
		return event, nil, bad("An event has to end after it starts.")
	}
	if length > treeEventMaxLength {
		return event, nil, bad("An event can last at most 7 days.")
	}
	event.TZ = strings.TrimSpace(input.TZ)
	if event.TZ == "" {
		event.TZ = "UTC"
	}
	if _, err := time.LoadLocation(event.TZ); err != nil {
		return event, nil, bad("That time zone isn’t known.")
	}
	if rule := blankToNil(input.RRule); rule != nil {
		parsed, err := parseEventRule(*rule)
		if err != nil {
			return event, nil, bad("Raven can repeat an event daily, weekly or monthly, until a date or a number of times.")
		}
		if length > treeEventMaxRepeatLength {
			return event, nil, bad("An event that repeats can last at most a day.")
		}
		if parsed.Until != nil && parsed.Until.Before(start) {
			return event, nil, bad("Pick an end for the series after its start.")
		}
		canonical := parsed.String()
		event.RRule = &canonical
	}
	event.sched, err = treeEventSchedule(event.StartsAt, event.EndsAt, event.DurationMinutes, event.RRule, event.TZ)
	if err != nil {
		return event, nil, bad("That start time isn’t valid.")
	}
	if !event.at(now) {
		return event, nil, bad("Pick a time that hasn’t passed yet.")
	}

	// Invitees: members of this space.
	invitees := []string{}
	if !event.InviteAll {
		invitees = chatUniqueIDs(input.InviteeIDs, "")
		if len(invitees) > treeEventMaxInvitees {
			return event, nil, bad("An event can invite at most 500 people. Invite everyone in the space instead.")
		}
		for _, id := range invitees {
			if ok, err := s.isJoinedTreeMember(treeID, id); err != nil {
				return event, nil, err
			} else if !ok {
				return event, nil, bad("You can only invite members of this space.")
			}
		}
	}
	event.InviteeIDs = invitees
	return event, invitees, nil
}

func (s *Server) isJoinedTreeMember(treeID, userID string) (bool, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM tree_members WHERE tree_id = ? AND user_id = ? AND state = 'joined'`, treeID, userID).Scan(&count)
	return count > 0, err
}

func (s *Server) getTreeEvents(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	role, err := s.authorizeTree(s.db, user.ID, treeID, treeActionView)
	if err != nil {
		return err
	}
	now := time.Now()
	events, err := s.treeEvents(s.db, treeID, now, treeRoleAllows(role, treeActionManageBoard))
	if err != nil {
		return err
	}
	upcoming := []TreeEvent{}
	for _, event := range events {
		if event.next.Start.Before(now.Add(treeEventUpcoming)) {
			upcoming = append(upcoming, event)
		}
	}
	return c.JSON(fiber.Map{"events": upcoming})
}

func (s *Server) createTreeEvent(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireBoardManager(user.ID, treeID); err != nil {
		return err
	}
	var input treeEventInput
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	now := time.Now()
	event, invitees, err := s.cleanTreeEvent(treeID, user, input, now)
	if err != nil {
		return err
	}
	event.ID = auth.NewID()

	unlock := s.chatLocks.lock("tree-notes:" + treeID)
	var position any
	if event.Pinned {
		count, err := s.boardPinCount(treeID, now)
		if err != nil {
			unlock()
			return err
		}
		if count >= treeMaxNotes {
			unlock()
			return errBoardPinsFull
		}
		var last int
		if err := s.db.QueryRow(`SELECT COALESCE(MAX(pin_position), -1) FROM tree_events WHERE tree_id = ? AND pinned = TRUE`, treeID).Scan(&last); err != nil {
			unlock()
			return err
		}
		position = last + 1
	}
	err = s.storeTreeEvent(event, invitees, user.ID, position, true)
	unlock()
	if err != nil {
		return err
	}

	stored, err := s.loadTreeEvent(treeID, event.ID)
	if err != nil {
		return err
	}
	s.publishTree(treeID, "tree.updated")
	recipients, err := s.treeEventInvitees(stored)
	if err != nil {
		return err
	}
	recipients = withoutID(recipients, user.ID)
	s.publishEventNotice("event.invited", stored, recipients)
	if stored.SendInviteMessage {
		s.sendEventMessages(stored, recipients, false)
	}
	stored.InviteeIDs = invitees
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"event": stored})
}

func (s *Server) storeTreeEvent(event TreeEvent, invitees []string, actorID string, position any, create bool) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stamp := database.Now()
	var seriesEnd any
	if last, ok := event.sched.last(); ok {
		seriesEnd = last.End.Format(boardTimeLayout)
	}
	if create {
		_, err = tx.Exec(
			`INSERT INTO tree_events (id, tree_id, nest_id, conversation_id, title, description, host_user_id, starts_at, ends_at,
			 duration_minutes, rrule, tz, invite_all, send_invite_message, pinned, pin_position, series_ends_at, created_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			event.ID, event.treeID, event.NestID, event.ConversationID, event.Title, event.Description, event.HostUserID, event.StartsAt,
			event.EndsAt, event.DurationMinutes, event.RRule, event.TZ, event.InviteAll, event.SendInviteMessage, event.Pinned, position,
			seriesEnd, actorID, stamp, stamp,
		)
	} else {
		_, err = tx.Exec(
			`UPDATE tree_events SET nest_id = ?, conversation_id = ?, title = ?, description = ?, host_user_id = ?, starts_at = ?, ends_at = ?,
			 duration_minutes = ?, rrule = ?, tz = ?, invite_all = ?, send_invite_message = ?, pinned = ?, pin_position = ?, series_ends_at = ?, updated_at = ?
			 WHERE id = ? AND tree_id = ?`,
			event.NestID, event.ConversationID, event.Title, event.Description, event.HostUserID, event.StartsAt, event.EndsAt,
			event.DurationMinutes, event.RRule, event.TZ, event.InviteAll, event.SendInviteMessage, event.Pinned, position, seriesEnd, stamp,
			event.ID, event.treeID,
		)
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM tree_event_invitees WHERE event_id = ?`, event.ID); err != nil {
		return err
	}
	for _, id := range invitees {
		if _, err := tx.Exec(`INSERT INTO tree_event_invitees (event_id, user_id) VALUES (?, ?)`, event.ID, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func withoutID(ids []string, drop string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if id != drop {
			out = append(out, id)
		}
	}
	return out
}

func (s *Server) editTreeEvent(c *fiber.Ctx) error {
	user := currentUser(c)
	treeID := c.Params("id")
	if err := s.requireBoardManager(user.ID, treeID); err != nil {
		return err
	}
	var input treeEventInput
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	before, err := s.loadTreeEvent(treeID, c.Params("eventId"))
	if err != nil {
		return err
	}
	now := time.Now()
	event, invitees, err := s.cleanTreeEvent(treeID, user, input, now)
	if err != nil {
		return err
	}
	event.ID = before.ID
	oldInvitees, err := s.treeEventInvitees(before)
	if err != nil {
		return err
	}

	unlock := s.chatLocks.lock("tree-notes:" + treeID)
	var position any
	if event.Pinned {
		var current sql.NullInt64
		if err := s.db.QueryRow(`SELECT pin_position FROM tree_events WHERE id = ?`, event.ID).Scan(&current); err != nil {
			unlock()
			return err
		}
		if before.Pinned && current.Valid {
			position = current.Int64
		} else {
			count, err := s.boardPinCount(treeID, now)
			if err != nil {
				unlock()
				return err
			}
			if count >= treeMaxNotes {
				unlock()
				return errBoardPinsFull
			}
			var last int
			if err := s.db.QueryRow(`SELECT COALESCE(MAX(pin_position), -1) FROM tree_events WHERE tree_id = ? AND pinned = TRUE`, treeID).Scan(&last); err != nil {
				unlock()
				return err
			}
			position = last + 1
		}
	}
	err = s.storeTreeEvent(event, invitees, user.ID, position, false)
	unlock()
	if err != nil {
		return err
	}
	// A changed series starts its reminders afresh.
	if _, err := s.db.Exec(`DELETE FROM tree_event_reminders_sent WHERE event_id = ? AND kind <> 'ended'`, event.ID); err != nil {
		return err
	}

	stored, err := s.loadTreeEvent(treeID, event.ID)
	if err != nil {
		return err
	}
	s.publishTree(treeID, "tree.updated")
	newInvitees, err := s.treeEventInvitees(stored)
	if err != nil {
		return err
	}
	had := map[string]bool{}
	for _, id := range oldInvitees {
		had[id] = true
	}
	added := []string{}
	for _, id := range newInvitees {
		if !had[id] && id != user.ID {
			added = append(added, id)
		}
	}
	s.publishEventNotice("event.invited", stored, added)

	messaged, err := s.eventMessageRecipients(stored.ID)
	if err != nil {
		return err
	}
	if stored.SendInviteMessage {
		s.sendEventMessages(stored, withoutID(newInvitees, user.ID), true)
	}
	// People no longer invited learn it is off for them.
	still := map[string]bool{}
	for _, id := range newInvitees {
		still[id] = true
	}
	dropped := []string{}
	for _, id := range messaged {
		if !still[id] {
			dropped = append(dropped, id)
		}
	}
	s.cancelEventMessages(stored, dropped)
	stored.InviteeIDs = invitees
	return c.JSON(fiber.Map{"event": stored})
}

func (s *Server) deleteTreeEvent(c *fiber.Ctx) error {
	treeID := c.Params("id")
	if err := s.requireBoardManager(currentUser(c).ID, treeID); err != nil {
		return err
	}
	event, err := s.loadTreeEvent(treeID, c.Params("eventId"))
	if err != nil {
		return err
	}
	if err := s.removeTreeEvent(event, true); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// removeTreeEvent deletes an event and tells the space. When it is called off rather
// than over, everyone Raven wrote to about it is told it was cancelled.
func (s *Server) removeTreeEvent(event TreeEvent, cancelled bool) error {
	var messaged []string
	if cancelled {
		var err error
		if messaged, err = s.eventMessageRecipients(event.ID); err != nil {
			return err
		}
	}
	if _, err := s.db.Exec(`DELETE FROM tree_event_invitees WHERE event_id = ?`, event.ID); err != nil {
		return err
	}
	if _, err := s.db.Exec(`DELETE FROM tree_event_reminders_sent WHERE event_id = ?`, event.ID); err != nil {
		return err
	}
	if _, err := s.db.Exec(`DELETE FROM tree_events WHERE id = ?`, event.ID); err != nil {
		return err
	}
	s.publishTree(event.treeID, "tree.updated")
	s.cancelEventMessages(event, messaged)
	return nil
}

func (s *Server) pinTreeEvent(c *fiber.Ctx) error {
	treeID := c.Params("id")
	if err := s.requireBoardManager(currentUser(c).ID, treeID); err != nil {
		return err
	}
	var input struct {
		Pinned bool `json:"pinned"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	event, err := s.loadTreeEvent(treeID, c.Params("eventId"))
	if err != nil {
		return err
	}
	unlock := s.chatLocks.lock("tree-notes:" + treeID)
	defer unlock()
	if input.Pinned && !event.Pinned {
		count, err := s.boardPinCount(treeID, time.Now())
		if err != nil {
			return err
		}
		if count >= treeMaxNotes {
			return errBoardPinsFull
		}
		if _, err := s.db.Exec(
			`UPDATE tree_events SET pinned = TRUE, updated_at = ?,
			 pin_position = (SELECT COALESCE(MAX(pin_position), -1) + 1 FROM tree_events WHERE tree_id = ? AND pinned = TRUE)
			 WHERE id = ?`,
			database.Now(), treeID, event.ID,
		); err != nil {
			return err
		}
	} else if !input.Pinned && event.Pinned {
		if _, err := s.db.Exec(`UPDATE tree_events SET pinned = FALSE, pin_position = NULL, updated_at = ? WHERE id = ?`, database.Now(), event.ID); err != nil {
			return err
		}
	}
	s.publishTree(treeID, "tree.updated")
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) orderTreeEvents(c *fiber.Ctx) error {
	treeID := c.Params("id")
	if err := s.requireBoardManager(currentUser(c).ID, treeID); err != nil {
		return err
	}
	var input struct {
		IDs []string `json:"ids"`
	}
	if err := c.BodyParser(&input); err != nil {
		return errChatInvalidBody
	}
	unlock := s.chatLocks.lock("tree-notes:" + treeID)
	defer unlock()
	rows, err := s.db.Query(`SELECT id FROM tree_events WHERE tree_id = ? AND pinned = TRUE`, treeID)
	if err != nil {
		return err
	}
	known := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		known[id] = true
	}
	rows.Close()
	seen := map[string]bool{}
	for _, id := range input.IDs {
		if !known[id] || seen[id] {
			return errEventOrder
		}
		seen[id] = true
	}
	if len(seen) != len(known) {
		return errEventOrder
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stamp := database.Now()
	for position, id := range input.IDs {
		if _, err := tx.Exec(`UPDATE tree_events SET pin_position = ?, updated_at = ? WHERE id = ? AND tree_id = ?`, position, stamp, id, treeID); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.publishTree(treeID, "tree.updated")
	return c.SendStatus(fiber.StatusNoContent)
}

// ---- Telling people ----

func (s *Server) treeNameOf(treeID string) string {
	var name string
	if err := s.db.QueryRow(`SELECT name FROM trees WHERE id = ?`, treeID).Scan(&name); err != nil {
		return ""
	}
	return name
}

func (s *Server) publishEventNotice(updateType string, event TreeEvent, userIDs []string) {
	if len(userIDs) == 0 {
		return
	}
	notice := &EventNotice{
		ID: event.ID, TreeID: event.treeID, Title: event.Title, Space: s.treeNameOf(event.treeID),
		Room: event.RoomName, Host: event.HostName, StartsAt: event.Occurrence.StartsAt,
	}
	s.events.publishTo(LiveUpdate{Type: updateType, TreeID: event.treeID, Event: notice, At: database.Now()}, userIDs)
}

func eventMessageKey(eventID string) string {
	return "event:" + eventID
}

// eventMessagePayload is the system message Raven sends an invitee. It carries the names
// at send time so the card needs nothing else to show.
func (s *Server) eventMessagePayload(event TreeEvent, updated, cancelled bool) map[string]any {
	target := map[string]any{"name": event.RoomName}
	if event.NestID != nil {
		target["kind"], target["id"] = "voice", *event.NestID
	} else if event.ConversationID != nil {
		target["kind"], target["id"] = "text", *event.ConversationID
	}
	payload := map[string]any{
		"type":       "event",
		"eventId":    event.ID,
		"treeId":     event.treeID,
		"space":      s.treeNameOf(event.treeID),
		"title":      event.Title,
		"host":       event.HostName,
		"hostUserId": event.HostUserID,
		"startsAt":   event.Occurrence.StartsAt,
		"endsAt":     event.Occurrence.EndsAt,
		"target":     target,
		"updated":    updated,
		"cancelled":  cancelled,
	}
	if event.RRule != nil {
		payload["rrule"] = *event.RRule
	}
	return payload
}

// eventMessageRecipients lists the people who have Raven's message about an event.
func (s *Server) eventMessageRecipients(eventID string) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT c.creator_user_id FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id
		 WHERE m.replace_key = ? AND c.kind = 'raven' AND m.deleted_at IS NULL`,
		eventMessageKey(eventID),
	)
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

// sendEventMessages writes or rewrites Raven's message to each person. edited marks it
// "Updated" for people who already had one.
func (s *Server) sendEventMessages(event TreeEvent, userIDs []string, edited bool) {
	had := map[string]bool{}
	if edited {
		messaged, err := s.eventMessageRecipients(event.ID)
		if err != nil {
			log.Printf("board events: message recipients of %s: %v", event.ID, err)
		}
		for _, id := range messaged {
			had[id] = true
		}
	}
	for _, id := range userIDs {
		if _, err := s.sendRavenMessage(id, s.eventMessagePayload(event, had[id], false), eventMessageKey(event.ID)); err != nil {
			log.Printf("board events: message %s about %s: %v", id, event.ID, err)
		}
	}
}

// cancelEventMessages turns each person's message about an event into its cancelled form.
func (s *Server) cancelEventMessages(event TreeEvent, userIDs []string) {
	for _, id := range userIDs {
		if _, err := s.sendRavenMessage(id, s.eventMessagePayload(event, true, true), eventMessageKey(event.ID)); err != nil {
			log.Printf("board events: cancel message %s about %s: %v", id, event.ID, err)
		}
	}
}

// ---- Maintenance ----

// runTreeEvents keeps events in step with time: it drops invitees who left their space,
// deletes events whose room is gone (cancelling them) or whose last occurrence is over,
// reminds invitees ten minutes before each occurrence and tells the space when one starts.
func (s *Server) runTreeEvents(now time.Time) error {
	if _, err := s.db.Exec(
		`DELETE FROM tree_event_invitees WHERE NOT EXISTS (
			SELECT 1 FROM tree_events e JOIN tree_members tm ON tm.tree_id = e.tree_id
			WHERE e.id = tree_event_invitees.event_id AND tm.user_id = tree_event_invitees.user_id AND tm.state = 'joined')`,
	); err != nil {
		return err
	}
	rows, err := s.db.Query(`SELECT ` + treeEventColumns + `, CASE WHEN ` + treeEventTargetLive + ` THEN 1 ELSE 0 END ` + treeEventJoins)
	if err != nil {
		return err
	}
	type pending struct {
		event TreeEvent
		live  bool
		bad   bool
	}
	all := []pending{}
	for rows.Next() {
		var item pending
		var live int
		var nest, conversation, ends, rrule sql.NullString
		var duration sql.NullInt64
		event := &item.event
		if err := rows.Scan(&event.ID, &event.treeID, &event.Title, &event.Description, &event.HostUserID, &nest, &conversation,
			&event.RoomName, &event.StartsAt, &ends, &duration, &rrule, &event.TZ, &event.InviteAll,
			&event.SendInviteMessage, &event.Pinned, &event.createdAt, &live); err != nil {
			rows.Close()
			return err
		}
		finished, err := finishTreeEvent(*event, nest, conversation, ends, rrule, duration)
		item.event, item.live, item.bad = finished, live == 1, err != nil
		all = append(all, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, item := range all {
		event := item.event
		if !item.live {
			event.at(now)
			event.HostName = s.spaceNameOf(event.treeID, User{ID: event.HostUserID, DisplayName: s.globalNameOf(event.HostUserID)})
			if err := s.removeTreeEvent(event, true); err != nil {
				log.Printf("board events: remove %s with its room gone: %v", event.ID, err)
			}
			continue
		}
		if item.bad || !event.at(now) {
			if err := s.removeTreeEvent(event, false); err != nil {
				log.Printf("board events: remove finished %s: %v", event.ID, err)
			}
			continue
		}
		// A series that moved on to its next occurrence changes what the lobby shows.
		if event.hasPrev && now.Sub(event.prev.End) < 24*time.Hour {
			if first, err := s.markEventSent(event.ID, event.prev.Start, "ended"); err != nil {
				log.Printf("board events: mark ended %s: %v", event.ID, err)
			} else if first {
				s.publishTree(event.treeID, "tree.updated")
			}
		}
		start := event.next.Start
		created, _ := time.Parse(time.RFC3339, event.createdAt)
		if !now.Before(start.Add(-treeEventReminder)) && now.Before(start) && created.Before(start.Add(-treeEventReminder)) {
			if first, err := s.markEventSent(event.ID, start, "reminder"); err != nil {
				log.Printf("board events: mark reminder %s: %v", event.ID, err)
			} else if first {
				event.HostName = s.spaceNameOf(event.treeID, User{ID: event.HostUserID, DisplayName: s.globalNameOf(event.HostUserID)})
				invitees, err := s.treeEventInvitees(event)
				if err != nil {
					log.Printf("board events: invitees of %s: %v", event.ID, err)
				}
				s.publishEventNotice("event.reminder", event, invitees)
			}
		}
		if !now.Before(start) {
			if first, err := s.markEventSent(event.ID, start, "starting"); err != nil {
				log.Printf("board events: mark starting %s: %v", event.ID, err)
			} else if first {
				s.publishTree(event.treeID, "event.starting")
			}
		}
	}
	_, err = s.db.Exec(`DELETE FROM tree_event_reminders_sent WHERE occurrence_start < ?`, now.Add(-48*time.Hour).UTC().Format(boardTimeLayout))
	return err
}

// markEventSent records that a notice went out for an occurrence and reports whether this
// was the first time.
func (s *Server) markEventSent(eventID string, occurrence time.Time, kind string) (bool, error) {
	result, err := s.db.Exec(
		`INSERT INTO tree_event_reminders_sent (event_id, occurrence_start, kind) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
		eventID, occurrence.UTC().Format(boardTimeLayout), kind,
	)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n > 0, err
}
