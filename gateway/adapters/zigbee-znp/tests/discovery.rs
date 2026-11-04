use limeiot_zigbee_znp::{DiscoveryTarget, Error, InterviewTarget, Session};
use std::time::Duration;
use tokio::{
    io::{duplex, AsyncReadExt},
    time::{timeout, Instant},
};

#[tokio::test]
async fn invalid_discovery_target_and_expired_deadline_have_zero_writes() {
    let (host, mut ncp) = duplex(512);
    let mut session = Session::new(host);
    for ieee in [
        "0".repeat(16),
        "f".repeat(16),
        "01020304050607AA".into(),
        "1".into(),
    ] {
        assert!(matches!(
            session
                .neighbors(
                    &DiscoveryTarget {
                        coordinator_ieee: ieee
                    },
                    Instant::now() + Duration::from_secs(1)
                )
                .await,
            Err(Error::InvalidInput)
        ));
        assert!(!session.is_closed());
    }
    let target = DiscoveryTarget {
        coordinator_ieee: "0102030405060708".into(),
    };
    assert!(matches!(
        session
            .neighbors(&target, Instant::now() - Duration::from_secs(1))
            .await,
        Err(Error::Timeout)
    ));
    assert!(session.is_closed());
    let mut sent = Vec::new();
    ncp.read_to_end(&mut sent).await.unwrap();
    assert!(sent.is_empty());
}

#[tokio::test]
async fn cancelled_discovery_drops_transport_and_rejects_reuse() {
    let (host, mut ncp) = duplex(512);
    let mut session = Session::new(host);
    let target = DiscoveryTarget {
        coordinator_ieee: "0102030405060708".into(),
    };
    assert!(timeout(
        Duration::from_millis(25),
        session.neighbors(&target, Instant::now() + Duration::from_secs(1))
    )
    .await
    .is_err());
    assert!(session.is_closed());
    assert!(matches!(
        session
            .neighbors(&target, Instant::now() + Duration::from_secs(1))
            .await,
        Err(Error::SessionClosed)
    ));
    let mut sent = Vec::new();
    ncp.read_to_end(&mut sent).await.unwrap();
    assert_eq!(sent, [0xfe, 0, 0x21, 1, 0x20]);
}

#[tokio::test]
async fn ieee_interview_rejects_invalid_identities_before_io_and_cancel_closes_session() {
    let (host, mut ncp) = duplex(512);
    let mut session = Session::new(host);
    for ieee in ["0102030405060708", "ffffffffffffffff", "bad"] {
        assert!(matches!(
            session
                .interview_ieee(
                    &InterviewTarget {
                        coordinator_ieee: "0102030405060708".into(),
                        ieee_address: ieee.into(),
                    },
                    Instant::now() + Duration::from_secs(1)
                )
                .await,
            Err(Error::InvalidInput)
        ));
        assert!(!session.is_closed());
    }
    let target = InterviewTarget {
        coordinator_ieee: "0102030405060708".into(),
        ieee_address: "1122334455667788".into(),
    };
    assert!(timeout(
        Duration::from_millis(25),
        session.interview_ieee(&target, Instant::now() + Duration::from_secs(1))
    )
    .await
    .is_err());
    assert!(session.is_closed());
    assert!(matches!(
        session
            .interview_ieee(&target, Instant::now() + Duration::from_secs(1))
            .await,
        Err(Error::SessionClosed)
    ));
    let mut sent = Vec::new();
    ncp.read_to_end(&mut sent).await.unwrap();
    assert_eq!(sent, [0xfe, 0, 0x21, 1, 0x20]);
}
