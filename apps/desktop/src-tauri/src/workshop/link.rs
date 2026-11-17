//! One connection to the relay. `Link` is what publishing and consuming need from it.
//! [`RelayLink`] is either route: QUIC with TLS 1.3, or a WebSocket over TLS (usually on
//! 443) for networks and CDNs that pass no UDP. [`connect`] races the routes the server
//! lists.

use std::{
    collections::HashMap,
    future::Future,
    io,
    net::SocketAddr,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use futures_util::stream::{FuturesUnordered, StreamExt};
use quinn::crypto::rustls::QuicClientConfig;
use tokio::io::{AsyncRead, AsyncWrite};

use super::{
    frames::{read_frame, write_frame, Frame, ALPN, ROLE_CONSUMER, ROLE_PUBLISHER},
    wss::{self, WssSession, WssTx, WssRx},
};

#[derive(Debug)]
pub enum DatagramError {
    /// The datagram is larger than the path carries. It is dropped and counted.
    TooLarge,
    /// The connection is gone.
    Closed,
}

pub trait Link: Send + Sync + 'static {
    type Tx: AsyncWrite + Unpin + Send + 'static;
    type Rx: AsyncRead + Unpin + Send + 'static;

    fn open_stream(&self) -> impl Future<Output = io::Result<(Self::Tx, Self::Rx)>> + Send;
    fn accept_stream(&self) -> impl Future<Output = io::Result<(Self::Tx, Self::Rx)>> + Send;
    fn send_datagram(&self, data: Vec<u8>) -> Result<(), DatagramError>;
    fn recv_datagram(&self) -> impl Future<Output = io::Result<Vec<u8>>> + Send;
    /// Resolves when the connection ends, with the reason the relay gave (for example
    /// `publisher_offline`) or a description of the failure.
    fn closed(&self) -> impl Future<Output = String> + Send;
    /// Names the route in a sentence fragment, for example
    /// `QUIC with TLS 1.3 to relay.example:7443`.
    fn route(&self) -> String;
    fn close(&self, reason: &str);
}

#[derive(Debug)]
pub struct ConnectError(pub String);

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub struct QuicLink {
    conn: quinn::Connection,
    host_port: String,
}

fn io_err(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::Other, error.to_string())
}

impl Link for QuicLink {
    type Tx = quinn::SendStream;
    type Rx = quinn::RecvStream;

    async fn open_stream(&self) -> io::Result<(Self::Tx, Self::Rx)> {
        self.conn.open_bi().await.map_err(io_err)
    }

    async fn accept_stream(&self) -> io::Result<(Self::Tx, Self::Rx)> {
        self.conn.accept_bi().await.map_err(io_err)
    }

    fn send_datagram(&self, data: Vec<u8>) -> Result<(), DatagramError> {
        self.conn.send_datagram(data.into()).map_err(|error| match error {
            quinn::SendDatagramError::TooLarge => DatagramError::TooLarge,
            _ => DatagramError::Closed,
        })
    }

    async fn recv_datagram(&self) -> io::Result<Vec<u8>> {
        self.conn.read_datagram().await.map(|b| b.to_vec()).map_err(io_err)
    }

    async fn closed(&self) -> String {
        match self.conn.closed().await {
            quinn::ConnectionError::ApplicationClosed(close) => {
                String::from_utf8_lossy(&close.reason).into_owned()
            }
            quinn::ConnectionError::LocallyClosed => "stopped".to_string(),
            other => format!("connection_lost: {other}"),
        }
    }

    fn route(&self) -> String {
        format!("QUIC with TLS 1.3 to {}", self.host_port)
    }

    fn close(&self, reason: &str) {
        self.conn.close(0u32.into(), reason.as_bytes());
    }
}

fn tls_config(alpn: &[u8]) -> Result<rustls::ClientConfig, ConnectError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| ConnectError(format!("Raven couldn’t set up TLS 1.3: {e}")))?;

    #[cfg(debug_assertions)]
    let mut tls = if std::env::var("RAVEN_RELAY_INSECURE").is_ok_and(|v| v == "1") {
        // Debug builds only: lets a local relay use a self-signed certificate. This code is
        // not compiled into release builds, which always verify against the webpki roots.
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(insecure::AcceptAny(provider)))
            .with_no_client_auth()
    } else {
        builder.with_root_certificates(webpki_roots()).with_no_client_auth()
    };
    #[cfg(not(debug_assertions))]
    let mut tls = builder.with_root_certificates(webpki_roots()).with_no_client_auth();

    tls.alpn_protocols = vec![alpn.to_vec()];
    Ok(tls)
}

fn client_config() -> Result<quinn::ClientConfig, ConnectError> {
    let quic = QuicClientConfig::try_from(tls_config(ALPN)?)
        .map_err(|e| ConnectError(format!("Raven couldn’t set up QUIC: {e}")))?;
    let mut config = quinn::ClientConfig::new(Arc::new(quic));
    let mut transport = quinn::TransportConfig::default();
    transport.keep_alive_interval(Some(Duration::from_secs(15)));
    transport.max_idle_timeout(Some(Duration::from_secs(30).try_into().expect("idle timeout")));
    transport.datagram_receive_buffer_size(Some(1 << 20));
    transport.datagram_send_buffer_size(1 << 20);
    config.transport_config(Arc::new(transport));
    Ok(config)
}

fn webpki_roots() -> rustls::RootCertStore {
    rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned())
}

#[cfg(debug_assertions)]
mod insecure {
    use std::sync::Arc;

    use rustls::{
        client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
        crypto::CryptoProvider,
        pki_types::{CertificateDer, ServerName, UnixTime},
        DigitallySignedStruct, Error, SignatureScheme,
    };

    #[derive(Debug)]
    pub struct AcceptAny(pub Arc<CryptoProvider>);

    impl ServerCertVerifier for AcceptAny {
        fn verify_server_cert(
            &self,
            _: &CertificateDer<'_>,
            _: &[CertificateDer<'_>],
            _: &ServerName<'_>,
            _: &[u8],
            _: UnixTime,
        ) -> Result<ServerCertVerified, Error> {
            Ok(ServerCertVerified::assertion())
        }
        fn verify_tls12_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn verify_tls13_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.0.signature_verification_algorithms.supported_schemes()
        }
    }
}

/// A route the server lists: `quic://host:port` or `wss://host/path`.
#[derive(Clone, Debug, PartialEq)]
enum Target {
    Quic(String),
    Wss(String),
}

fn target(endpoint: &str) -> Option<Target> {
    let endpoint = endpoint.trim();
    if let Some(rest) = endpoint.strip_prefix("quic://") {
        return Some(Target::Quic(rest.trim_end_matches('/').to_string()));
    }
    if endpoint.starts_with("wss://") {
        return Some(Target::Wss(endpoint.to_string()));
    }
    // Plain ws:// only in debug builds with RAVEN_RELAY_INSECURE=1, for a local relay.
    // TLS is required on every relay leg, so release builds never use it.
    #[cfg(debug_assertions)]
    if endpoint.starts_with("ws://") && std::env::var("RAVEN_RELAY_INSECURE").is_ok_and(|v| v == "1") {
        return Some(Target::Wss(endpoint.to_string()));
    }
    None
}

/// `host` or `host:port` of a WebSocket URL, for the route line. The default 443 is left out.
fn wss_host(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    host.strip_suffix(":443").unwrap_or(host).to_string()
}

async fn connect_quic(host_port: &str) -> Result<quinn::Connection, ConnectError> {
    let unreachable = |why: &str| ConnectError(format!("The relay at {host_port} is unreachable: {why}."));
    let host = host_port.rsplit_once(':').map(|(h, _)| h).unwrap_or(host_port);
    let host = host.trim_matches(|c| c == '[' || c == ']');
    let addr: SocketAddr = tokio::net::lookup_host(host_port)
        .await
        .map_err(|e| unreachable(&e.to_string()))?
        .next()
        .ok_or_else(|| unreachable("the name has no address"))?;
    let bind: SocketAddr = if addr.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }.parse().expect("bind address");
    let mut endpoint = quinn::Endpoint::client(bind).map_err(|e| unreachable(&e.to_string()))?;
    endpoint.set_default_client_config(client_config()?);
    let connecting = endpoint.connect(addr, host).map_err(|e| unreachable(&e.to_string()))?;
    match tokio::time::timeout(Duration::from_secs(5), connecting).await {
        Ok(Ok(conn)) => Ok(conn),
        Ok(Err(e)) => Err(unreachable(&e.to_string())),
        Err(_) => Err(unreachable("no answer in 5 s")),
    }
}

async fn connect_wss(url: &str) -> Result<WssSession, ConnectError> {
    let unreachable = |why: &str| ConnectError(format!("The relay at {} is unreachable: {why}.", wss_host(url)));
    let tls = Arc::new(tls_config(b"http/1.1")?);
    match tokio::time::timeout(Duration::from_secs(8), wss::open(url, tls)).await {
        Ok(Ok(session)) => Ok(session),
        Ok(Err(e)) => Err(unreachable(&e.to_string())),
        Err(_) => Err(unreachable("no answer in 8 s")),
    }
}

async fn dial(target: &Target) -> Result<Route, ConnectError> {
    match target {
        Target::Quic(host_port) => {
            let conn = connect_quic(host_port).await?;
            Ok(Route::Quic(QuicLink { conn, host_port: host_port.clone() }))
        }
        Target::Wss(url) => {
            let session = connect_wss(url).await?;
            Ok(Route::Wss(WssLink { session, host: wss_host(url), tls: url.starts_with("wss://") }))
        }
    }
}

/// How long each route waits after the one before it, so a working QUIC path wins without
/// delaying a network where only the WebSocket route works.
const RACE_STAGGER: Duration = Duration::from_millis(300);

/// How long the relay has to answer `Hello` and `Attach` once a route is up. A relay that
/// accepts the connection and then says nothing must not hold a publish or connect.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// The route that last worked, per server (its endpoint list), tried first next time.
fn winners() -> &'static Mutex<HashMap<String, String>> {
    static WINNERS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    WINNERS.get_or_init(Default::default)
}

/// The order routes are tried in: the server's, with the last winner moved to the front.
fn race_order(endpoints: &[String], winner: Option<&str>) -> Vec<(String, Target)> {
    let mut routes: Vec<(String, Target)> = endpoints
        .iter()
        .filter_map(|e| target(e).map(|t| (e.trim().to_string(), t)))
        .collect();
    if let Some(at) = winner.and_then(|w| routes.iter().position(|(e, _)| e == w)) {
        let first = routes.remove(at);
        routes.insert(0, first);
    }
    routes
}

/// Connects over the first route that answers, signs in with the session token and says
/// which share this connection serves. `role` is `ROLE_PUBLISHER` or `ROLE_CONSUMER`.
pub async fn connect(endpoints: &[String], token: &str, role: u8, share_id: &str) -> Result<RelayLink, ConnectError> {
    debug_assert!(role == ROLE_PUBLISHER || role == ROLE_CONSUMER);
    let key = endpoints.join(",");
    let winner = winners().lock().unwrap().get(&key).cloned();
    let routes = race_order(endpoints, winner.as_deref());
    if routes.is_empty() {
        return Err(ConnectError("This server has no relay route Raven can use.".to_string()));
    }
    let mut attempts: FuturesUnordered<_> = routes
        .into_iter()
        .enumerate()
        .map(|(i, (endpoint, target))| async move {
            tokio::time::sleep(RACE_STAGGER * i as u32).await;
            (endpoint, dial(&target).await)
        })
        .collect();
    let mut last: Option<ConnectError> = None;
    while let Some((endpoint, result)) = attempts.next().await {
        let route = match result {
            Ok(route) => route,
            Err(error) => {
                last = Some(error);
                continue;
            }
        };
        // The other attempts stop here. A relay that answers but refuses us is an
        // answer; another route would only repeat it.
        drop(attempts);
        winners().lock().unwrap().insert(key, endpoint.clone());
        let link = RelayLink { route, endpoint, ctrl: Mutex::new(None) };
        match tokio::time::timeout(HANDSHAKE_TIMEOUT, link.handshake(token, role, share_id)).await {
            Ok(Ok(())) => return Ok(link),
            Ok(Err(error)) => {
                link.close("handshake_failed");
                return Err(error);
            }
            Err(_) => {
                link.close("handshake_timeout");
                return Err(ConnectError(format!(
                    "The relay at {} answered but didn’t finish signing in within {} s.",
                    link.endpoint,
                    HANDSHAKE_TIMEOUT.as_secs()
                )));
            }
        }
    }
    Err(last.unwrap_or_else(|| ConnectError("This server has no relay route Raven can use.".to_string())))
}

pub struct WssLink {
    session: WssSession,
    host: String,
    /// False only for a debug build's local `ws://` relay.
    tls: bool,
}

enum Route {
    Quic(QuicLink),
    Wss(WssLink),
}

type BoxTx = Box<dyn AsyncWrite + Unpin + Send>;
type BoxRx = Box<dyn AsyncRead + Unpin + Send>;

/// A signed-in connection to the relay, over whichever route won.
pub struct RelayLink {
    route: Route,
    /// The endpoint as the server listed it, so the UI can show the operator's notes.
    pub endpoint: String,
    // The control stream stays open for the life of the connection.
    ctrl: Mutex<Option<(BoxTx, BoxRx)>>,
}

fn boxed<T, R>((tx, rx): (T, R)) -> (BoxTx, BoxRx)
where
    T: AsyncWrite + Unpin + Send + 'static,
    R: AsyncRead + Unpin + Send + 'static,
{
    (Box::new(tx), Box::new(rx))
}

impl RelayLink {
    async fn handshake(&self, token: &str, role: u8, share_id: &str) -> Result<(), ConnectError> {
        let lost = |e: io::Error| ConnectError(format!("The relay closed the connection: {e}."));
        let (mut tx, mut rx) = self.open_stream().await.map_err(lost)?;
        write_frame(&mut tx, &Frame::Hello { token: token.to_string(), role }).await.map_err(lost)?;
        expect(&mut rx, |f| matches!(f, Frame::HelloOk { .. })).await?;
        write_frame(&mut tx, &Frame::Attach { share_id: share_id.to_string() }).await.map_err(lost)?;
        expect(&mut rx, |f| matches!(f, Frame::AttachOk { .. })).await?;
        if let Route::Wss(link) = &self.route {
            link.session.start_datagrams().await.map_err(lost)?;
        }
        *self.ctrl.lock().unwrap() = Some((tx, rx));
        Ok(())
    }
}

impl Link for RelayLink {
    type Tx = BoxTx;
    type Rx = BoxRx;

    async fn open_stream(&self) -> io::Result<(Self::Tx, Self::Rx)> {
        match &self.route {
            Route::Quic(link) => link.open_stream().await.map(boxed),
            Route::Wss(link) => link.session.open_stream().await.map(boxed::<WssTx, WssRx>),
        }
    }

    async fn accept_stream(&self) -> io::Result<(Self::Tx, Self::Rx)> {
        match &self.route {
            Route::Quic(link) => link.accept_stream().await.map(boxed),
            Route::Wss(link) => link.session.accept_stream().await.map(boxed::<WssTx, WssRx>),
        }
    }

    fn send_datagram(&self, data: Vec<u8>) -> Result<(), DatagramError> {
        match &self.route {
            Route::Quic(link) => link.send_datagram(data),
            Route::Wss(link) => link.session.send_datagram(data),
        }
    }

    async fn recv_datagram(&self) -> io::Result<Vec<u8>> {
        match &self.route {
            Route::Quic(link) => link.recv_datagram().await,
            Route::Wss(link) => link.session.recv_datagram().await,
        }
    }

    async fn closed(&self) -> String {
        match &self.route {
            Route::Quic(link) => link.closed().await,
            Route::Wss(link) => link.session.closed().await,
        }
    }

    fn route(&self) -> String {
        match &self.route {
            Route::Quic(link) => link.route(),
            Route::Wss(link) if link.tls => format!("WebSocket with TLS to {}", link.host),
            Route::Wss(link) => format!("WebSocket without TLS (debug) to {}", link.host),
        }
    }

    fn close(&self, reason: &str) {
        match &self.route {
            Route::Quic(link) => link.close(reason),
            Route::Wss(link) => link.session.close(),
        }
    }
}

async fn expect<R: AsyncRead + Unpin>(rx: &mut R, ok: impl Fn(&Frame) -> bool) -> Result<Frame, ConnectError> {
    match read_frame(rx).await {
        Ok(Frame::Error { message, .. }) => Err(ConnectError(message)),
        Ok(frame) if ok(&frame) => Ok(frame),
        Ok(_) => Err(ConnectError("The relay sent something Raven didn’t expect.".to_string())),
        Err(e) => Err(ConnectError(format!("The relay closed the connection: {e}."))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_follow_the_server_with_the_last_winner_first() {
        let endpoints = vec![
            "quic://r.example:7443".to_string(),
            "wss://r.example/v1/relay/ws".to_string(),
            "http://nope".to_string(),
        ];
        let order: Vec<String> = race_order(&endpoints, None).into_iter().map(|(e, _)| e).collect();
        assert_eq!(order, ["quic://r.example:7443", "wss://r.example/v1/relay/ws"]);
        let order: Vec<String> =
            race_order(&endpoints, Some("wss://r.example/v1/relay/ws")).into_iter().map(|(e, _)| e).collect();
        assert_eq!(order, ["wss://r.example/v1/relay/ws", "quic://r.example:7443"]);
    }

    #[test]
    fn the_route_line_names_the_websocket_host() {
        assert_eq!(wss_host("wss://rvn.example/v1/relay/ws"), "rvn.example");
        assert_eq!(wss_host("wss://rvn.example:443/v1/relay/ws"), "rvn.example");
        assert_eq!(wss_host("wss://rvn.example:8443/x"), "rvn.example:8443");
        assert_eq!(target("quic://r.example:7443/"), Some(Target::Quic("r.example:7443".into())));
    }
}
