use limeiot_zigbee_znp::{Error, Session};
use std::time::Duration;
use tokio::{
    io::{duplex, AsyncReadExt, AsyncWriteExt},
    time::{timeout, Instant},
};

#[tokio::test]
async fn reads_fragmented_version_and_preserves_firmware_extension() {
    let (host, mut ncp) = duplex(512);
    let mut session = Session::new(host);
    let task = tokio::spawn(async move {
        let mut request = [0; 5];
        ncp.read_exact(&mut request).await.unwrap();
        assert_eq!(request, [0xfe, 0, 0x21, 1, 0x20]);
        ncp.write_all(&[0xfe, 2, 0x61, 1, 0x11, 0, 0x73])
            .await
            .unwrap();
        ncp.read_exact(&mut request).await.unwrap();
        assert_eq!(request, [0xfe, 0, 0x21, 2, 0x23]);
        let mut frame = vec![0xfe, 10, 0x61, 2, 2, 1, 3, 0, 0, 11, 22, 33, 44, 55];
        frame.push(frame[1..].iter().fold(0, |sum, byte| sum ^ byte));
        for byte in frame {
            ncp.write_all(&[byte]).await.unwrap();
            tokio::task::yield_now().await;
        }
    });
    let probe = session
        .probe(Instant::now() + Duration::from_secs(1))
        .await
        .unwrap();
    assert_eq!(probe.capabilities, 0x11);
    assert_eq!(probe.version_extension, [11, 22, 33, 44, 55]);
    assert!(!session.is_closed());
    task.await.unwrap();
}

#[tokio::test]
async fn timeout_closes_stream_and_never_retries_late_response() {
    let (host, mut ncp) = duplex(512);
    let mut session = Session::new(host);
    let result = session
        .probe(Instant::now() + Duration::from_millis(25))
        .await;
    assert!(matches!(result, Err(Error::Timeout)));
    assert!(session.is_closed());
    assert!(matches!(
        session.probe(Instant::now() + Duration::from_secs(1)).await,
        Err(Error::SessionClosed)
    ));
    let mut bytes = Vec::new();
    ncp.read_to_end(&mut bytes).await.unwrap();
    assert_eq!(bytes, [0xfe, 0, 0x21, 1, 0x20]);
    assert!(ncp
        .write_all(&[0xfe, 2, 0x61, 1, 0x11, 0, 0x73])
        .await
        .is_err());
}

#[tokio::test]
async fn caller_cancellation_closes_owned_transport() {
    let (host, mut ncp) = duplex(512);
    let mut session = Session::new(host);
    assert!(timeout(
        Duration::from_millis(25),
        session.probe(Instant::now() + Duration::from_secs(1))
    )
    .await
    .is_err());
    assert!(session.is_closed());
    let mut bytes = Vec::new();
    ncp.read_to_end(&mut bytes).await.unwrap();
    assert_eq!(bytes.len(), 5);
}

#[tokio::test]
async fn expired_deadline_and_reserved_address_have_zero_writes() {
    let (host, mut ncp) = duplex(512);
    let mut session = Session::new(host);
    assert!(matches!(
        session
            .interview(0xffff, Instant::now() + Duration::from_secs(1))
            .await,
        Err(Error::InvalidInput)
    ));
    assert!(matches!(
        session.probe(Instant::now() - Duration::from_secs(1)).await,
        Err(Error::Timeout)
    ));
    let mut bytes = Vec::new();
    ncp.read_to_end(&mut bytes).await.unwrap();
    assert!(bytes.is_empty());
}

#[tokio::test]
async fn wrong_sync_response_and_bad_checksum_fail_closed() {
    for bytes in [
        vec![0xfe, 0, 0x61, 2, 0x63],
        vec![0xfe, 2, 0x61, 1, 0x11, 0, 0],
    ] {
        let (host, mut ncp) = duplex(512);
        let mut session = Session::new(host);
        ncp.write_all(&bytes).await.unwrap();
        let result = session.probe(Instant::now() + Duration::from_secs(1)).await;
        assert!(matches!(
            result,
            Err(Error::UnexpectedResponse | Error::InvalidFrame)
        ));
        assert!(session.is_closed());
        let mut sent = Vec::new();
        ncp.read_to_end(&mut sent).await.unwrap();
        assert_eq!(sent.len(), 5);
    }
}
