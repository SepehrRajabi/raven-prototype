package auth

import (
	"testing"

	livekitauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
)

func TestCallGrantsLimitOnlyAudio(t *testing.T) {
	free := VoiceLimits{}
	muted := VoiceLimits{Muted: true}
	deafened := VoiceLimits{Deafened: true}
	for _, kind := range []IdentityKind{IdentityViewer, IdentityAudio, IdentityVideo} {
		grants := CallGrantsFor(kind, free)
		if !grants.CanPublish || !grants.CanSubscribe || len(grants.PublishSources) != 0 {
			t.Fatalf("kind %d without limits should be unrestricted: %+v", kind, grants)
		}
	}
	audio := CallGrantsFor(IdentityAudio, muted)
	if audio.CanPublish || !audio.CanSubscribe {
		t.Fatalf("a muted person still hears, and sends no audio: %+v", audio)
	}
	audio = CallGrantsFor(IdentityAudio, deafened)
	if audio.CanPublish || audio.CanSubscribe {
		t.Fatalf("a deafened person neither hears nor is heard: %+v", audio)
	}
	for _, kind := range []IdentityKind{IdentityViewer, IdentityVideo} {
		for _, limits := range []VoiceLimits{muted, deafened} {
			grants := CallGrantsFor(kind, limits)
			if !grants.CanPublish || !grants.CanSubscribe {
				t.Fatalf("video must keep working for kind %d: %+v", kind, grants)
			}
			if len(grants.PublishSources) != 2 {
				t.Fatalf("kind %d must be narrowed to video sources: %+v", kind, grants)
			}
			for _, source := range grants.PublishSources {
				if source != livekit.TrackSource_CAMERA && source != livekit.TrackSource_SCREEN_SHARE {
					t.Fatalf("kind %d may still send %v", kind, source)
				}
			}
		}
	}
}

func TestCallGrantsListenOnlySendsNothing(t *testing.T) {
	for _, limits := range []VoiceLimits{{ListenOnly: true}, {ListenOnly: true, Muted: true}} {
		if !limits.Any() {
			t.Fatalf("%+v should count as a limit", limits)
		}
		for _, kind := range []IdentityKind{IdentityViewer, IdentityAudio, IdentityVideo} {
			grants := CallGrantsFor(kind, limits)
			if grants.CanPublish || !grants.CanSubscribe || len(grants.PublishSources) != 0 {
				t.Fatalf("kind %d under %+v should receive and send nothing: %+v", kind, limits, grants)
			}
		}
	}
	// Deafened as well, they still receive video and no sound.
	both := VoiceLimits{ListenOnly: true, Deafened: true}
	for kind, hears := range map[IdentityKind]bool{IdentityViewer: true, IdentityAudio: false, IdentityVideo: true} {
		grants := CallGrantsFor(kind, both)
		if grants.CanPublish || grants.CanSubscribe != hears {
			t.Fatalf("kind %d, deafened and listening only: %+v", kind, grants)
		}
	}
}

// A token carries the refusal itself, so it holds before anything is sent to LiveKit.
func TestListenOnlyTokenCannotPublish(t *testing.T) {
	for _, kind := range []IdentityKind{IdentityViewer, IdentityAudio, IdentityVideo} {
		signed, err := SignLiveKitToken(LiveKitTokenInput{
			APIKey: "key", APISecret: "a-secret-of-some-length-for-signing", Session: "room", Identity: "bob",
			Grants: CallGrantsFor(kind, VoiceLimits{ListenOnly: true}),
		})
		if err != nil {
			t.Fatal(err)
		}
		verifier, err := livekitauth.ParseAPIToken(signed)
		if err != nil {
			t.Fatal(err)
		}
		_, claims, err := verifier.Verify("a-secret-of-some-length-for-signing")
		if err != nil {
			t.Fatal(err)
		}
		for _, source := range []livekit.TrackSource{livekit.TrackSource_MICROPHONE, livekit.TrackSource_CAMERA, livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO} {
			if claims.Video.GetCanPublishSource(source) {
				t.Errorf("kind %d may publish %v", kind, source)
			}
		}
		if !claims.Video.GetCanSubscribe() {
			t.Errorf("kind %d may not listen", kind)
		}
	}
}

// LiveKit's update replaces the whole set, so losing these would break reconcile's metadata.
func TestPermissionKeepsDataAndMetadataRights(t *testing.T) {
	permission := CallGrantsFor(IdentityAudio, VoiceLimits{Deafened: true}).Permission()
	if !permission.CanPublishData || !permission.CanUpdateMetadata {
		t.Fatalf("data and metadata rights were dropped: %+v", permission)
	}
}
