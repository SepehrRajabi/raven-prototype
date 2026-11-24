package auth

import (
	"encoding/json"
	"time"

	livekitauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
)

// IdentityKind says which of a person's up to three LiveKit participants a token or
// permission is for.
type IdentityKind int

const (
	IdentityViewer IdentityKind = iota
	IdentityAudio
	IdentityVideo
)

// VoiceLimits are server mute, server deafen, and listening only. A deafened person is also
// muted. Someone listening only may send nothing at all: no sound, camera or screen.
type VoiceLimits struct {
	Muted      bool
	Deafened   bool
	ListenOnly bool
}

// Any reports whether any limit is set.
func (l VoiceLimits) Any() bool {
	return l.Muted || l.Deafened || l.ListenOnly
}

// CallGrants is what one LiveKit participant may do. A token and a live permission change
// both come from here, so they cannot disagree.
type CallGrants struct {
	CanPublish bool
	// PublishSources narrows CanPublish to these sources. Empty means every source.
	PublishSources []livekit.TrackSource
	CanSubscribe   bool
}

// CallGrantsFor works out the grants of one identity under some limits.
//
// All of a person's audio goes through their audio identity, so taking its publishing away
// silences the microphone and every extra source and leaves video alone. The other two lose
// audio sources as well, because peers accept a Raven audio track from any identity with
// the person's base id, and a modified client could otherwise send its microphone there.
// Deafen stops only the audio identity receiving: the viewer still needs it for video.
func CallGrantsFor(kind IdentityKind, limits VoiceLimits) CallGrants {
	grants := CallGrants{CanPublish: true, CanSubscribe: true}
	if !limits.Any() {
		return grants
	}
	if kind == IdentityAudio {
		grants.CanPublish = false
		grants.CanSubscribe = !limits.Deafened
		return grants
	}
	if limits.ListenOnly {
		grants.CanPublish = false
		return grants
	}
	grants.PublishSources = []livekit.TrackSource{livekit.TrackSource_CAMERA, livekit.TrackSource_SCREEN_SHARE}
	return grants
}

// Permission is the same grants as LiveKit's live update takes. That update replaces the
// whole set, so it carries the data and metadata rights every Raven token has too.
func (g CallGrants) Permission() *livekit.ParticipantPermission {
	return &livekit.ParticipantPermission{
		CanPublish:        g.CanPublish,
		CanPublishSources: g.PublishSources,
		CanSubscribe:      g.CanSubscribe,
		CanPublishData:    true,
		CanUpdateMetadata: true,
	}
}

// DefaultLiveKitTokenTTL is how long a call token can be used to connect when the caller
// does not say.
const DefaultLiveKitTokenTTL = 5 * time.Minute

type LiveKitTokenInput struct {
	APIKey    string
	APISecret string
	Session   string
	Identity  string
	Name      string
	Role      string
	Grants    CallGrants
	ValidFor  time.Duration
}

func SignLiveKitToken(input LiveKitTokenInput) (string, error) {
	// A token is checked only when someone connects with it, and removing someone from
	// a call cannot take back a token they already hold, so it stays short. LiveKit
	// refreshes the token of a connected client by itself.
	if input.ValidFor <= 0 {
		input.ValidFor = DefaultLiveKitTokenTTL
	}

	canPublish := input.Grants.CanPublish
	canSubscribe := input.Grants.CanSubscribe
	canPublishData := true
	canUpdateOwnMetadata := true
	metadata, err := json.Marshal(map[string]string{
		"app":  "Raven",
		"role": input.Role,
	})
	if err != nil {
		return "", err
	}

	grant := &livekitauth.VideoGrant{
		RoomJoin:             true,
		Room:                 input.Session,
		CanPublish:           &canPublish,
		CanSubscribe:         &canSubscribe,
		CanPublishData:       &canPublishData,
		CanUpdateOwnMetadata: &canUpdateOwnMetadata,
	}
	if len(input.Grants.PublishSources) > 0 {
		grant.SetCanPublishSources(input.Grants.PublishSources)
	}

	token := livekitauth.NewAccessToken(input.APIKey, input.APISecret)
	token.AddGrant(grant).
		SetIdentity(input.Identity).
		SetName(input.Name).
		SetMetadata(string(metadata)).
		SetValidFor(input.ValidFor)

	return token.ToJWT()
}
