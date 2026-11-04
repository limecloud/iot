//! 复用既有SQLite事件表保存入网意图和回执；启动只恢复记录，永不补发网络写入。
use super::*;
#[cfg(any(test, all(feature = "zigbee-znp", unix)))]
use crate::commissioning::{Coordinator, Receipt, Request};
use crate::commissioning::{Operation, MAX_OPERATIONS};
#[cfg(any(test, all(feature = "zigbee-znp", unix)))]
use chrono::{DateTime, Utc};
use std::collections::{BTreeMap, BTreeSet};

const EVENT: &str = "zigbee.commissioning";
pub type Journal = BTreeMap<String, Operation>;

pub fn load(connection: &Connection, space: &str) -> Result<Journal> {
    let mut statement = connection
        .prepare("SELECT data FROM events WHERE type=?1 ORDER BY id LIMIT 513")
        .map_err(|_| err("storage_unavailable"))?;
    let rows = statement
        .query_map([EVENT], |row| row.get::<_, String>(0))
        .map_err(|_| err("storage_unavailable"))?;
    let mut journal = Journal::new();
    let mut identifiers = BTreeSet::new();
    let mut count = 0;
    for row in rows {
        count += 1;
        ensure(count <= MAX_OPERATIONS * 2, "storage_corrupt")?;
        let body = row.map_err(|_| err("storage_corrupt"))?;
        let value = limeiot_core::validation::bounded_document(body.as_bytes(), 8192, 8, 256)
            .ok_or_else(|| err("storage_corrupt"))?;
        let operation: Operation =
            serde_json::from_value(value["data"].clone()).map_err(|_| err("storage_corrupt"))?;
        operation.validate().map_err(|_| err("storage_corrupt"))?;
        ensure(operation.request.space_id == space, "storage_corrupt")?;
        match journal.get(&operation.request.idempotency_key) {
            None => ensure(
                operation.sequence as usize == journal.len() + 1
                    && identifiers.insert(operation.operation_id.clone())
                    && operation.status == "unknown"
                    && operation.reason.as_deref() == Some("not_confirmed")
                    && operation.completed_at.is_none(),
                "storage_corrupt",
            )?,
            Some(previous) => {
                let mut expected = previous.clone();
                expected.status = operation.status.clone();
                expected.reason = operation.reason.clone();
                expected.result = operation.result.clone();
                expected.completed_at = operation.completed_at;
                ensure(
                    previous.completed_at.is_none()
                        && operation.completed_at.is_some()
                        && expected == operation,
                    "storage_corrupt",
                )?;
            }
        }
        journal.insert(operation.request.idempotency_key.clone(), operation);
    }
    Ok(journal)
}

impl Store {
    pub fn commissioning_operation(&self, key: &str) -> Result<&Operation> {
        ensure(limeiot_core::identifier(key), "invalid_idempotency_key")?;
        self.commissioning
            .get(key)
            .ok_or_else(|| err("zigbee_operation_not_found"))
    }
}
#[cfg(any(test, all(feature = "zigbee-znp", unix)))]
impl Store {
    pub fn reserve_commissioning(
        &mut self,
        request: Request,
        coordinator: Coordinator,
        now: DateTime<Utc>,
    ) -> Result<(Operation, bool)> {
        request.validate()?;
        ensure(request.space_id == self.data.space_id, "forbidden")?;
        if let Some(previous) = self.commissioning.get(&request.idempotency_key) {
            ensure(previous.request == request, "idempotency_conflict")?;
            return Ok((previous.clone(), false));
        }
        coordinator.validate()?;
        ensure(
            coordinator.coordinator_id == request.change.coordinator_id
                && coordinator.revision == request.change.expected_revision,
            "revision_conflict",
        )?;
        ensure(
            self.commissioning.len() < MAX_OPERATIONS,
            "zigbee_operation_capacity",
        )?;
        // 未确认的开放请求在最迟有限窗口结束前禁止换键再开；明确关闭始终可单独申请。
        ensure(
            request.change.duration_seconds == 0
                || !self.commissioning.values().any(|operation| {
                    operation.coordinator.coordinator_ieee == coordinator.coordinator_ieee
                        && operation.status == "unknown"
                        && operation.blocked_until > now
                }),
            "zigbee_operation_unresolved",
        )?;
        let operation = Operation {
            operation_id: limeiot_core::id(),
            sequence: self.commissioning.len() as u32 + 1,
            request_digest: digest(&request)?,
            coordinator,
            blocked_until: now
                + chrono::Duration::milliseconds(request.change.duration_seconds as i64 * 1000),
            request,
            status: "unknown".into(),
            reason: Some("not_confirmed".into()),
            result: None,
            created_at: now,
            completed_at: None,
        };
        let operation = Operation {
            blocked_until: operation.blocked_until
                + chrono::Duration::milliseconds(operation.coordinator.timeout_ms as i64),
            ..operation
        };
        self.save_commissioning(operation)
            .map(|operation| (operation, true))
    }
    pub fn finish_commissioning(
        &mut self,
        key: &str,
        result: Result<Receipt>,
        now: DateTime<Utc>,
    ) -> Result<Operation> {
        let mut operation = self.commissioning_operation(key)?.clone();
        ensure(
            operation.completed_at.is_none(),
            "zigbee_operation_completed",
        )?;
        operation.completed_at = Some(now.max(operation.created_at));
        match result {
            Ok(mut receipt) => {
                receipt.observed_at = operation.completed_at.unwrap();
                operation.status = "protocol_accepted".into();
                operation.reason = None;
                operation.result = Some(receipt);
            }
            Err(error) => operation.reason = Some(error.code),
        }
        self.save_commissioning(operation)
    }
    fn save_commissioning(&mut self, operation: Operation) -> Result<Operation> {
        operation.validate()?;
        let event = serde_json::to_string(&json!({"occurred_at":Utc::now(),"data":operation}))
            .map_err(|_| err("invalid_json"))?;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| err("storage_unavailable"))?;
        transaction
            .execute(
                "INSERT INTO events(type,data) VALUES(?1,?2)",
                params![EVENT, event],
            )
            .map_err(|_| err("storage_unavailable"))?;
        transaction
            .commit()
            .map_err(|_| err("storage_unavailable"))?;
        self.commissioning
            .insert(operation.request.idempotency_key.clone(), operation.clone());
        Ok(operation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commissioning::Change;

    fn at() -> DateTime<Utc> {
        "2026-11-04T00:00:00Z".parse().unwrap()
    }
    fn coordinator() -> Coordinator {
        Coordinator {
            coordinator_id: "home-znp".into(),
            coordinator_ieee: "0102030405060708".into(),
            revision: format!("sha256:{}", "a".repeat(64)),
            timeout_ms: 500,
        }
    }
    fn request(key: &str, seconds: u8) -> Request {
        Request {
            space_id: "space-demo".into(),
            idempotency_key: key.into(),
            change: Change {
                coordinator_id: coordinator().coordinator_id,
                expected_revision: coordinator().revision,
                duration_seconds: seconds,
            },
        }
    }
    fn config() -> Config {
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap()
    }
    fn store() -> Store {
        Store::open(":memory:", config()).unwrap()
    }
    fn receipt(seconds: u8) -> Receipt {
        Receipt {
            coordinator_ieee: coordinator().coordinator_ieee,
            duration_seconds: seconds,
            observed_at: at(),
        }
    }
    fn event_count(store: &Store) -> u64 {
        store
            .connection
            .query_row(
                "SELECT count(*) FROM events WHERE type=?1",
                [EVENT],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn reservation_precedes_effect_and_same_key_does_not_append_or_change_original() {
        let mut store = store();
        let (reserved, created) = store
            .reserve_commissioning(request("open", 60), coordinator(), at())
            .unwrap();
        assert!(created);
        assert_eq!(reserved.status, "unknown");
        assert!(reserved.completed_at.is_none());
        assert_eq!(event_count(&store), 1);
        let completed = store
            .finish_commissioning("open", Ok(receipt(60)), at())
            .unwrap();
        assert_eq!(completed.status, "protocol_accepted");
        let (resolved, created) = store
            .reserve_commissioning(request("open", 60), coordinator(), at())
            .unwrap();
        assert!(!created);
        assert_eq!(resolved, completed);
        assert_eq!(event_count(&store), 2);
        assert_eq!(
            store
                .reserve_commissioning(request("open", 0), coordinator(), at())
                .unwrap_err()
                .code,
            "idempotency_conflict"
        );
        assert_eq!(
            load(&store.connection, "space-demo").unwrap()["open"],
            completed
        );
    }

    #[test]
    fn failed_intent_and_receipt_commits_never_publish_new_memory_state() {
        let mut store = store();
        store.connection.execute_batch("CREATE TEMP TRIGGER fail_join BEFORE INSERT ON events WHEN NEW.type='zigbee.commissioning' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert_eq!(
            store
                .reserve_commissioning(request("open", 60), coordinator(), at())
                .unwrap_err()
                .code,
            "storage_unavailable"
        );
        assert!(store.commissioning.is_empty());
        assert_eq!(event_count(&store), 0);
        store
            .connection
            .execute_batch("DROP TRIGGER fail_join;")
            .unwrap();
        let (original, _) = store
            .reserve_commissioning(request("open", 60), coordinator(), at())
            .unwrap();
        store.connection.execute_batch("CREATE TEMP TRIGGER fail_join BEFORE INSERT ON events WHEN NEW.type='zigbee.commissioning' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert_eq!(
            store
                .finish_commissioning("open", Ok(receipt(60)), at())
                .unwrap_err()
                .code,
            "storage_unavailable"
        );
        assert_eq!(store.commissioning_operation("open").unwrap(), &original);
        assert_eq!(
            load(&store.connection, "space-demo").unwrap()["open"],
            original
        );
        assert_eq!(event_count(&store), 1);
    }

    #[test]
    fn unknown_open_blocks_new_open_until_bound_and_still_allows_explicit_close() {
        let mut store = store();
        let (unknown, _) = store
            .reserve_commissioning(request("lost", 60), coordinator(), at())
            .unwrap();
        assert_eq!(
            unknown.blocked_until,
            at() + chrono::Duration::milliseconds(60500)
        );
        assert_eq!(
            store
                .reserve_commissioning(request("new", 60), coordinator(), at())
                .unwrap_err()
                .code,
            "zigbee_operation_unresolved"
        );
        let (close, _) = store
            .reserve_commissioning(request("close", 0), coordinator(), at())
            .unwrap();
        assert_eq!(close.request.change.duration_seconds, 0);
        store
            .finish_commissioning("close", Err(err("znp_timeout")), at())
            .unwrap();
        let after = unknown.blocked_until + chrono::Duration::milliseconds(1);
        assert!(
            store
                .reserve_commissioning(request("later", 1), coordinator(), after)
                .unwrap()
                .1
        );
        assert_eq!(store.commissioning_operation("lost").unwrap(), &unknown);
    }

    #[test]
    fn disk_reopen_keeps_unknown_and_completed_records_without_changing_snapshot_version() {
        let path =
            std::env::temp_dir().join(format!("limeiot-commission-{}.sqlite", limeiot_core::id()));
        let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
        store
            .reserve_commissioning(request("lost", 60), coordinator(), at())
            .unwrap();
        store
            .reserve_commissioning(request("close", 0), coordinator(), at())
            .unwrap();
        store
            .finish_commissioning("close", Ok(receipt(0)), at())
            .unwrap();
        let saved = store.commissioning.clone();
        let version = store.snapshot_version;
        drop(store);
        let store = Store::open(path.to_str().unwrap(), config()).unwrap();
        assert_eq!(store.commissioning, saved);
        assert_eq!(store.snapshot_version, version);
        assert_eq!(event_count(&store), 3);
        drop(store);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn mismatched_receipts_and_rewritten_history_fail_closed() {
        let mut store = store();
        store
            .reserve_commissioning(request("open", 60), coordinator(), at())
            .unwrap();
        assert_eq!(
            store
                .finish_commissioning("open", Ok(receipt(0)), at())
                .unwrap_err()
                .code,
            "invalid_zigbee_operation"
        );
        assert_eq!(event_count(&store), 1);
        let completed = store
            .finish_commissioning("open", Ok(receipt(60)), at())
            .unwrap();
        assert_eq!(
            store
                .finish_commissioning("open", Ok(receipt(60)), at())
                .unwrap_err()
                .code,
            "zigbee_operation_completed"
        );
        let mut invalid = completed;
        invalid.operation_id = "rewritten".into();
        store
            .connection
            .execute(
                "UPDATE events SET data=?1 WHERE id=(SELECT max(id) FROM events WHERE type=?2)",
                params![
                    serde_json::to_string(&json!({"data":invalid})).unwrap(),
                    EVENT
                ],
            )
            .unwrap();
        assert_eq!(
            load(&store.connection, "space-demo").unwrap_err().code,
            "storage_corrupt"
        );
    }

    #[test]
    fn capacity_preserves_original_lookup_and_invalid_changes_do_not_reserve() {
        let mut store = store();
        for key in 0..MAX_OPERATIONS {
            store
                .reserve_commissioning(request(&format!("close-{key}"), 0), coordinator(), at())
                .unwrap();
        }
        assert_eq!(
            store
                .reserve_commissioning(request("full", 0), coordinator(), at())
                .unwrap_err()
                .code,
            "zigbee_operation_capacity"
        );
        assert!(
            !store
                .reserve_commissioning(request("close-0", 0), coordinator(), at())
                .unwrap()
                .1
        );
        assert_eq!(
            load(&store.connection, "space-demo").unwrap().len(),
            MAX_OPERATIONS
        );
        for bytes in [
            br#"{"coordinator_id":"home-znp","coordinator_id":"other","duration_seconds":60}"#
                .as_slice(),
            br#"{"coordinator_id":"home-znp","duration_seconds":255}"#,
            br#"{}"#,
        ] {
            assert!(crate::commissioning::parse_change(bytes).is_err());
        }
    }
}
