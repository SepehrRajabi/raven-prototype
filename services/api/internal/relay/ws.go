package relay

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/hashicorp/yamux"
)

// The WebSocket route carries the same relay protocol as QUIC, for networks and CDNs
// that pass only HTTPS on 443. One WebSocket (binary messages) carries a yamux session:
//
//   - The client opens the control stream first, exactly as over QUIC.
//   - Right after AttachOK the client opens a second stream and writes DatagramTag.
//     That stream carries datagrams both ways as [u16 length][payload].
//   - Every later stream is a flow, as over QUIC.
//
// Datagrams over this route are reliable and ordered, so UDP gains delay under loss
// instead of dropping. A datagram the send queue can't hold is dropped and counted.

// DatagramTag is the first byte of the datagram stream.
const DatagramTag = 0xD6

const (
	wsBinaryMessage = 2
	wsCloseMessage  = 8
	// wsKeepAlive stays under the idle timeouts of common CDNs and proxies.
	wsKeepAlive      = 20 * time.Second
	wsDatagramQueue  = 256
	wsCloseReasonMax = 123
	wsCloseGrace     = time.Second
)

// WebSocket is what the relay needs from an accepted WebSocket. Both the Fiber and the
// gorilla connection types provide it.
type WebSocket interface {
	NextReader() (messageType int, r io.Reader, err error)
	WriteMessage(messageType int, data []byte) error
	WriteControl(messageType int, data []byte, deadline time.Time) error
	SetReadDeadline(t time.Time) error
	SetWriteDeadline(t time.Time) error
	Close() error
}

var errDatagramQueueFull = errors.New("datagram queue full")

// ServeWebSocket runs one client connection that arrived over WebSocket, until it ends.
func (s *Server) ServeWebSocket(ws WebSocket) {
	s.ServeWebSocketAdmitted(ws, func() {})
}

// AdmitPending reserves a place for a connection from source that has not signed in
// yet, for a transport that has to decide before the connection exists (the WebSocket
// route answers the upgrade request). The reservation is released by calling release,
// which ServeWebSocketAdmitted does once the client signs in or goes; if the connection
// never gets that far, it lapses by itself shortly after the hello timeout.
func (s *Server) AdmitPending(source string) (release func(), ok bool) {
	release, ok = s.admitPending(source)
	if !ok {
		return nil, false
	}
	time.AfterFunc(helloTimeout+5*time.Second, release)
	return release, true
}

// ServeWebSocketAdmitted is ServeWebSocket for a connection AdmitPending let in.
func (s *Server) ServeWebSocketAdmitted(ws WebSocket, release func()) {
	defer release()
	conn, err := newWSConn(ws)
	if err != nil {
		_ = ws.Close()
		return
	}
	s.serve(conn, release)
	conn.Close("")
	// Returning closes the socket, so wait out the close handshake here, not in Close.
	<-conn.closed
}

// YamuxConfig is the session configuration both ends of the WebSocket route use.
func YamuxConfig() *yamux.Config {
	conf := yamux.DefaultConfig()
	conf.KeepAliveInterval = wsKeepAlive
	conf.LogOutput = io.Discard
	return conf
}

type wsConn struct {
	ws     WebSocket
	sess   *yamux.Session
	ctx    context.Context
	cancel context.CancelFunc
	// closed is closed once Close has finished the close handshake.
	closed  chan struct{}
	streams chan Stream
	dgIn    chan []byte
	dgOut   chan []byte
	once    sync.Once
}

func newWSConn(ws WebSocket) (*wsConn, error) {
	sess, err := yamux.Server(&wsBytes{ws: ws}, YamuxConfig())
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &wsConn{
		ws:      ws,
		sess:    sess,
		ctx:     ctx,
		cancel:  cancel,
		closed:  make(chan struct{}),
		streams: make(chan Stream),
		dgIn:    make(chan []byte, wsDatagramQueue),
		dgOut:   make(chan []byte, wsDatagramQueue),
	}
	go func() {
		<-sess.CloseChan()
		cancel()
	}()
	go c.acceptLoop()
	return c, nil
}

func (c *wsConn) acceptLoop() {
	for n := 0; ; n++ {
		st, err := c.sess.AcceptStreamWithContext(c.ctx)
		if err != nil {
			return
		}
		if n == 1 {
			// The second stream is the datagram stream.
			if !c.startDatagrams(st) {
				c.Close("bad_datagram_stream")
				return
			}
			continue
		}
		select {
		case c.streams <- yamuxStream{st}:
		case <-c.ctx.Done():
			st.Close()
			return
		}
	}
}

func (c *wsConn) startDatagrams(st *yamux.Stream) bool {
	_ = st.SetReadDeadline(time.Now().Add(helloTimeout))
	var tag [1]byte
	if _, err := io.ReadFull(st, tag[:]); err != nil || tag[0] != DatagramTag {
		return false
	}
	_ = st.SetReadDeadline(time.Time{})
	go func() {
		var size [2]byte
		for {
			if _, err := io.ReadFull(st, size[:]); err != nil {
				return
			}
			buf := make([]byte, binary.BigEndian.Uint16(size[:]))
			if _, err := io.ReadFull(st, buf); err != nil {
				return
			}
			select {
			case c.dgIn <- buf:
			default:
				// Nobody is reading fast enough; drop, as a UDP path would.
			}
		}
	}()
	go func() {
		for {
			select {
			case data := <-c.dgOut:
				if _, err := st.Write(data); err != nil {
					return
				}
			case <-c.ctx.Done():
				return
			}
		}
	}()
	return true
}

func (c *wsConn) AcceptStream(ctx context.Context) (Stream, error) {
	select {
	case st := <-c.streams:
		return st, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.ctx.Done():
		return nil, io.EOF
	}
}

func (c *wsConn) OpenStream(ctx context.Context) (Stream, error) {
	type result struct {
		st  *yamux.Stream
		err error
	}
	done := make(chan result, 1)
	go func() {
		st, err := c.sess.OpenStream()
		done <- result{st, err}
	}()
	select {
	case r := <-done:
		if r.err != nil {
			return nil, r.err
		}
		return yamuxStream{r.st}, nil
	case <-ctx.Done():
		go func() {
			if r := <-done; r.st != nil {
				r.st.Close()
			}
		}()
		return nil, ctx.Err()
	}
}

func (c *wsConn) SendDatagram(data []byte) error {
	if len(data) > 0xFFFF {
		return errors.New("datagram too large")
	}
	framed := make([]byte, 2+len(data))
	binary.BigEndian.PutUint16(framed, uint16(len(data)))
	copy(framed[2:], data)
	select {
	case c.dgOut <- framed:
		return nil
	case <-c.ctx.Done():
		return io.EOF
	default:
		return errDatagramQueueFull
	}
}

func (c *wsConn) ReceiveDatagram(ctx context.Context) ([]byte, error) {
	select {
	case data := <-c.dgIn:
		return data, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.ctx.Done():
		return nil, io.EOF
	}
}

func (c *wsConn) Context() context.Context { return c.ctx }

// Close sends the reason in the WebSocket close frame, which the client reports, then
// drops the session.
func (c *wsConn) Close(reason string) {
	c.once.Do(func() {
		if len(reason) > wsCloseReasonMax {
			reason = reason[:wsCloseReasonMax]
		}
		msg := make([]byte, 2+len(reason))
		binary.BigEndian.PutUint16(msg, 1000)
		copy(msg[2:], reason)
		_ = c.ws.WriteControl(wsCloseMessage, msg, time.Now().Add(time.Second))
		// Wait for the client's close reply, which ends the session's read loop. Cutting the
		// connection first can drop the close frame before the client reads it (Windows
		// discards unread data on a reset), and the reason with it. The wait runs on its
		// own so that whoever closes (ending a share closes many) is not held up by it.
		go func() {
			select {
			case <-c.sess.CloseChan():
			case <-time.After(wsCloseGrace):
			}
			_ = c.sess.Close()
			c.cancel()
			close(c.closed)
		}()
	})
}

// yamuxStream adapts a yamux stream to Stream. yamux has no reset, so Abort closes the
// stream and unblocks any reader at once.
type yamuxStream struct{ s *yamux.Stream }

func (y yamuxStream) Read(p []byte) (int, error)  { return y.s.Read(p) }
func (y yamuxStream) Write(p []byte) (int, error) { return y.s.Write(p) }
func (y yamuxStream) CloseWrite() error           { return y.s.Close() }
func (y yamuxStream) Close() error {
	err := y.s.Close()
	_ = y.s.SetReadDeadline(time.Now())
	return err
}
func (y yamuxStream) Abort() {
	_ = y.s.SetDeadline(time.Now())
	// Close waits until its FIN is written, up to yamux's write timeout, so it must not
	// hold up whoever is ending the share.
	go y.s.Close()
}

// wsBytes turns a WebSocket's binary messages into the byte stream yamux runs on.
type wsBytes struct {
	ws WebSocket
	r  io.Reader
	mu sync.Mutex
}

func (w *wsBytes) Read(p []byte) (int, error) {
	for {
		if w.r == nil {
			kind, r, err := w.ws.NextReader()
			if err != nil {
				return 0, err
			}
			if kind != wsBinaryMessage {
				continue
			}
			w.r = r
		}
		n, err := w.r.Read(p)
		if errors.Is(err, io.EOF) {
			w.r = nil
			if n > 0 {
				return n, nil
			}
			continue
		}
		return n, err
	}
}

func (w *wsBytes) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.ws.WriteMessage(wsBinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Close unblocks any read or write in progress before closing. Fiber's WebSocket sits on
// a hijacked connection whose Close does nothing until the handler returns, so without the
// deadlines yamux's Close would wait forever for its read loop.
func (w *wsBytes) Close() error {
	now := time.Now()
	_ = w.ws.SetReadDeadline(now)
	_ = w.ws.SetWriteDeadline(now)
	return w.ws.Close()
}
