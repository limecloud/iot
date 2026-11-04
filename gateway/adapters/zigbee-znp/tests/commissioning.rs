use limeiot_zigbee_znp::{Error, JoinWindowTarget, Session};
use std::time::Duration;
use tokio::{
    io::{duplex, AsyncReadExt, AsyncWriteExt},
    sync::oneshot,
    time::Instant,
};

fn target() -> JoinWindowTarget {
    JoinWindowTarget {
        coordinator_ieee: "0102030405060708".into(),
        duration_seconds: 60,
    }
}
fn packet(a: u8, b: u8, data: &[u8]) -> Vec<u8> {
    let mut result = vec![0xfe, data.len() as u8, a, b];
    result.extend(data);
    result.push(result[1..].iter().fold(0, |sum, b| sum ^ b));
    result
}

#[tokio::test]
async fn invalid_join_requests_and_expired_deadline_have_zero_writes() {
    let (host, mut ncp) = duplex(512);
    let mut session = Session::new(host);
    for ieee in [
        "bad",
        "0000000000000000",
        "ffffffffffffffff",
        "0102030405060708\n",
    ] {
        let invalid = JoinWindowTarget {
            coordinator_ieee: ieee.into(),
            ..target()
        };
        assert!(matches!(
            session
                .permit_join(&invalid, Instant::now() + Duration::from_secs(1))
                .await,
            Err(Error::InvalidInput)
        ));
        assert!(!session.is_closed());
    }
    for duration in [121, 254, 255] {
        let invalid = JoinWindowTarget {
            duration_seconds: duration,
            ..target()
        };
        assert!(matches!(
            session
                .permit_join(&invalid, Instant::now() + Duration::from_secs(1))
                .await,
            Err(Error::InvalidInput)
        ));
    }
    assert!(matches!(
        session
            .permit_join(&target(), Instant::now() - Duration::from_secs(1))
            .await,
        Err(Error::Timeout)
    ));
    assert!(session.is_closed());
    let mut bytes = vec![];
    ncp.read_to_end(&mut bytes).await.unwrap();
    assert!(bytes.is_empty());
}

#[tokio::test]
async fn cancellation_after_network_write_closes_transport_without_retry_or_implicit_close() {
    let (host, mut ncp) = duplex(1024);
    let mut session = Session::new(host);
    let (sent, received) = oneshot::channel();
    let worker = tokio::spawn(async move {
        let mut sent = Some(sent);
        let mut commands = vec![];
        loop {
            let mut header = [0; 4];
            if ncp.read_exact(&mut header).await.is_err() {
                return commands;
            }
            let mut tail = vec![0; usize::from(header[1]) + 1];
            ncp.read_exact(&mut tail).await.unwrap();
            assert_eq!(header[1..].iter().chain(&tail).fold(0, |sum, b| sum ^ b), 0);
            commands.push((header[2], header[3]));
            let payload = match (header[2], header[3]) {
                (0x21, 1) => packet(0x61, 1, &[0x11, 0]),
                (0x21, 2) => packet(0x61, 2, &[2, 1, 3, 0, 1]),
                (0x25, 1) => [
                    packet(0x65, 1, &[0]),
                    packet(0x45, 0x81, &[0, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 0, 0]),
                ]
                .concat(),
                (0x25, 2) => [
                    packet(0x65, 2, &[0]),
                    packet(
                        0x45,
                        0x82,
                        &[
                            0, 0, 0, 0, 0, 0, 0x40, 0x80, 0x34, 0x12, 82, 82, 0, 0, 0, 82, 0, 0,
                        ],
                    ),
                ]
                .concat(),
                (0x25, 0x36) => {
                    assert_eq!(&tail[..tail.len() - 1], [2, 0, 0, 60, 1]);
                    sent.take().unwrap().send(()).unwrap();
                    continue;
                }
                _ => panic!("unexpected command"),
            };
            ncp.write_all(&payload).await.unwrap();
        }
    });
    {
        let selected = target();
        let request = session.permit_join(&selected, Instant::now() + Duration::from_secs(2));
        tokio::pin!(request);
        tokio::select! { result = &mut request => panic!("completed before cancellation: {result:?}"), result = received => result.unwrap() }
    }
    assert!(session.is_closed());
    assert!(matches!(
        session
            .permit_join(&target(), Instant::now() + Duration::from_secs(1))
            .await,
        Err(Error::SessionClosed)
    ));
    drop(session);
    let commands = worker.await.unwrap();
    assert_eq!(commands.iter().filter(|&&c| c == (0x25, 0x36)).count(), 1);
}
