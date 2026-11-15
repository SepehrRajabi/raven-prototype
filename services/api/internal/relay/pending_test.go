package relay

import "testing"

// Connections that have not signed in are capped per address and in total, and a
// released place can be taken again.
func TestConnectionsWaitingToSignInAreCapped(t *testing.T) {
	s := NewServer(NewRegistry(DefaultLimits()), testPolicy{})
	s.SetPendingLimits(3, 2)
	var releases []func()
	for i := 0; i < 2; i++ {
		release, ok := s.admitPending("198.51.100.1")
		if !ok {
			t.Fatalf("connection %d from one address refused under the cap", i)
		}
		releases = append(releases, release)
	}
	if _, ok := s.admitPending("198.51.100.1"); ok {
		t.Fatal("a third connection from one address was let in past the per-address cap")
	}
	release, ok := s.admitPending("198.51.100.2")
	if !ok {
		t.Fatal("another address was refused under the total cap")
	}
	if _, ok := s.admitPending("198.51.100.3"); ok {
		t.Fatal("a connection was let in past the total cap")
	}
	release()
	release() // releasing twice frees one place, not two
	releases[0]()
	if _, ok := s.admitPending("198.51.100.1"); !ok {
		t.Fatal("a released place could not be taken again")
	}
	if _, ok := s.admitPending("198.51.100.3"); !ok {
		t.Fatal("a released place could not be taken again")
	}
	if _, ok := s.admitPending("198.51.100.4"); ok {
		t.Fatal("releasing twice freed two places")
	}
}
