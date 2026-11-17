//! The connecting side. Listens on `127.0.0.1` only and carries every connection or UDP
//! source address to the relay as its own flow.

use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tokio::{
    net::{TcpListener, TcpStream, UdpSocket},
    task::{AbortHandle, JoinSet},
};

use super::{
    flows::{copy_counted, Counters, FlowGuard, FlowTable, UDP_IDLE},
    frames::{decode_datagram, encode_datagram, read_frame, write_frame, Frame, KIND_TCP, KIND_UDP},
    link::{DatagramError, Link},
    publisher::Report,
};

/// How many datagrams to hold for a new UDP flow while the relay answers.
const PENDING_LIMIT: usize = 16;

/// Local sockets for one share, bound before connecting so the port can be told to the user.
pub struct Listeners {
    pub tcp: Option<TcpListener>,
    pub udp: Option<Arc<UdpSocket>>,
    pub port: u16,
    /// Set when the share's own port was taken and another was used.
    pub moved_from: Option<u16>,
}

/// Binds `127.0.0.1:<port>`, falling back to a free port when it is taken. With both
/// protocols the TCP and UDP sockets share one port number.
pub async fn bind(port: u16, want_tcp: bool, want_udp: bool) -> std::io::Result<Listeners> {
    let try_bind = |port: u16| async move {
        let tcp = if want_tcp { Some(TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?) } else { None };
        let bound = match &tcp {
            Some(listener) => listener.local_addr()?.port(),
            None => port,
        };
        let udp = if want_udp { Some(Arc::new(UdpSocket::bind((Ipv4Addr::LOCALHOST, bound)).await?)) } else { None };
        let bound = match (&tcp, &udp) {
            (Some(l), _) => l.local_addr()?.port(),
            (None, Some(u)) => u.local_addr()?.port(),
            _ => bound,
        };
        std::io::Result::Ok(Listeners { tcp, udp, port: bound, moved_from: None })
    };
    match try_bind(port).await {
        Ok(listeners) => Ok(listeners),
        Err(_) => {
            // Port 0 asks for a free one; with both protocols the UDP side may collide, so retry.
            let mut last = None;
            for _ in 0..20 {
                match try_bind(0).await {
                    Ok(mut listeners) => {
                        listeners.moved_from = Some(port);
                        return Ok(listeners);
                    }
                    Err(e) => last = Some(e),
                }
            }
            Err(last.unwrap())
        }
    }
}

enum UdpState {
    /// Waiting for the relay; the first datagrams are kept.
    Pending(Vec<Vec<u8>>),
    Ready,
}

struct UdpFlow {
    addr: SocketAddr,
    state: UdpState,
    lifetime: Option<AbortHandle>,
}

struct UdpFlows {
    table: FlowTable<UdpFlow>,
    by_addr: HashMap<SocketAddr, u32>,
    next: u32,
}

type Shared = Arc<Mutex<UdpFlows>>;

pub async fn run<L: Link>(
    link: Arc<L>,
    share_id: String,
    listeners: Listeners,
    counters: Arc<Counters>,
    report: Report,
) -> String {
    let mut tasks: JoinSet<()> = JoinSet::new();
    let shared: Shared = Arc::new(Mutex::new(UdpFlows { table: FlowTable::new(UDP_IDLE), by_addr: HashMap::new(), next: 0 }));
    let mtu = 1000usize;
    let mut sweep = tokio::time::interval(Duration::from_secs(5));
    let closed = link.closed();
    tokio::pin!(closed);
    let tcp = listeners.tcp;
    let udp = listeners.udp;
    let mut udp_buf = vec![0u8; 64 * 1024];
    // After a failed accept (out of file descriptors, say) the next one waits, so the
    // loop does not spin a core retrying.
    let mut accept_pause = Duration::ZERO;
    loop {
        tokio::select! {
            reason = &mut closed => return reason,
            accepted = accept(&tcp, accept_pause) => match accepted {
                Ok((socket, _)) => {
                    accept_pause = Duration::ZERO;
                    let (link, share_id, counters, report) = (link.clone(), share_id.clone(), counters.clone(), report.clone());
                    tasks.spawn(async move { tcp_flow(link, share_id, socket, counters, report).await });
                }
                Err(_) => accept_pause = next_accept_pause(accept_pause),
            },
            received = recv_from(&udp, &mut udp_buf) => {
                let Ok((n, from)) = received else { continue };
                let payload = udp_buf[..n].to_vec();
                if payload.len() > mtu {
                    Counters::add(&counters.udp_dropped, 1);
                    continue;
                }
                from_local(&link, &share_id, &shared, &mut tasks, &counters, &report, from, payload);
            }
            datagram = link.recv_datagram() => match datagram {
                Ok(data) => to_local(&data, &shared, &udp).await,
                Err(_) => return (&mut closed).await,
            },
            _ = sweep.tick() => {
                let gone = {
                    let mut flows = shared.lock().unwrap();
                    let gone = flows.table.expire(Instant::now());
                    for (_, flow) in &gone { flows.by_addr.remove(&flow.addr); }
                    gone
                };
                for (_, flow) in gone {
                    if let Some(handle) = flow.lifetime { handle.abort(); }
                    Counters::add_flows(&counters, -1);
                }
            }
            Some(_) = tasks.join_next() => {}
        }
    }
}

const ACCEPT_PAUSE_MIN: Duration = Duration::from_millis(50);
const ACCEPT_PAUSE_MAX: Duration = Duration::from_secs(1);

fn next_accept_pause(pause: Duration) -> Duration {
    (pause * 2).clamp(ACCEPT_PAUSE_MIN, ACCEPT_PAUSE_MAX)
}

async fn accept(listener: &Option<TcpListener>, pause: Duration) -> std::io::Result<(TcpStream, SocketAddr)> {
    if !pause.is_zero() {
        tokio::time::sleep(pause).await;
    }
    match listener {
        Some(listener) => listener.accept().await,
        None => std::future::pending().await,
    }
}

async fn recv_from(socket: &Option<Arc<UdpSocket>>, buf: &mut [u8]) -> std::io::Result<(usize, SocketAddr)> {
    match socket {
        Some(socket) => socket.recv_from(buf).await,
        None => std::future::pending().await,
    }
}

async fn tcp_flow<L: Link>(link: Arc<L>, share_id: String, local: TcpStream, counters: Arc<Counters>, report: Report) {
    let Ok((mut tx, mut rx)) = link.open_stream().await else { return };
    if write_frame(&mut tx, &Frame::Open { share_id, kind: KIND_TCP, flow_id: 0 }).await.is_err() {
        return;
    }
    match read_frame(&mut rx).await {
        Ok(Frame::Accepted { .. }) => {}
        Ok(Frame::Refused { reason }) => return report(reason),
        _ => return report("The relay stopped answering, so a connection was dropped.".to_string()),
    }
    let _flow = FlowGuard::new(&counters.flows);
    let (read_local, write_local) = local.into_split();
    let up = copy_counted(read_local, tx, &counters.bytes_up);
    let down = copy_counted(rx, write_local, &counters.bytes_down);
    let _ = tokio::join!(up, down);
}

#[allow(clippy::too_many_arguments)]
fn from_local<L: Link>(
    link: &Arc<L>,
    share_id: &str,
    shared: &Shared,
    tasks: &mut JoinSet<()>,
    counters: &Arc<Counters>,
    report: &Report,
    from: SocketAddr,
    payload: Vec<u8>,
) {
    let now = Instant::now();
    let mut flows = shared.lock().unwrap();
    if let Some(&id) = flows.by_addr.get(&from) {
        let ready = match flows.table.touch(id, now) {
            Some(flow) => match &mut flow.state {
                UdpState::Ready => true,
                UdpState::Pending(queue) => {
                    if queue.len() < PENDING_LIMIT {
                        queue.push(payload.clone());
                    } else {
                        Counters::add(&counters.udp_dropped, 1);
                    }
                    false
                }
            },
            None => false,
        };
        drop(flows);
        if ready {
            send_up(link, id, &payload, counters);
        }
        return;
    }
    flows.next += 1;
    let id = flows.next;
    flows.by_addr.insert(from, id);
    flows.table.insert(id, UdpFlow { addr: from, state: UdpState::Pending(vec![payload]), lifetime: None }, now);
    drop(flows);
    Counters::add_flows(counters, 1);
    let (link, share_id, flows_ref, counters, report) =
        (link.clone(), share_id.to_string(), shared.clone(), counters.clone(), report.clone());
    let handle = tasks.spawn(async move { udp_flow(link, share_id, id, flows_ref, counters, report).await });
    if let Some(flow) = shared.lock().unwrap().table.touch(id, Instant::now()) {
        flow.lifetime = Some(handle);
    }
}

fn send_up<L: Link>(link: &Arc<L>, flow: u32, payload: &[u8], counters: &Counters) {
    match link.send_datagram(encode_datagram(flow, payload)) {
        Ok(()) => Counters::add(&counters.bytes_up, payload.len() as u64),
        Err(DatagramError::TooLarge) | Err(DatagramError::Closed) => Counters::add(&counters.udp_dropped, 1),
    }
}

async fn udp_flow<L: Link>(link: Arc<L>, share_id: String, id: u32, shared: Shared, counters: Arc<Counters>, report: Report) {
    let end = |shared: &Shared, counters: &Counters| {
        let mut flows = shared.lock().unwrap();
        if let Some(flow) = flows.table.remove(id) {
            flows.by_addr.remove(&flow.addr);
            Counters::add_flows(counters, -1);
        }
    };
    let Ok((mut tx, mut rx)) = link.open_stream().await else { return end(&shared, &counters) };
    if write_frame(&mut tx, &Frame::Open { share_id, kind: KIND_UDP, flow_id: id }).await.is_err() {
        return end(&shared, &counters);
    }
    match read_frame(&mut rx).await {
        Ok(Frame::Accepted { .. }) => {}
        Ok(Frame::Refused { reason }) => {
            report(reason);
            return end(&shared, &counters);
        }
        _ => return end(&shared, &counters),
    }
    let queued = {
        let mut flows = shared.lock().unwrap();
        match flows.table.touch(id, Instant::now()) {
            Some(flow) => match std::mem::replace(&mut flow.state, UdpState::Ready) {
                UdpState::Pending(queue) => queue,
                UdpState::Ready => Vec::new(),
            },
            None => return,
        }
    };
    for payload in queued {
        send_up(&link, id, &payload, &counters);
    }
    // The stream marks the flow's life: the relay ending it ends the flow here.
    let _ = read_frame(&mut rx).await;
    drop(tx);
    end(&shared, &counters);
}

async fn to_local(data: &[u8], shared: &Shared, udp: &Option<Arc<UdpSocket>>) {
    let (Some((id, payload)), Some(socket)) = (decode_datagram(data), udp) else { return };
    let addr = shared.lock().unwrap().table.touch(id, Instant::now()).map(|f| f.addr);
    if let Some(addr) = addr {
        let _ = socket.send_to(payload, addr).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_accepts_back_off_up_to_a_second() {
        let mut pause = Duration::ZERO;
        let mut seen = Vec::new();
        for _ in 0..8 {
            pause = next_accept_pause(pause);
            seen.push(pause.as_millis());
        }
        assert_eq!(seen, [50, 100, 200, 400, 800, 1000, 1000, 1000]);
    }
}
