package relay

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"time"

	"github.com/quic-go/quic-go"
)

const (
	// DatagramHint is the UDP payload size every path carries (QUIC guarantees 1200-byte
	// packets), which clients use to drop what would not fit.
	DatagramHint = 1000

	helloTimeout = 10 * time.Second
	keepAlive    = 15 * time.Second
	idleTimeout  = 30 * time.Second
	// The application error code for closing a connection; the reason says why.
	codeEnded quic.ApplicationErrorCode = 2
)

// QUICConfig is the transport configuration both ends use.
func QUICConfig() *quic.Config {
	return &quic.Config{
		EnableDatagrams: true,
		KeepAlivePeriod: keepAlive,
		MaxIdleTimeout:  idleTimeout,
	}
}

// Listen starts accepting connections on a UDP address such as ":7443". The certificate
// must be publicly trusted, because clients verify it against the usual roots.
func (s *Server) Listen(addr, certFile, keyFile string) error {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return fmt.Errorf("relay certificate: %w", err)
	}
	return s.ListenTLS(addr, &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		NextProtos:   []string{ALPN},
	})
}

// ListenTLS is Listen with a ready TLS configuration. Tests use it.
func (s *Server) ListenTLS(addr string, conf *tls.Config) error {
	ln, err := quic.ListenAddr(addr, conf, QUICConfig())
	if err != nil {
		return err
	}
	s.ln = ln
	go s.acceptLoop()
	return nil
}

// Addr is the address the listener is bound to.
func (s *Server) Addr() string { return s.ln.Addr().String() }

// Close stops accepting connections and drops the ones open.
func (s *Server) Close() {
	if s.ln != nil {
		_ = s.ln.Close()
	}
}

func (s *Server) acceptLoop() {
	for {
		conn, err := s.ln.Accept(context.Background())
		if err != nil {
			return
		}
		go s.ServeFrom(&quicConn{conn}, remoteHost(conn.RemoteAddr()))
	}
}

// remoteHost is the address part of a peer address, so all of one machine's ports count
// together.
func remoteHost(addr net.Addr) string {
	if addr == nil {
		return ""
	}
	if host, _, err := net.SplitHostPort(addr.String()); err == nil {
		return host
	}
	return addr.String()
}

// quicStream adapts a QUIC stream to Stream.
type quicStream struct{ s *quic.Stream }

func (q quicStream) Read(p []byte) (int, error)  { return q.s.Read(p) }
func (q quicStream) Write(p []byte) (int, error) { return q.s.Write(p) }
func (q quicStream) CloseWrite() error           { return q.s.Close() }
func (q quicStream) Close() error {
	q.s.CancelRead(0)
	return q.s.Close()
}
func (q quicStream) Abort() {
	q.s.CancelRead(1)
	q.s.CancelWrite(1)
}

// quicConn adapts a QUIC connection to Conn.
type quicConn struct{ c *quic.Conn }

func (q *quicConn) AcceptStream(ctx context.Context) (Stream, error) {
	s, err := q.c.AcceptStream(ctx)
	if err != nil {
		return nil, err
	}
	return quicStream{s}, nil
}

func (q *quicConn) OpenStream(ctx context.Context) (Stream, error) {
	s, err := q.c.OpenStreamSync(ctx)
	if err != nil {
		return nil, err
	}
	return quicStream{s}, nil
}

func (q *quicConn) SendDatagram(b []byte) error { return q.c.SendDatagram(b) }

func (q *quicConn) ReceiveDatagram(ctx context.Context) ([]byte, error) {
	return q.c.ReceiveDatagram(ctx)
}

func (q *quicConn) Context() context.Context { return q.c.Context() }

func (q *quicConn) Close(reason string) { _ = q.c.CloseWithError(codeEnded, reason) }
