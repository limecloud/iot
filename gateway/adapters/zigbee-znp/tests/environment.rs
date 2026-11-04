use limeiot_zigbee_znp::{
    DiscoveryTarget, EnvironmentTarget, Error, InterviewTarget, JoinWindowTarget,
    OnOffCommandTarget, Session, Signature,
};
use std::time::Duration;
use tokio::{
    io::{duplex, AsyncReadExt, AsyncWriteExt, DuplexStream},
    time::{timeout, Instant},
};

fn target() -> EnvironmentTarget {
    EnvironmentTarget {
        coordinator_ieee: "0102030405060708".into(),
        ieee_address: "1122334455667788".into(),
        endpoint: 1,
    }
}
fn packet(a: u8, b: u8, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0xfe, payload.len() as u8, a, b];
    bytes.extend(payload);
    bytes.push(bytes[1..].iter().fold(0, |sum, byte| sum ^ byte));
    bytes
}
fn zdo(command: u8, payload: &[u8]) -> Vec<u8> {
    [
        packet(0x65, command, &[0]),
        packet(0x45, command | 0x80, payload),
    ]
    .concat()
}

#[derive(Default)]
struct Traffic {
    af_ids: Vec<u8>,
    registrations: usize,
    hosts: Vec<u8>,
    on_off_commands: Vec<bool>,
}

/// 同一传输跨多次读取；第三次在AF阶段拒绝，验证失败后不能重用会话。
async fn ncp(mut stream: DuplexStream, fail_id: Option<u8>) -> Traffic {
    let mut traffic = Traffic::default();
    loop {
        let mut header = [0; 4];
        if stream.read_exact(&mut header).await.is_err() {
            return traffic;
        }
        assert_eq!(header[0], 0xfe);
        let mut body = vec![0; usize::from(header[1]) + 1];
        stream.read_exact(&mut body).await.unwrap();
        assert_eq!(header[1..].iter().chain(&body).fold(0, |sum, b| sum ^ b), 0);
        let data = &body[..body.len() - 1];
        let response = match (header[2], header[3]) {
            (0x21, 1) => packet(0x61, 1, &[0x15, 0]),
            (0x21, 2) => packet(0x61, 2, &[2, 1, 3, 0, 1]),
            (0x25, 0) => zdo(
                0,
                &[
                    0, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x34, 0x12, 0, 0,
                ],
            ),
            (0x25, 1) => {
                let mut payload = vec![0];
                payload.extend(if data[0..2] == [0, 0] {
                    [8, 7, 6, 5, 4, 3, 2, 1]
                } else {
                    [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11]
                });
                payload.extend(&data[0..2]);
                payload.extend([0, 0]);
                zdo(1, &payload)
            }
            (0x25, 0x36) => {
                assert_eq!(data, [2, 0, 0, 60, 1]);
                zdo(0x36, &[0, 0, 0])
            }
            (0x25, 2) if data == [0, 0, 0, 0] => zdo(
                2,
                &[
                    0, 0, 0, 0, 0, 0, 0x40, 0x80, 0x34, 0x12, 82, 82, 0, 0, 0, 82, 0, 0,
                ],
            ),
            (0x25, 2) => zdo(
                2,
                &[
                    0x34, 0x12, 0, 0x34, 0x12, 2, 0x40, 0x80, 0x34, 0x12, 82, 82, 0, 0, 0, 82, 0, 0,
                ],
            ),
            (0x25, 0x31) => {
                assert_eq!(data, [0, 0, 0]);
                zdo(0x31, &[0, 0, 0, 0, 0, 0])
            }
            (0x25, 5) if data[0..2] == [0, 0] => {
                let mut payload = vec![0, 0, 0, 0, 0, traffic.hosts.len() as u8];
                payload.extend(&traffic.hosts);
                zdo(5, &payload)
            }
            (0x25, 5) => zdo(5, &[0x34, 0x12, 0, 0x34, 0x12, 1, 1]),
            (0x25, 4) => {
                let mut payload = vec![data[0], data[1], 0, data[0], data[1]];
                payload.extend(if data[4] == 240 {
                    vec![14, 240, 4, 1, 5, 0, 0, 0, 3, 0, 0, 2, 4, 5, 4]
                } else if data[4] == 239 {
                    vec![12, 239, 4, 1, 5, 0, 0, 0, 2, 0, 0, 6, 0]
                } else {
                    vec![16, 1, 4, 1, 2, 3, 0, 4, 0, 0, 2, 4, 5, 4, 6, 0, 0]
                });
                zdo(4, &payload)
            }
            (0x24, 0) => {
                traffic.registrations += 1;
                assert!(!traffic.hosts.contains(&data[0]));
                traffic.hosts.push(data[0]);
                if data[0] == 240 {
                    assert_eq!(data, [240, 4, 1, 5, 0, 0, 0, 0, 3, 0, 0, 2, 4, 5, 4]);
                } else {
                    assert_eq!(data, [239, 4, 1, 5, 0, 0, 0, 0, 2, 0, 0, 6, 0]);
                }
                packet(0x64, 0, &[0])
            }
            (0x24, 1) => {
                let id = data[6];
                traffic.af_ids.push(id);
                if Some(id) == fail_id {
                    packet(0x44, 0x80, &[0xb7, data[3], id])
                } else {
                    let mut zcl = vec![0x18, id, 1];
                    if data[10] == 0x01 {
                        assert_eq!(&data[4..6], [6, 0]);
                        assert_eq!(data.len(), 13);
                        assert!(data[12] < 2);
                        traffic.on_off_commands.push(data[12] == 1);
                        zcl = vec![0x18, id, 0x0b, data[12], 0];
                    } else {
                        match &data[4..6] {
                            [0, 0] => zcl.extend([
                                1, 0, 0, 0x20, 2, 3, 0, 0, 0x20, 1, 4, 0, 0, 0x42, 1, b'L', 5, 0,
                                0, 0x42, 1, b'M',
                            ]),
                            [2, 4] => zcl.extend([0, 0, 0, 0x29, 0x34, 0x09]),
                            [5, 4] => zcl.extend([0, 0, 0, 0x21, 0x88, 0x13]),
                            [6, 0] => zcl.extend([0, 0, 0, 0x10, 0]),
                            _ => panic!("非固定Cluster"),
                        }
                    }
                    let mut payload = vec![
                        0,
                        0,
                        data[4],
                        data[5],
                        0x34,
                        0x12,
                        1,
                        data[3],
                        0,
                        200,
                        1,
                        0,
                        0,
                        0,
                        0,
                        0,
                        zcl.len() as u8,
                    ];
                    payload.extend(zcl);
                    payload.extend([0x34, 0x12, 30]);
                    [
                        packet(0x64, 1, &[0]),
                        packet(0x44, 0x81, &payload),
                        packet(0x44, 0x80, &[0, data[3], id]),
                    ]
                    .concat()
                }
            }
            _ => panic!("非固定MT命令"),
        };
        if stream.write_all(&response).await.is_err() {
            return traffic;
        }
    }
}

#[tokio::test]
async fn reused_session_preserves_ids_registers_once_and_closes_on_delivery_failure() {
    let (host, ncp_stream) = duplex(1024);
    let task = tokio::spawn(ncp(ncp_stream, Some(6)));
    let mut session = Session::new(host);
    for index in 0..2 {
        let reading = session
            .read_environment(&target(), Instant::now() + Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(reading.temperature_celsius_x100.value, 2356);
        assert_eq!(reading.humidity_percent_x100.value, 5000);
        assert!(!session.is_closed());
        if index == 0 {
            let neighbors = session
                .neighbors(
                    &DiscoveryTarget {
                        coordinator_ieee: target().coordinator_ieee,
                    },
                    Instant::now() + Duration::from_secs(2),
                )
                .await
                .unwrap();
            assert!(neighbors.items.is_empty());
            let interview = session
                .interview_ieee(
                    &InterviewTarget {
                        coordinator_ieee: target().coordinator_ieee,
                        ieee_address: target().ieee_address,
                    },
                    Instant::now() + Duration::from_secs(2),
                )
                .await
                .unwrap();
            assert_eq!(interview.ieee_address, target().ieee_address);
            assert_eq!(interview.endpoints[0].endpoint, 1);
            let window = session
                .permit_join(
                    &JoinWindowTarget {
                        coordinator_ieee: target().coordinator_ieee,
                        duration_seconds: 60,
                    },
                    Instant::now() + Duration::from_secs(2),
                )
                .await
                .unwrap();
            assert_eq!(window.status, "protocol_accepted");
            assert!(!session.is_closed());
        }
    }
    assert!(matches!(
        session
            .read_environment(&target(), Instant::now() + Duration::from_secs(2))
            .await,
        Err(Error::DeliveryFailed(0xb7))
    ));
    assert!(session.is_closed());
    assert!(matches!(
        session
            .read_environment(&target(), Instant::now() + Duration::from_secs(2))
            .await,
        Err(Error::SessionClosed)
    ));
    let traffic = task.await.unwrap();
    assert_eq!(traffic.af_ids, [0, 1, 2, 3, 4, 5, 6]);
    assert_eq!(traffic.registrations, 1);
}

#[tokio::test]
async fn environment_and_on_off_share_ids_keep_two_hosts_and_never_echo_requested_power() {
    let (host, ncp_stream) = duplex(1024);
    let task = tokio::spawn(ncp(ncp_stream, None));
    let mut session = Session::new(host);
    let deadline = || Instant::now() + Duration::from_secs(2);
    session
        .read_environment(&target(), deadline())
        .await
        .unwrap();
    assert!(
        !session
            .read_on_off(&target(), deadline())
            .await
            .unwrap()
            .power
            .value
    );
    let result = session
        .set_on_off(
            &OnOffCommandTarget {
                target: target(),
                manufacturer_code: 0x1234,
                signature: Signature {
                    manufacturer: "L".into(),
                    model: "M".into(),
                    application_version: 2,
                    hardware_version: 1,
                },
                power: true,
            },
            deadline(),
        )
        .await
        .unwrap();
    assert_eq!(result.status, "protocol_accepted");
    assert!(result.power_requested);
    assert!(!result.device_state_confirmed);
    // 夹具接受命令但物理状态未变化，独立读取仍必须返回false。
    assert!(
        !session
            .read_on_off(&target(), deadline())
            .await
            .unwrap()
            .power
            .value
    );
    session
        .read_environment(&target(), deadline())
        .await
        .unwrap();
    drop(session);
    let traffic = task.await.unwrap();
    assert_eq!(traffic.af_ids, (0..12).collect::<Vec<_>>());
    assert_eq!(traffic.hosts, [240, 239]);
    assert_eq!(traffic.registrations, 2);
    assert_eq!(traffic.on_off_commands, [true]);
}

#[tokio::test]
async fn invalid_target_and_expired_environment_read_have_zero_writes() {
    let (host, mut ncp) = duplex(1024);
    let mut session = Session::new(host);
    let mut invalid = target();
    invalid.ieee_address = invalid.coordinator_ieee.clone();
    assert!(matches!(
        session
            .read_environment(&invalid, Instant::now() + Duration::from_secs(1))
            .await,
        Err(Error::InvalidInput)
    ));
    assert!(!session.is_closed());
    assert!(matches!(
        session
            .read_environment(&target(), Instant::now() - Duration::from_secs(1))
            .await,
        Err(Error::Timeout)
    ));
    assert!(session.is_closed());
    let mut sent = Vec::new();
    ncp.read_to_end(&mut sent).await.unwrap();
    assert!(sent.is_empty());
}

#[tokio::test]
async fn cancelled_environment_read_closes_owned_transport() {
    let (host, mut ncp) = duplex(1024);
    let mut session = Session::new(host);
    assert!(timeout(
        Duration::from_millis(25),
        session.read_environment(&target(), Instant::now() + Duration::from_secs(2))
    )
    .await
    .is_err());
    assert!(session.is_closed());
    let mut sent = Vec::new();
    ncp.read_to_end(&mut sent).await.unwrap();
    assert_eq!(sent, packet(0x21, 1, &[]));
}
