package relay

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"io"
	"math/big"
	"net"
	"testing"
	"time"

	"github.com/quic-go/quic-go"
)

type testPolicy struct{ deny map[string]bool }

func (p testPolicy) Authenticate(token string) (string, string, error) {
	if token == "bad" {
		return "", "", errors.New("Sign in again to use port sharing.")
	}
	return token, token, nil
}
func (p testPolicy) MayPublish(userID string, _ ShareInfo) error { return p.err(userID) }
func (p testPolicy) MayConsume(userID string, _ ShareInfo) error { return p.err(userID) }
func (p testPolicy) err(userID string) error {
	if p.deny[userID] {
		return errors.New("You can’t use ports in this place.")
	}
	return nil
}

func selfSigned(t *testing.T) *tls.Config {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return &tls.Config{
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
		MinVersion:   tls.VersionTLS13, NextProtos: []string{ALPN},
	}
}

type harness struct {
	t    *testing.T
	reg  *Registry
	srv  *Server
	addr string
}

func newHarness(t *testing.T, policy Policy) *harness {
	t.Helper()
	limits := DefaultLimits()
	limits.Enabled = true
	reg := NewRegistry(limits)
	srv := NewServer(reg, policy)
	if err := srv.ListenTLS("127.0.0.1:0", selfSigned(t)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(srv.Close)
	return &harness{t: t, reg: reg, srv: srv, addr: srv.Addr()}
}

// client is the part of a Raven client the relay talks to.
type client struct {
	conn *quic.Conn
	ctrl *quic.Stream
}

func (h *harness) dial(token string, role uint8, shareID string) (*client, error) {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := quic.DialAddr(ctx, h.addr, &tls.Config{InsecureSkipVerify: true, NextProtos: []string{ALPN}}, QUICConfig())
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { _ = conn.CloseWithError(0, "") })
	ctrl, err := conn.OpenStreamSync(ctx)
	if err != nil {
		h.t.Fatal(err)
	}
	if err := WriteFrame(ctrl, Frame{Type: FrameHello, Token: token, Role: role}); err != nil {
		return nil, err
	}
	if f, err := ReadFrame(ctrl); err != nil || f.Type != FrameHelloOK {
		return nil, wrapFrame(f, err)
	}
	if err := WriteFrame(ctrl, Frame{Type: FrameAttach, ShareID: shareID}); err != nil {
		return nil, err
	}
	if f, err := ReadFrame(ctrl); err != nil || f.Type != FrameAttachOK {
		return nil, wrapFrame(f, err)
	}
	return &client{conn: conn, ctrl: ctrl}, nil
}

func wrapFrame(f Frame, err error) error {
	if err != nil {
		return err
	}
	return errors.New(f.Message)
}

// servePublisher plays the sharing client: a local TCP target and a UDP echo.
func servePublisher(c *client, target string) {
	go func() {
		for {
			data, err := c.conn.ReceiveDatagram(context.Background())
			if err != nil {
				return
			}
			flow, payload, _ := DecodeDatagram(data)
			_ = c.conn.SendDatagram(EncodeDatagram(flow, append([]byte("echo:"), payload...)))
		}
	}()
	go func() {
		for {
			s, err := c.conn.AcceptStream(context.Background())
			if err != nil {
				return
			}
			go func() {
				in, err := ReadFrame(s)
				if err != nil || in.Type != FrameIncoming {
					return
				}
				if in.Kind == KindUDP {
					_ = WriteFrame(s, Frame{Type: FrameAccepted, DatagramMTU: DatagramHint})
					_, _ = io.Copy(io.Discard, s)
					return
				}
				local, err := net.Dial("tcp", target)
				if err != nil {
					_ = WriteFrame(s, Frame{Type: FrameRefused, Reason: "Nothing is listening on that port."})
					return
				}
				_ = WriteFrame(s, Frame{Type: FrameAccepted})
				go func() { _, _ = io.Copy(local, s); _ = local.Close() }()
				_, _ = io.Copy(s, local)
				_ = s.Close()
			}()
		}
	}()
}

func echoServer(t *testing.T) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(c, c); c.Close() }()
		}
	}()
	return ln.Addr().String()
}

func openTestFlow(t *testing.T, c *client, shareID string, kind uint8, flow uint32) (*quic.Stream, Frame) {
	t.Helper()
	s, err := c.conn.OpenStreamSync(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteFrame(s, Frame{Type: FrameOpen, ShareID: shareID, Kind: kind, FlowID: flow}); err != nil {
		t.Fatal(err)
	}
	_ = s.SetReadDeadline(time.Now().Add(5 * time.Second))
	answer, err := ReadFrame(s)
	if err != nil {
		t.Fatal(err)
	}
	return s, answer
}

func TestTCPAndUDPThroughTheRelay(t *testing.T) {
	h := newHarness(t, testPolicy{})
	share, err := h.reg.Create(Spec{PublisherID: "alice", PlaceKind: "nest", PlaceID: "n", Name: "x", Protocol: "both", Port: 1, Everyone: true}, 60)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := h.dial("alice", RolePublisher, share.ID)
	if err != nil {
		t.Fatal(err)
	}
	servePublisher(pub, echoServer(t))
	bob, err := h.dial("bob", RoleConsumer, share.ID)
	if err != nil {
		t.Fatal(err)
	}

	tcp, answer := openTestFlow(t, bob, share.ID, KindTCP, 0)
	if answer.Type != FrameAccepted {
		t.Fatalf("tcp flow refused: %+v", answer)
	}
	if _, err := tcp.Write([]byte("hello through the relay")); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len("hello through the relay"))
	if _, err := io.ReadFull(tcp, got); err != nil || string(got) != "hello through the relay" {
		t.Fatalf("tcp echo %q %v", got, err)
	}

	udp, answer := openTestFlow(t, bob, share.ID, KindUDP, 77)
	if answer.Type != FrameAccepted {
		t.Fatalf("udp flow refused: %+v", answer)
	}
	if err := bob.conn.SendDatagram(EncodeDatagram(77, []byte("ping"))); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	data, err := bob.conn.ReceiveDatagram(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if flow, payload, _ := DecodeDatagram(data); flow != 77 || string(payload) != "echo:ping" {
		t.Fatalf("udp echo flow=%d %q", flow, payload)
	}
	if h.reg.Get(share.ID).BytesUp.Load() == 0 {
		t.Fatal("traffic should be counted")
	}

	// Closing a UDP flow's stream frees its table entry.
	udp.CancelRead(0)
	_ = udp.Close()
	live := h.reg.Get(share.ID)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		h.reg.mu.Lock()
		left := len(live.udp)
		h.reg.mu.Unlock()
		if left == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("udp flow was not cleaned up")
}

func TestNothingListeningIsReportedToTheConsumer(t *testing.T) {
	h := newHarness(t, testPolicy{})
	share, _ := h.reg.Create(Spec{PublisherID: "alice", PlaceKind: "nest", PlaceID: "n", Name: "x", Protocol: "tcp", Port: 1, Everyone: true}, 60)
	pub, err := h.dial("alice", RolePublisher, share.ID)
	if err != nil {
		t.Fatal(err)
	}
	servePublisher(pub, "127.0.0.1:1")
	bob, err := h.dial("bob", RoleConsumer, share.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, answer := openTestFlow(t, bob, share.ID, KindTCP, 0)
	if answer.Type != FrameRefused || answer.Reason != "Nothing is listening on that port." {
		t.Fatalf("got %+v", answer)
	}
	_, answer = openTestFlow(t, bob, share.ID, KindUDP, 1)
	if answer.Type != FrameRefused {
		t.Fatalf("a tcp-only share carries no udp: %+v", answer)
	}
}

func TestTheRelayRefusesWhatThePolicyDenies(t *testing.T) {
	h := newHarness(t, testPolicy{deny: map[string]bool{"mallory": true}})
	share, _ := h.reg.Create(Spec{PublisherID: "alice", PlaceKind: "nest", PlaceID: "n", Name: "x", Protocol: "tcp", Port: 1, Audience: []string{"bob", "mallory"}}, 60)
	if _, err := h.dial("bad", RolePublisher, share.ID); err == nil {
		t.Fatal("a bad session token must not get in")
	}
	if _, err := h.dial("bob", RolePublisher, share.ID); err == nil {
		t.Fatal("only the publisher attaches")
	}
	if _, err := h.dial("bob", RoleConsumer, share.ID); err == nil {
		t.Fatal("nobody connects before the publisher does")
	}
	if _, err := h.dial("alice", RolePublisher, share.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.dial("mallory", RoleConsumer, share.ID); err == nil {
		t.Fatal("the policy said no")
	}
	if _, err := h.dial("erin", RoleConsumer, share.ID); err == nil {
		t.Fatal("erin is not in the audience")
	}
	if _, err := h.dial("bob", RoleConsumer, share.ID); err != nil {
		t.Fatalf("bob is: %v", err)
	}
}

func TestPublisherLeavingEndsTheShareAndClosesConsumers(t *testing.T) {
	h := newHarness(t, testPolicy{})
	share, _ := h.reg.Create(Spec{PublisherID: "alice", PlaceKind: "nest", PlaceID: "n", Name: "x", Protocol: "tcp", Port: 1, Everyone: true}, 60)
	pub, err := h.dial("alice", RolePublisher, share.ID)
	if err != nil {
		t.Fatal(err)
	}
	bob, err := h.dial("bob", RoleConsumer, share.ID)
	if err != nil {
		t.Fatal(err)
	}
	_ = pub.conn.CloseWithError(0, "app closed")
	select {
	case <-bob.conn.Context().Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the consumer should be disconnected")
	}
	if h.reg.Get(share.ID) != nil {
		t.Fatal("the share should have ended")
	}
}
