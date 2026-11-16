//! The relay's WebSocket route (plan 02): one WebSocket over TLS, usually on 443, carrying
//! a yamux session. It is the fallback for networks and CDNs that pass no UDP.
//!
//! The control stream is opened first, as over QUIC. Right after `AttachOk` a second
//! stream is opened and starts with [`DATAGRAM_TAG`]; it carries datagrams both ways as
//! `[u16 length][payload]`. Every later stream is a flow.

use std::{
    future::Future as _,
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{ready, Context, Poll},
    time::Duration,
};

use futures_util::{
    future::poll_fn,
    io::{AsyncRead as FAsyncRead, AsyncWrite as FAsyncWrite},
    Sink, Stream as _,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf},
    net::TcpStream,
    sync::{mpsc, oneshot, watch},
};
use tokio_tungstenite::{
    tungstenite::{self, Message},
    Connector, MaybeTlsStream, WebSocketStream,
};
use tokio_util::compat::{Compat, FuturesAsyncReadCompatExt};

use super::link::DatagramError;

/// The first byte of the datagram stream.
pub const DATAGRAM_TAG: u8 = 0xD6;
const DATAGRAM_QUEUE: usize = 256;
/// A WebSocket ping this often, like QUIC's keep-alive on the other route.
const PING_INTERVAL: Duration = Duration::from_secs(15);
/// With nothing at all from the relay for this long (no data, no pong), the session is
/// treated as lost, as QUIC's idle timeout does. Covers a half-open TCP connection.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

pub type WssStream = Compat<yamux::Stream>;
pub type WssTx = WriteHalf<WssStream>;
pub type WssRx = ReadHalf<WssStream>;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// How the session ended. `None` while it is open.
type Ended = watch::Receiver<Option<String>>;

pub struct WssSession {
    open: mpsc::Sender<oneshot::Sender<io::Result<yamux::Stream>>>,
    inbound: tokio::sync::Mutex<mpsc::UnboundedReceiver<yamux::Stream>>,
    ended: Ended,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    dg_out: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    dg_in: tokio::sync::Mutex<Option<mpsc::Receiver<Vec<u8>>>>,
}

fn io_err(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::Other, error.to_string())
}

/// Opens the WebSocket at `url` (`wss://…`) and starts the yamux session on it.
pub async fn open(url: &str, tls: Arc<rustls::ClientConfig>) -> io::Result<WssSession> {
    let (ws, _) = tokio_tungstenite::connect_async_tls_with_config(url, None, true, Some(Connector::Rustls(tls)))
        .await
        .map_err(io_err)?;
    let reason = Arc::new(Mutex::new(None::<String>));
    let io = WsIo::new(ws, reason.clone());
    let conn = yamux::Connection::new(io, yamux::Config::default(), yamux::Mode::Client);
    let (open_tx, open_rx) = mpsc::channel(8);
    // Unbounded: the relay caps how many flows it opens, and dropping one here would
    // refuse a consumer's connection for no reason.
    let (in_tx, in_rx) = mpsc::unbounded_channel();
    let (ended_tx, ended_rx) = watch::channel(None);
    let (stop_tx, stop_rx) = oneshot::channel();
    tokio::spawn(async move {
        let result = drive(conn, open_rx, in_tx, stop_rx).await;
        let given = reason.lock().unwrap().take();
        let why = match (given, result) {
            (Some(reason), _) if !reason.is_empty() => reason,
            (_, Ok(Stopped::ByUs)) => "stopped".to_string(),
            (_, Ok(Stopped::ByRelay)) => "connection_lost: the relay closed the connection".to_string(),
            (_, Err(error)) => format!("connection_lost: {error}"),
        };
        let _ = ended_tx.send(Some(why));
    });
    Ok(WssSession {
        open: open_tx,
        inbound: tokio::sync::Mutex::new(in_rx),
        ended: ended_rx,
        stop: Mutex::new(Some(stop_tx)),
        dg_out: Mutex::new(None),
        dg_in: tokio::sync::Mutex::new(None),
    })
}

enum Stopped {
    ByUs,
    ByRelay,
}

/// Runs the yamux connection: opens streams on request, hands inbound streams over, and
/// closes on request. yamux makes progress only while it is polled, so this always runs.
async fn drive(
    mut conn: yamux::Connection<WsIo>,
    mut opens: mpsc::Receiver<oneshot::Sender<io::Result<yamux::Stream>>>,
    inbound: mpsc::UnboundedSender<yamux::Stream>,
    mut stop: oneshot::Receiver<()>,
) -> Result<Stopped, yamux::ConnectionError> {
    let mut pending: Option<oneshot::Sender<io::Result<yamux::Stream>>> = None;
    let stopped = poll_fn(|cx| loop {
        if Pin::new(&mut stop).poll(cx).is_ready() {
            return Poll::Ready(Ok(true));
        }
        if pending.is_none() {
            if let Poll::Ready(Some(reply)) = opens.poll_recv(cx) {
                pending = Some(reply);
            }
        }
        if let Some(reply) = pending.take() {
            match conn.poll_new_outbound(cx) {
                Poll::Ready(result) => {
                    let _ = reply.send(result.map_err(io_err));
                    continue;
                }
                Poll::Pending => pending = Some(reply),
            }
        }
        match conn.poll_next_inbound(cx) {
            Poll::Ready(Some(Ok(stream))) => {
                // Fails only once the session is gone, and then the stream goes with it.
                let _ = inbound.send(stream);
            }
            Poll::Ready(Some(Err(error))) => return Poll::Ready(Err(error)),
            Poll::Ready(None) => return Poll::Ready(Ok(false)),
            Poll::Pending => return Poll::Pending,
        }
    })
    .await?;
    if stopped {
        let _ = poll_fn(|cx| conn.poll_close(cx)).await;
        Ok(Stopped::ByUs)
    } else {
        Ok(Stopped::ByRelay)
    }
}


impl WssSession {
    pub async fn open_stream(&self) -> io::Result<(WssTx, WssRx)> {
        let (tx, rx) = oneshot::channel();
        self.open.send(tx).await.map_err(|_| io_err("the relay connection is closed"))?;
        let stream = rx.await.map_err(|_| io_err("the relay connection is closed"))??;
        let (rx, tx) = tokio::io::split(stream.compat());
        Ok((tx, rx))
    }

    pub async fn accept_stream(&self) -> io::Result<(WssTx, WssRx)> {
        let stream = self.inbound.lock().await.recv().await.ok_or_else(|| io_err("the relay connection is closed"))?;
        let (rx, tx) = tokio::io::split(stream.compat());
        Ok((tx, rx))
    }

    /// Opens the datagram stream. Called once, right after `AttachOk`.
    pub async fn start_datagrams(&self) -> io::Result<()> {
        let (mut tx, mut rx) = self.open_stream().await?;
        tx.write_all(&[DATAGRAM_TAG]).await?;
        tx.flush().await?;
        let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(DATAGRAM_QUEUE);
        let (in_tx, in_rx) = mpsc::channel::<Vec<u8>>(DATAGRAM_QUEUE);
        tokio::spawn(async move {
            while let Some(data) = out_rx.recv().await {
                if tx.write_all(&data).await.is_err() || tx.flush().await.is_err() {
                    return;
                }
            }
        });
        tokio::spawn(async move {
            let mut size = [0u8; 2];
            loop {
                if rx.read_exact(&mut size).await.is_err() {
                    return;
                }
                let mut buf = vec![0u8; u16::from_be_bytes(size) as usize];
                if rx.read_exact(&mut buf).await.is_err() {
                    return;
                }
                // Nobody reading fast enough: drop it, as a UDP path would.
                let _ = in_tx.try_send(buf);
            }
        });
        *self.dg_out.lock().unwrap() = Some(out_tx);
        *self.dg_in.lock().await = Some(in_rx);
        Ok(())
    }

    pub fn send_datagram(&self, data: Vec<u8>) -> Result<(), DatagramError> {
        if data.len() > u16::MAX as usize {
            return Err(DatagramError::TooLarge);
        }
        let guard = self.dg_out.lock().unwrap();
        let Some(out) = guard.as_ref() else { return Err(DatagramError::Closed) };
        let mut framed = Vec::with_capacity(2 + data.len());
        framed.extend_from_slice(&(data.len() as u16).to_be_bytes());
        framed.extend_from_slice(&data);
        match out.try_send(framed) {
            Ok(()) => Ok(()),
            // A full queue drops the datagram and counts it, as a too-large one does.
            Err(mpsc::error::TrySendError::Full(_)) => Err(DatagramError::TooLarge),
            Err(mpsc::error::TrySendError::Closed(_)) => Err(DatagramError::Closed),
        }
    }

    pub async fn recv_datagram(&self) -> io::Result<Vec<u8>> {
        let mut guard = self.dg_in.lock().await;
        let Some(rx) = guard.as_mut() else { return Err(io_err("no datagram stream")) };
        rx.recv().await.ok_or_else(|| io_err("the relay connection is closed"))
    }

    pub async fn closed(&self) -> String {
        let mut ended = self.ended.clone();
        let reason = match ended.wait_for(|e| e.is_some()).await {
            Ok(reason) => reason.clone(),
            Err(_) => None,
        };
        reason.unwrap_or_else(|| "connection_lost".to_string())
    }

    pub fn close(&self) {
        if let Some(stop) = self.stop.lock().unwrap().take() {
            let _ = stop.send(());
        }
    }
}

/// The byte stream yamux runs on: binary WebSocket messages in, one message per write
/// out. The reason in the relay's close frame is kept for [`WssSession::closed`].
struct WsIo {
    ws: Ws,
    pending: Vec<u8>,
    pos: usize,
    reason: Arc<Mutex<Option<String>>>,
    ping: tokio::time::Interval,
    last_heard: tokio::time::Instant,
}

impl WsIo {
    fn new(ws: Ws, reason: Arc<Mutex<Option<String>>>) -> Self {
        let now = tokio::time::Instant::now();
        let mut ping = tokio::time::interval_at(now + PING_INTERVAL, PING_INTERVAL);
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        Self { ws, pending: Vec::new(), pos: 0, reason, ping, last_heard: now }
    }

    /// Sends a ping when one is due and ends the session after [`IDLE_TIMEOUT`] of silence.
    /// yamux polls reads for as long as the session lives, so this runs from `poll_read`.
    fn keep_alive(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        while self.ping.poll_tick(cx).is_ready() {
            if self.last_heard.elapsed() >= IDLE_TIMEOUT {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "the relay stopped answering"));
            }
            // A full send buffer means data is moving; the next tick tries again.
            if let Poll::Ready(Ok(())) = Pin::new(&mut self.ws).poll_ready(cx) {
                Pin::new(&mut self.ws).start_send(Message::Ping(Vec::new().into())).map_err(io_err)?;
                // Pending is fine: the waker is registered and the next poll finishes it.
                if let Poll::Ready(Err(error)) = Pin::new(&mut self.ws).poll_flush(cx) {
                    return Err(io_err(error));
                }
            }
        }
        Ok(())
    }
}

impl FAsyncRead for WsIo {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        if self.pos >= self.pending.len() {
            self.keep_alive(cx)?;
        }
        loop {
            if self.pos < self.pending.len() {
                let n = buf.len().min(self.pending.len() - self.pos);
                let pos = self.pos;
                buf[..n].copy_from_slice(&self.pending[pos..pos + n]);
                self.pos += n;
                return Poll::Ready(Ok(n));
            }
            let next = ready!(Pin::new(&mut self.ws).poll_next(cx));
            if matches!(next, Some(Ok(_))) {
                self.last_heard = tokio::time::Instant::now();
            }
            match next {
                Some(Ok(Message::Binary(data))) => {
                    self.pending = data.to_vec();
                    self.pos = 0;
                }
                Some(Ok(Message::Close(frame))) => {
                    if let Some(frame) = frame {
                        *self.reason.lock().unwrap() = Some(frame.reason.to_string());
                    }
                    return Poll::Ready(Ok(0));
                }
                Some(Ok(_)) => {}
                Some(Err(tungstenite::Error::ConnectionClosed)) | None => return Poll::Ready(Ok(0)),
                Some(Err(error)) => return Poll::Ready(Err(io_err(error))),
            }
        }
    }
}

impl FAsyncWrite for WsIo {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        ready!(Pin::new(&mut self.ws).poll_ready(cx)).map_err(io_err)?;
        Pin::new(&mut self.ws).start_send(Message::Binary(buf.to_vec().into())).map_err(io_err)?;
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.ws).poll_flush(cx).map_err(io_err)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match ready!(Pin::new(&mut self.ws).poll_close(cx)) {
            Ok(()) | Err(tungstenite::Error::ConnectionClosed) => Poll::Ready(Ok(())),
            Err(error) => Poll::Ready(Err(io_err(error))),
        }
    }
}
