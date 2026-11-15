package http

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"strings"
	"time"

	"raven/services/api/internal/auth"

	"github.com/gofiber/fiber/v2"
	"github.com/livekit/protocol/livekit"
)

// Keeping LiveKit in line with the database.
//
// Losing the right to be in a call removes the person's LiveKit participants at once
// (see kickFromCall), but that is a single request. A client that reconnects afterwards
// with a token it already held, or that the API never heard from again, would otherwise
// stay in the room. Two things close that gap: call tokens are short-lived (see
// liveKitTokenTTL), and this reconcile reads every Raven room from LiveKit now and then,
// removes whoever may no longer be there, and puts server mutes back on anyone whose
// permissions differ from them. It talks only to the server's own LiveKit, so it works
// the same in the self-host bundle.

const (
	// liveKitTokenTTL is how long a call token can be used to connect. LiveKit checks it
	// only when connecting, and refreshes the token of a connected client on its own, so
	// a short one does not drop anyone: the desktop fetches a fresh token for every join
	// and rejoin.
	liveKitTokenTTL = 5 * time.Minute
	// liveKitReconcileInterval is how often LiveKit's rooms are checked.
	liveKitReconcileInterval = 30 * time.Second
	// liveKitReconcileTimeout bounds one pass.
	liveKitReconcileTimeout = 20 * time.Second
)

// startLiveKitReconcile runs reconcileLiveKit every liveKitReconcileInterval until the
// process ends.
func (s *Server) startLiveKitReconcile() {
	go func() {
		ticker := time.NewTicker(liveKitReconcileInterval)
		defer ticker.Stop()
		failing := false
		for range ticker.C {
			ctx, cancel := context.WithTimeout(context.Background(), liveKitReconcileTimeout)
			err := s.reconcileLiveKit(ctx)
			cancel()
			// LiveKit being down is logged once, not every pass, until it comes back.
			if err != nil && !failing {
				log.Printf("livekit reconcile: %v", err)
			}
			failing = err != nil
		}
	}()
}

// reconcileLiveKit checks every Raven room LiveKit has open. A participant whose person
// may no longer be in that call is removed; one whose permissions do not match their
// server mute or deafen gets them again. A database error leaves the participant alone:
// it says nothing about whether they may stay.
func (s *Server) reconcileLiveKit(ctx context.Context) error {
	if s.listLiveKitRooms == nil || s.listLiveKitParticipants == nil {
		return nil
	}
	rooms, err := s.listLiveKitRooms(ctx)
	if err != nil {
		return err
	}
	for _, room := range rooms {
		nestID, ok := strings.CutPrefix(room, liveKitSessionName(""))
		if !ok || nestID == "" {
			continue
		}
		participants, err := s.listLiveKitParticipants(ctx, room)
		if err != nil {
			if liveKitNotFound(err) {
				continue
			}
			return err
		}
		s.reconcileLiveKitRoom(room, nestID, participants)
	}
	return nil
}

func (s *Server) reconcileLiveKitRoom(room, nestID string, participants []*livekit.ParticipantInfo) {
	nest, nestErr := s.findNest(nestID)
	if nestErr != nil && !errors.Is(nestErr, sql.ErrNoRows) {
		log.Printf("livekit reconcile: read nest: %v", nestErr)
		return
	}
	type verdict struct {
		allowed bool
		limits  auth.VoiceLimits
		known   bool
	}
	verdicts := map[string]verdict{}
	for _, participant := range participants {
		if participant == nil || participant.Kind != livekit.ParticipantInfo_STANDARD {
			// Egress, ingress and the like are the operator's own, never a Raven user.
			continue
		}
		userID, kind := splitParticipantIdentity(participant.Identity)
		v, seen := verdicts[userID]
		if !seen {
			v.allowed, v.limits, v.known = s.liveKitParticipantAllowed(nest, nestErr, userID)
			verdicts[userID] = v
		}
		if !v.known {
			continue
		}
		if !v.allowed {
			s.removeParticipant(room, participant.Identity)
			continue
		}
		want := auth.CallGrantsFor(kind, v.limits).Permission()
		if !samePermission(participant.Permission, want) {
			s.setParticipantPermission(room, participant.Identity, want)
		}
	}
}

// liveKitParticipantAllowed says whether userID may be in nest's call, and under which
// voice limits. known is false when the database could not say.
func (s *Server) liveKitParticipantAllowed(nest Nest, nestErr error, userID string) (allowed bool, limits auth.VoiceLimits, known bool) {
	if nestErr != nil {
		return false, limits, errors.Is(nestErr, sql.ErrNoRows)
	}
	user, err := s.findUserByID(userID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, limits, true
	}
	if err != nil {
		return false, limits, false
	}
	if user.Status != userStatusActive {
		return false, limits, true
	}
	if err := s.requireNestEntry(user, nest); err != nil {
		return false, limits, accessDenied(err)
	}
	limits, err = s.voiceLimitsOf(nest, user.ID)
	if err != nil {
		return false, limits, false
	}
	return true, limits, true
}

// accessDenied reports whether an error is an answer of "no" rather than a failure to
// find out.
func accessDenied(err error) bool {
	if errors.Is(err, sql.ErrNoRows) {
		return true
	}
	var reasoned *reasonedError
	if errors.As(err, &reasoned) {
		return reasoned.status < 500
	}
	var fe *fiber.Error
	return errors.As(err, &fe) && fe.Code < 500
}

// splitParticipantIdentity turns a LiveKit identity back into the user and which of
// their participants it is.
func splitParticipantIdentity(identity string) (string, auth.IdentityKind) {
	if userID, ok := strings.CutSuffix(identity, "#audio"); ok {
		return userID, auth.IdentityAudio
	}
	if userID, ok := strings.CutSuffix(identity, "#video"); ok {
		return userID, auth.IdentityVideo
	}
	return identity, auth.IdentityViewer
}

// samePermission compares the parts of a permission Raven sets.
func samePermission(have, want *livekit.ParticipantPermission) bool {
	if have == nil || want == nil {
		return have == want
	}
	if have.CanPublish != want.CanPublish || have.CanSubscribe != want.CanSubscribe {
		return false
	}
	if !have.CanPublish {
		// Sources mean nothing while publishing is off.
		return true
	}
	return sameSources(have.CanPublishSources, want.CanPublishSources)
}

func sameSources(a, b []livekit.TrackSource) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[livekit.TrackSource]int{}
	for _, source := range a {
		seen[source]++
	}
	for _, source := range b {
		if seen[source] == 0 {
			return false
		}
		seen[source]--
	}
	return true
}

func (s *Server) liveKitListRooms(ctx context.Context) ([]string, error) {
	response, err := s.liveKitRooms.ListRooms(ctx, &livekit.ListRoomsRequest{})
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(response.Rooms))
	for _, room := range response.Rooms {
		names = append(names, room.Name)
	}
	return names, nil
}

func (s *Server) liveKitListParticipants(ctx context.Context, room string) ([]*livekit.ParticipantInfo, error) {
	response, err := s.liveKitRooms.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if err != nil {
		return nil, err
	}
	return response.Participants, nil
}
