use limeiot_core::{
    digest,
    engine::{Config, Data},
    ensure, err, Result,
};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};

pub struct Store {
    connection: Connection,
    pub data: Data,
    config_hash: String,
    snapshot_version: u32,
}
#[cfg(test)]
#[path = "execution_plan_store_tests.rs"]
mod execution_plan_store_tests;
#[cfg(test)]
#[path = "rule_condition_tests.rs"]
mod rule_condition_tests;
#[cfg(test)]
#[path = "rule_schedule_tests.rs"]
mod rule_schedule_tests;
impl Store {
    pub fn open(path: &str, config: Config) -> Result<Self> {
        let connection = Connection::open(path).map_err(|_| err("storage_unavailable"))?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, config_hash TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, data TEXT NOT NULL);").map_err(|_|err("storage_unavailable"))?;
        let config_hash = digest(&config)?;
        let mut snapshot_version = 10;
        let data: Data = match connection.query_row(
            "SELECT version,config_hash,body FROM snapshot WHERE id=1",
            [],
            |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        ) {
            Ok((version, hash, body)) => {
                snapshot_version = version.max(10);
                ensure(
                    matches!(version, 1..=12) && hash == config_hash,
                    "storage_config_mismatch",
                )?;
                let value: Value =
                    serde_json::from_str(&body).map_err(|_| err("storage_corrupt"))?;
                ensure(
                    value.get("model_registry").is_some() == (version >= 2)
                        && value.get("ota_registry").is_some() == (version >= 3)
                        && value.get("execution_registry").is_some() == (version >= 6),
                    "storage_corrupt",
                )?;
                ensure(
                    value.get("execution_plans").is_some() == (version >= 12),
                    "storage_corrupt",
                )?;
                if version >= 3 {
                    let tasks = value["ota_registry"]["tasks"]
                        .as_object()
                        .ok_or_else(|| err("storage_corrupt"))?;
                    ensure(
                        tasks
                            .values()
                            .all(|task| task.get("execution").is_some() == (version >= 4)),
                        "storage_corrupt",
                    )?;
                }
                if version < 5 {
                    ensure(
                        value["devices"].as_object().is_some_and(|devices| {
                            devices
                                .values()
                                .all(|device| device.get("routes").is_none())
                        }) && value["commands"].as_object().is_some_and(|commands| {
                            commands
                                .values()
                                .all(|command| command.get("execution_route").is_none())
                        }),
                        "storage_corrupt",
                    )?;
                }
                if version == 6 {
                    ensure(
                        value["execution_registry"]["bindings"]
                            .as_object()
                            .is_some_and(|bindings| {
                                bindings
                                    .values()
                                    .all(|binding| binding.get("native_paths").is_none())
                            })
                            && value["execution_registry"]["operations"]
                                .as_object()
                                .is_some_and(|operations| {
                                    operations.values().all(|operation| {
                                        operation["request"]["change"]["type"] != "bindings.compose"
                                            && operation["result"].get("native_paths").is_none()
                                    })
                                }),
                        "storage_corrupt",
                    )?;
                }
                if version < 8 {
                    let registry = &value["model_registry"];
                    ensure(
                        registry["bindings"].as_object().is_none_or(|bindings| {
                            bindings
                                .values()
                                .all(|binding| binding.get("bundle_id").is_none())
                        }) && registry["operations"].as_object().is_none_or(|operations| {
                            operations.values().all(|operation| {
                                operation["request"]["change"]["type"] != "devices.bind-bundle"
                                    && operation["result"]["value"].get("bundle_id").is_none()
                            })
                        }),
                        "storage_corrupt",
                    )?;
                }
                if version < 9 {
                    ensure(
                        value["deployments"].as_object().is_some_and(|deployments| {
                            deployments
                                .values()
                                .all(|d| d["rule"]["trigger"].get("property").is_none())
                        }) && value["runs"].as_object().is_some_and(|runs| {
                            runs.values()
                                .all(|run| run.get("property_trigger").is_none())
                        }) && value["rule_drafts"].as_object().is_none_or(|drafts| {
                            drafts
                                .values()
                                .all(|draft| draft["rule"]["trigger"].get("property").is_none())
                        }),
                        "storage_corrupt",
                    )?;
                }
                if version < 10 {
                    ensure(
                        value["deployments"].as_object().is_some_and(|items| {
                            items.values().all(|d| {
                                d["rule"]["conditions"]
                                    .as_array()
                                    .is_some_and(Vec::is_empty)
                            })
                        }) && value["runs"].as_object().is_some_and(|items| {
                            items
                                .values()
                                .all(|r| r.get("condition_evaluation").is_none())
                        }) && value["rule_drafts"].as_object().is_none_or(|items| {
                            items.values().all(|d| {
                                d["rule"].is_null()
                                    || d["rule"]["conditions"]
                                        .as_array()
                                        .is_some_and(Vec::is_empty)
                            })
                        }),
                        "storage_corrupt",
                    )?;
                }
                if version < 11 {
                    ensure(
                        value["deployments"].as_object().is_some_and(|items| {
                            items.values().all(|d| {
                                d["rule"]["trigger"].get("schedule").is_none()
                                    && d.get("schedule_cursor").is_none()
                            })
                        }) && value["runs"].as_object().is_some_and(|items| {
                            items.values().all(|r| r.get("schedule_trigger").is_none())
                        }) && value["rule_drafts"].as_object().is_none_or(|items| {
                            items
                                .values()
                                .all(|d| d["rule"]["trigger"].get("schedule").is_none())
                        }),
                        "storage_corrupt",
                    )?;
                }
                serde_json::from_str(&body).map_err(|_| err("storage_corrupt"))?
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Data::new(config)?,
            Err(_) => return Err(err("storage_unavailable")),
        };
        let data = data.with_model_bundles(crate::model_bundles::catalog()?);
        data.validate_model_registry(chrono::Utc::now())
            .map_err(|_| err("storage_corrupt"))?;
        data.validate_ota_registry()
            .map_err(|_| err("storage_corrupt"))?;
        data.validate_execution_routes()
            .map_err(|_| err("storage_corrupt"))?;
        data.validate_execution_registry()
            .map_err(|_| err("storage_corrupt"))?;
        data.validate_command_receipts()
            .map_err(|_| err("storage_corrupt"))?;
        data.validate_rule_graph()
            .map_err(|_| err("storage_corrupt"))?;
        data.validate_saved_conditions()
            .map_err(|_| err("storage_corrupt"))?;
        data.validate_saved_schedules()
            .map_err(|_| err("storage_corrupt"))?;
        data.validate_execution_plan_registry()
            .map_err(|_| err("storage_corrupt"))?;
        let mut store = Self {
            connection,
            data,
            config_hash,
            snapshot_version,
        };
        store.update("gateway.recovered", |data| {
            data.recover();
            Ok(json!({"recovered":true}))
        })?;
        Ok(store)
    }
    // 先提交耐久快照和事件，再公布内存状态；校验或写盘失败不留下半次修改。
    pub fn update<T: Serialize>(
        &mut self,
        kind: &str,
        apply: impl FnOnce(&mut Data) -> Result<T>,
    ) -> Result<T> {
        let mut next = self.data.clone();
        let output = apply(&mut next)?;
        let body = serde_json::to_string(&next).map_err(|_| err("invalid_json"))?;
        let before = serde_json::to_string(&self.data).map_err(|_| err("invalid_json"))?;
        if body == before && kind != "gateway.recovered" {
            // 仅清理会话观测等临时数据时，不写库，但仍公布本次内存变更。
            self.data = next;
            return Ok(output);
        }
        let event = serde_json::to_string(&json!({"occurred_at":chrono::Utc::now(),"data":output}))
            .map_err(|_| err("invalid_json"))?;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| err("storage_unavailable"))?;
        let version = if !next.execution_plans.is_empty() || self.snapshot_version >= 12 {
            12
        } else if next
            .deployments
            .values()
            .any(|d| d.schedule_cursor.is_some())
            || next.runs.values().any(|r| r.schedule_trigger.is_some())
        {
            11
        } else {
            self.snapshot_version
        };
        transaction.execute("INSERT INTO snapshot(id,version,config_hash,body) VALUES(1,?1,?2,?3) ON CONFLICT(id) DO UPDATE SET version=excluded.version,body=excluded.body",params![version,self.config_hash,body]).map_err(|_|err("storage_unavailable"))?;
        transaction
            .execute(
                "INSERT INTO events(type,data) VALUES(?1,?2)",
                params![kind, event],
            )
            .map_err(|_| err("storage_unavailable"))?;
        transaction
            .execute(
                "DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id),0)-5000 FROM events)",
                [],
            )
            .map_err(|_| err("storage_unavailable"))?;
        transaction
            .commit()
            .map_err(|_| err("storage_unavailable"))?;
        self.data = next;
        self.snapshot_version = version;
        Ok(output)
    }
    pub fn events(&self, after: i64) -> Result<Vec<Value>> {
        let oldest: i64 = self
            .connection
            .query_row("SELECT COALESCE(MIN(id),0) FROM events", [], |r| r.get(0))
            .map_err(|_| err("storage_unavailable"))?;
        ensure(after == 0 || after >= oldest - 1, "event_gap")?;
        let mut statement = self
            .connection
            .prepare("SELECT id,type,data FROM events WHERE id>?1 ORDER BY id LIMIT 100")
            .map_err(|_| err("storage_unavailable"))?;
        let rows = statement
            .query_map([after], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|_| err("storage_unavailable"))?;
        rows.map(|row|{
            let (id,kind,body)=row.map_err(|_|err("storage_unavailable"))?;
            Ok(json!({"event_id":id,"type":kind,"space_id":self.data.space_id,"payload":serde_json::from_str::<Value>(&body).map_err(|_|err("storage_corrupt"))?}))
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bundle_config() -> Config {
        let bundle = crate::model_bundles::catalog().unwrap().list()[0].clone();
        serde_json::from_value(json!({"space_id":"home","models":[bundle.model],
            "devices":[{"device_id":"tv","model_revision":bundle.model_revision}]}))
        .unwrap()
    }
    fn bind_bundle_request(data: &Data) -> limeiot_core::model_registry::Request {
        limeiot_core::model_registry::Request {
            space_id: data.space_id.clone(),
            idempotency_key: "original-bundle".into(),
            change: limeiot_core::model_registry::Change::BindBundle {
                device_id: "tv".into(),
                bundle_id: crate::model_bundles::catalog().unwrap().list()[1]
                    .bundle_id
                    .clone(),
                expected_model_revision: Some(data.devices["tv"].model_revision.clone()),
                expected_binding_revision: None,
            },
        }
    }
    #[test]
    fn v7_upgrades_and_bundle_binding_and_original_decision_survive_v8_restart() {
        let path = std::env::temp_dir().join(format!(
            "limeiot-bundle-recovery-{}.sqlite",
            limeiot_core::id()
        ));
        let config = bundle_config();
        let store = Store::open(path.to_str().unwrap(), config.clone()).unwrap();
        store
            .connection
            .execute("UPDATE snapshot SET version=7", [])
            .unwrap();
        drop(store);
        let mut store = Store::open(path.to_str().unwrap(), config.clone()).unwrap();
        let version: i64 = store
            .connection
            .query_row("SELECT version FROM snapshot", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 10);
        let request = bind_bundle_request(&store.data);
        let original = store
            .update("model.operation", |data| {
                data.apply_model_change(request.clone(), chrono::Utc::now())
            })
            .unwrap();
        assert_eq!(original.status, "applied");
        let binding = serde_json::to_value(&store.data.model_registry.bindings["tv"]).unwrap();
        let original = serde_json::to_value(original).unwrap();
        drop(store);
        let mut store = Store::open(path.to_str().unwrap(), config).unwrap();
        assert_eq!(
            serde_json::to_value(&store.data.model_registry.bindings["tv"]).unwrap(),
            binding
        );
        assert!(!store.data.devices["tv"].ready);
        let before = serde_json::to_value(&store.data).unwrap();
        let events = store.events(0).unwrap().len();
        let replay = store
            .update("model.operation", |data| {
                data.apply_model_change(request, chrono::Utc::now())
            })
            .unwrap();
        assert_eq!(serde_json::to_value(replay).unwrap(), original);
        assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
        assert_eq!(store.events(0).unwrap().len(), events);
    }
    #[test]
    fn bundle_commit_failure_publishes_no_model_binding_decision_or_event() {
        let mut store = Store::open(":memory:", bundle_config()).unwrap();
        let request = bind_bundle_request(&store.data);
        let before = serde_json::to_value(&store.data).unwrap();
        let events = store.events(0).unwrap().len();
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        let error = store
            .update("model.operation", |data| {
                data.apply_model_change(request, chrono::Utc::now())
            })
            .unwrap_err();
        assert_eq!(error.code, "storage_unavailable");
        assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
        let raw: String = store
            .connection
            .query_row("SELECT body FROM snapshot", [], |r| r.get(0))
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), before);
        assert_eq!(store.events(0).unwrap().len(), events);
    }
    #[test]
    fn legacy_signed_binding_upgrades_unchanged_and_its_revocation_does_not_revoke_bundle() {
        use limeiot_core::model_registry::{Change, Request};
        let path = std::env::temp_dir().join(format!(
            "limeiot-legacy-source-{}.sqlite",
            limeiot_core::id()
        ));
        let config = bundle_config();
        let mut store = Store::open(path.to_str().unwrap(), config.clone()).unwrap();
        let vector: Value = serde_json::from_str(include_str!(
            "../../../../contracts/examples/model-release.json"
        ))
        .unwrap();
        let apply = |store: &mut Store, key: &str, change: Change| {
            store
                .update("model.operation", |data| {
                    data.apply_model_change(
                        Request {
                            space_id: "home".into(),
                            idempotency_key: key.into(),
                            change,
                        },
                        chrono::Utc::now(),
                    )
                })
                .unwrap()
        };
        let trust = apply(
            &mut store,
            "trust",
            Change::TrustAdd {
                trust: vector["trust"].clone(),
                expected_signing_key_id: vector["trust"]["signing_key_id"].as_str().unwrap().into(),
            },
        );
        let trust = serde_json::to_value(trust.result.unwrap()).unwrap()["value"].clone();
        let installed = apply(
            &mut store,
            "install",
            Change::Install {
                trust_id: trust["trust_id"].as_str().unwrap().into(),
                artifact: vector["artifact"].clone(),
                expected_release_id: None,
            },
        );
        let installed = serde_json::to_value(installed.result.unwrap()).unwrap()["value"].clone();
        let bound = apply(
            &mut store,
            "bind",
            Change::Bind {
                device_id: "legacy".into(),
                installation_id: installed["installation_id"].as_str().unwrap().into(),
                expected_model_revision: None,
                expected_binding_revision: None,
            },
        );
        assert_eq!(bound.status, "applied");
        let old = serde_json::to_value(&store.data.model_registry.bindings["legacy"]).unwrap();
        assert!(old.get("bundle_id").is_none());
        store
            .connection
            .execute("UPDATE snapshot SET version=7", [])
            .unwrap();
        drop(store);
        let mut store = Store::open(path.to_str().unwrap(), config).unwrap();
        assert_eq!(
            serde_json::to_value(&store.data.model_registry.bindings["legacy"]).unwrap(),
            old
        );
        assert!(store.data.check_model_authority("legacy").is_ok());
        let request = bind_bundle_request(&store.data);
        store
            .update("model.operation", |data| {
                data.apply_model_change(request, chrono::Utc::now())
            })
            .unwrap();
        let revoked = apply(
            &mut store,
            "revoke",
            Change::TrustRevoke {
                trust_id: trust["trust_id"].as_str().unwrap().into(),
                expected_revision: trust["revision"].as_str().unwrap().into(),
            },
        );
        assert_eq!(revoked.status, "applied");
        assert_eq!(
            store.data.check_model_authority("legacy").unwrap_err().code,
            "model_trust_revoked"
        );
        assert!(store.data.check_model_authority("tv").is_ok());
        drop(store);
        let store = Store::open(path.to_str().unwrap(), bundle_config()).unwrap();
        assert!(store.data.check_model_authority("tv").is_ok());
        assert!(store.data.check_model_authority("legacy").is_err());
    }
    #[test]
    fn hidden_bundle_sources_and_corrupt_or_future_snapshots_fail_without_rewriting() {
        let config = bundle_config();
        let mut fixture = Data::new(config.clone())
            .unwrap()
            .with_model_bundles(crate::model_bundles::catalog().unwrap());
        fixture
            .apply_model_change(bind_bundle_request(&fixture), chrono::Utc::now())
            .unwrap();
        let original = serde_json::to_value(fixture).unwrap();
        let mut cases = Vec::new();
        for version in 1..=7 {
            // 新来源不能藏入旧快照；v1连模型注册表也不可携带。
            let mut body = original.clone();
            if version < 6 {
                body.as_object_mut().unwrap().remove("execution_registry");
            }
            if version < 5 {
                body["devices"]["tv"]
                    .as_object_mut()
                    .unwrap()
                    .remove("routes");
            }
            if version < 3 {
                body.as_object_mut().unwrap().remove("ota_registry");
            }
            cases.push((version, body, "storage_corrupt"));
        }
        // 分别证明当前来源、原请求和原结果的门禁，不能只靠某一字段碰巧失败。
        let mut binding_only = original.clone();
        binding_only["model_registry"]["operations"] = json!({});
        cases.push((7, binding_only, "storage_corrupt"));
        let mut request_only = original.clone();
        request_only["model_registry"]["bindings"] = json!({});
        let op = &mut request_only["model_registry"]["operations"]["original-bundle"];
        op["status"] = json!("rejected");
        op["reason"] = json!("revision_conflict");
        op["result"] = Value::Null;
        cases.push((7, request_only, "storage_corrupt"));
        let mut result_only = original.clone();
        result_only["model_registry"]["bindings"] = json!({});
        let op = &mut result_only["model_registry"]["operations"]["original-bundle"];
        op["request"]["change"] = json!({"type":"devices.bind","device_id":"tv","installation_id":format!("install-{}","0".repeat(64)),"expected_model_revision":null,"expected_binding_revision":null});
        op["request_digest"] = json!(digest(&op["request"]).unwrap());
        cases.push((7, result_only, "storage_corrupt"));
        let mut corrupt = original.clone();
        corrupt["model_registry"]["bindings"]["tv"]["bundle_id"] =
            json!(format!("bundle-{}", "0".repeat(64)));
        cases.push((8, corrupt, "storage_corrupt"));
        cases.push((13, original, "storage_config_mismatch"));
        for (version, body, expected) in cases {
            let path = std::env::temp_dir().join(format!(
                "limeiot-bundle-reject-{}.sqlite",
                limeiot_core::id()
            ));
            let store = Store::open(path.to_str().unwrap(), config.clone()).unwrap();
            let raw = body.to_string();
            store
                .connection
                .execute(
                    "UPDATE snapshot SET version=?1,body=?2",
                    params![version, raw],
                )
                .unwrap();
            let events = store.events(0).unwrap().len();
            drop(store);
            assert_eq!(
                Store::open(path.to_str().unwrap(), config.clone())
                    .err()
                    .unwrap()
                    .code,
                expected,
                "version {version}"
            );
            let disk = Connection::open(path).unwrap();
            let saved: (i64, String) = disk
                .query_row("SELECT version,body FROM snapshot", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap();
            assert_eq!(saved, (version, raw));
            let count: i64 = disk
                .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
                .unwrap();
            assert_eq!(count as usize, events);
        }
    }
    #[test]
    fn receipt_ack_is_not_released_when_original_result_transaction_fails() {
        use limeiot_core::protocol::{CommandRequest, Envelope};
        let model: Value = serde_json::from_slice(include_bytes!(
            "../../../../contracts/models/android-tv-agent.json"
        ))
        .unwrap();
        let config: Config = serde_json::from_value(json!({"space_id":"home","models":[model],"devices":[{"device_id":"tv","model_revision":digest(&model).unwrap()}]})).unwrap();
        let mut store = Store::open(":memory:", config).unwrap();
        let now = chrono::Utc::now();
        let revision = store.data.devices["tv"].model_revision.clone();
        let hello: Envelope = serde_json::from_value(json!({"v":1,"kind":"hello","message_id":"hello","device_id":"tv","model_revision":revision,"boot_id":"boot-tv","seq":1,"body":{"challenge":"challenge","receipt_ledger":1}})).unwrap();
        let welcome = store
            .update("device.hello", |data| data.ingest(hello, now))
            .unwrap()
            .unwrap();
        let session = welcome.session_id;
        let state: Envelope = serde_json::from_value(json!({"v":1,"kind":"state","message_id":"state","device_id":"tv","model_revision":revision,"boot_id":"boot-tv","session_id":session,"seq":2,"body":{"type":"snapshot","revision":1,"properties":[]}})).unwrap();
        store
            .update("device.state", |data| data.ingest(state, now))
            .unwrap();
        let request: CommandRequest = serde_json::from_value(json!({"space_id":"home","device_id":"tv","model_revision":revision,"idempotency_key":"launch","expires_at":now+chrono::Duration::seconds(20),"operation":{"type":"action.invoke","path":"apps.launch","value":{"application_id":"com.example.player"}}})).unwrap();
        let command = store
            .update("commands.created", |data| {
                data.create_command(request, now, None)
            })
            .unwrap();
        store
            .update("commands.transitioned", |data| {
                Ok(data.prepare_dispatch(now))
            })
            .unwrap();
        let report: Envelope = serde_json::from_value(json!({"v":1,"kind":"result","message_id":"result","device_id":"tv","model_revision":revision,"boot_id":"boot-tv","session_id":session,"seq":3,"body":{"command_id":command.command_id,"status":"confirmed","evidence":{"type":"action_result","path":"apps.launch","input_digest":digest(&command.request.operation.value).unwrap(),"completion":"submitted","output":{},"observed_at":now}}})).unwrap();
        let before = serde_json::to_value(&store.data).unwrap();
        store.connection.execute_batch("CREATE TRIGGER fail_receipt BEFORE INSERT ON events WHEN NEW.type='device.result' BEGIN SELECT RAISE(ABORT,'injected'); END").unwrap();
        assert_eq!(
            store
                .update("device.result", |data| data.ingest(report.clone(), now))
                .unwrap_err()
                .code,
            "storage_unavailable"
        );
        assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
        let saved: String = store
            .connection
            .query_row("SELECT body FROM snapshot", [], |row| row.get(0))
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), before);
        store
            .connection
            .execute_batch("DROP TRIGGER fail_receipt")
            .unwrap();
        let ack = store
            .update("device.result", |data| data.ingest(report, now))
            .unwrap()
            .unwrap();
        assert_eq!(ack.kind, "receipt");
        let saved: String = store
            .connection
            .query_row("SELECT body FROM snapshot", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&saved).unwrap()["commands"][&command.command_id]
                ["status"],
            "confirmed"
        );
    }

    fn config() -> Config {
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap()
    }
    fn adapter_config() -> Config {
        let model: limeiot_core::model::Model = serde_json::from_slice(include_bytes!(
            "../../../../contracts/models/android-tv-remote.json"
        ))
        .unwrap();
        let route = limeiot_core::execution::Route {
            adapter_id: "test-adb".into(),
            revision: format!("sha256:{}", "a".repeat(64)),
        };
        serde_json::from_value(json!({"space_id":"home","models":[model],"devices":[{
            "device_id":"tv","model_revision":digest(&model).unwrap(),"routes":{"remote.press":route}}]})).unwrap()
    }
    fn adapter_store() -> (Store, limeiot_core::engine::Command) {
        let mut store = Store::open(":memory:", adapter_config()).unwrap();
        let route = store.data.devices["tv"].routes["remote.press"].clone();
        let now = chrono::Utc::now();
        store
            .update("adapter.seen", |data| {
                data.adapter_seen("tv", &route, "adapter-session", now)
            })
            .unwrap();
        let request = serde_json::from_value(json!({"space_id":"home","device_id":"tv","model_revision":store.data.devices["tv"].model_revision,
            "idempotency_key":"press","expires_at":now+chrono::Duration::seconds(5),
            "operation":{"type":"action.invoke","path":"remote.press","value":{"key":"home"}}})).unwrap();
        let command = store
            .update("command.created", |data| {
                data.create_command(request, now, None)
            })
            .unwrap();
        (store, command)
    }
    #[test]
    fn adapter_dispatch_commit_failure_returns_no_work_and_result_failure_preserves_original_attempt(
    ) {
        let (mut store, command) = adapter_store();
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        let dispatch = store.update("commands.transitioned", |data| {
            Ok(data.prepare_adapter_dispatch("test-adb", chrono::Utc::now()))
        });
        assert_eq!(dispatch.unwrap_err().code, "storage_unavailable");
        assert_eq!(store.data.commands[&command.command_id].status, "accepted");
        store
            .connection
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        let work = store
            .update("commands.transitioned", |data| {
                Ok(data.prepare_adapter_dispatch("test-adb", chrono::Utc::now()))
            })
            .unwrap();
        assert_eq!(work.len(), 1);
        let receipt = limeiot_core::execution::AdapterReceipt {
            command_id: command.command_id.clone(),
            route: command.execution_route.clone().unwrap(),
            session_id: command.envelope.session_id.clone().unwrap(),
            request_digest: command.request_digest,
            status: "confirmed".into(),
            error: None,
            observed_at: chrono::Utc::now(),
        };
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert_eq!(
            store
                .update("adapter.result", |data| data
                    .apply_adapter_result(receipt, chrono::Utc::now()))
                .unwrap_err()
                .code,
            "storage_unavailable"
        );
        assert_eq!(
            store.data.commands[&command.command_id].status,
            "dispatched"
        );
        assert!(store
            .data
            .prepare_adapter_dispatch("test-adb", chrono::Utc::now())
            .is_empty());
        store.data.recover();
        assert_eq!(store.data.commands[&command.command_id].status, "unknown");
    }
    #[test]
    fn v4_snapshot_upgrades_but_cannot_hide_external_routes_in_the_legacy_format() {
        let path = std::env::temp_dir().join(format!("limeiot-v5-{}.sqlite", limeiot_core::id()));
        {
            let store = Store::open(path.to_str().unwrap(), config()).unwrap();
            store
                .connection
                .execute(
                    "UPDATE snapshot SET version=4,body=json_remove(body, '$.execution_registry')",
                    [],
                )
                .unwrap();
        }
        {
            let store = Store::open(path.to_str().unwrap(), config()).unwrap();
            assert_eq!(
                store
                    .connection
                    .query_row("SELECT version FROM snapshot", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                10
            );
            let mut body = serde_json::to_value(&store.data).unwrap();
            body.as_object_mut().unwrap().remove("execution_registry");
            body["devices"]["device-lamp"]["routes"] = json!({});
            store
                .connection
                .execute("UPDATE snapshot SET version=4,body=?1", [body.to_string()])
                .unwrap();
        }
        assert!(
            matches!(Store::open(path.to_str().unwrap(),config()),Err(error) if error.code=="storage_corrupt")
        );
        let connection = Connection::open(path).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT version FROM snapshot", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            4
        );
    }
    #[test]
    fn incompatible_adapter_output_in_saved_snapshot_is_rejected_without_rewrite() {
        let path = std::env::temp_dir().join(format!(
            "limeiot-route-output-{}.sqlite",
            limeiot_core::id()
        ));
        let saved;
        let event_count;
        {
            let store = Store::open(path.to_str().unwrap(), adapter_config()).unwrap();
            let mut data = store.data.clone();
            let mut model = data.models[&data.devices["tv"].model_revision].clone();
            model.services[0].actions[0].output = serde_json::from_value(json!({
                "type":"object","properties":{"status":{"type":"boolean"}},
                "required":["status"],"additionalProperties":false
            }))
            .unwrap();
            model.validate().unwrap();
            let revision = digest(&model).unwrap();
            data.models.insert(revision.clone(), model);
            data.devices.get_mut("tv").unwrap().model_revision = revision;
            saved = serde_json::to_string(&data).unwrap();
            event_count = store
                .connection
                .query_row("SELECT COUNT(*) FROM events", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap();
            store
                .connection
                .execute("UPDATE snapshot SET body=?1", [&saved])
                .unwrap();
        }
        assert!(
            matches!(Store::open(path.to_str().unwrap(), adapter_config()),Err(error) if error.code=="storage_corrupt")
        );
        let connection = Connection::open(path).unwrap();
        let (version, body) = connection
            .query_row("SELECT version,body FROM snapshot", [], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap();
        assert_eq!(version, 10);
        assert_eq!(body, saved);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM events", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            event_count
        );
    }
    #[test]
    fn execution_binding_and_revoke_commit_failure_preserve_original_state() {
        use limeiot_core::execution_binding::{Change, Offer, Request};
        let mut store = Store::open(":memory:", adapter_config()).unwrap();
        let view = store.data.execution_binding("tv").unwrap();
        let offer = Offer {
            device_id: "tv".into(),
            route: view.routes["remote.press"].clone(),
            model_revision: view.model_revision.clone(),
            paths: ["remote.press".into(), "apps.launch".into()].into(),
        };
        let request = Request {
            space_id: "home".into(),
            idempotency_key: "bind".into(),
            change: Change::Bind {
                device_id: "tv".into(),
                route: offer.route.clone(),
                expected_binding_revision: view.revision.clone(),
                expected_model_revision: view.model_revision.clone(),
            },
        };
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert_eq!(
            store
                .update("execution.operation", |data| data.apply_execution_change(
                    request.clone(),
                    Some(&offer),
                    chrono::Utc::now()
                ))
                .unwrap_err()
                .code,
            "storage_unavailable"
        );
        assert!(store.data.execution_registry.operations.is_empty());
        assert_eq!(
            store.data.execution_binding("tv").unwrap().revision,
            view.revision
        );
        store
            .connection
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        store
            .update("execution.operation", |data| {
                data.apply_execution_change(request, Some(&offer), chrono::Utc::now())
            })
            .unwrap();
        let bound = store.data.execution_binding("tv").unwrap();
        let events = store.events(0).unwrap().len();
        let revoke = Request {
            space_id: "home".into(),
            idempotency_key: "revoke".into(),
            change: Change::Revoke {
                device_id: "tv".into(),
                expected_binding_revision: bound.revision.clone(),
            },
        };
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert_eq!(
            store
                .update("execution.operation", |data| data.apply_execution_change(
                    revoke,
                    None,
                    chrono::Utc::now()
                ))
                .unwrap_err()
                .code,
            "storage_unavailable"
        );
        assert_eq!(
            store.data.execution_binding("tv").unwrap().revision,
            bound.revision
        );
        assert!(store.data.execution_operation("revoke").is_err());
        assert_eq!(store.events(0).unwrap().len(), events);
    }
    #[test]
    fn composed_plan_commit_failure_and_recovery_preserve_exact_routes() {
        use limeiot_core::{
            execution_binding::{Change, Offer, Request},
            protocol::Envelope,
        };
        let path =
            std::env::temp_dir().join(format!("limeiot-composed-{}.sqlite", limeiot_core::id()));
        let config = adapter_config();
        let mut store = Store::open(path.to_str().unwrap(), config.clone()).unwrap();
        let now = chrono::Utc::now();
        let model = store.data.devices["tv"].model_revision.clone();
        let hello:Envelope=serde_json::from_value(json!({"v":1,"kind":"hello","message_id":"hello","device_id":"tv","model_revision":model,
            "boot_id":"boot","seq":1,"body":{"challenge":"challenge","execution_paths":["apps.launch"]}})).unwrap();
        let welcome = store
            .update("device.hello", |data| data.ingest(hello, now))
            .unwrap()
            .unwrap();
        let state:Envelope=serde_json::from_value(json!({"v":1,"kind":"state","message_id":"state","device_id":"tv","model_revision":model,
            "boot_id":"boot","session_id":welcome.session_id,"seq":2,"body":{"type":"snapshot","revision":1,"properties":[]}})).unwrap();
        store
            .update("device.state", |data| data.ingest(state, now))
            .unwrap();
        let before = store.data.execution_binding("tv").unwrap();
        let offer = Offer {
            device_id: "tv".into(),
            route: before.routes["remote.press"].clone(),
            model_revision: model.clone(),
            paths: ["remote.press".into(), "apps.launch".into()].into(),
        };
        let request = Request {
            space_id: "home".into(),
            idempotency_key: "compose".into(),
            change: Change::Compose {
                device_id: "tv".into(),
                route: offer.route.clone(),
                native_paths: ["apps.launch".into()].into(),
                expected_native_session: welcome.session_id.unwrap(),
                expected_binding_revision: before.revision.clone(),
                expected_model_revision: model,
            },
        };
        let saved: String = store
            .connection
            .query_row("SELECT body FROM snapshot", [], |row| row.get(0))
            .unwrap();
        let events = store.events(0).unwrap().len();
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert_eq!(
            store
                .update("execution.operation", |data| data.apply_execution_change(
                    request.clone(),
                    Some(&offer),
                    now
                ))
                .unwrap_err()
                .code,
            "storage_unavailable"
        );
        assert_eq!(
            store.data.execution_binding("tv").unwrap().revision,
            before.revision
        );
        assert!(store.data.execution_registry.operations.is_empty());
        assert_eq!(store.events(0).unwrap().len(), events);
        let unchanged: String = store
            .connection
            .query_row("SELECT body FROM snapshot", [], |row| row.get(0))
            .unwrap();
        assert_eq!(unchanged, saved);
        store
            .connection
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        assert_eq!(
            store
                .update("execution.operation", |data| data.apply_execution_change(
                    request,
                    Some(&offer),
                    now
                ))
                .unwrap()
                .status,
            "applied"
        );
        let revision = store.data.execution_binding("tv").unwrap().revision;
        drop(store);
        let reopened = Store::open(path.to_str().unwrap(), config).unwrap();
        let view = reopened.data.execution_binding("tv").unwrap();
        assert_eq!(view.revision, revision);
        assert_eq!(view.state, "composed");
        assert_eq!(view.routes.len(), 1);
        assert!(view.routes.contains_key("remote.press"));
        assert_eq!(view.native_paths, Some(["apps.launch".into()].into()));
        assert!(!reopened.data.devices["tv"].ready);
        assert!(reopened.data.devices["tv"].native_actions.is_none());
        let version: i64 = reopened
            .connection
            .query_row("SELECT version FROM snapshot", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 10);
    }

    #[test]
    fn v6_upgrades_without_capabilities_and_hidden_composition_does_not_rewrite() {
        let path = std::env::temp_dir().join(format!(
            "limeiot-composition-version-{}.sqlite",
            limeiot_core::id()
        ));
        let config = adapter_config();
        let store = Store::open(path.to_str().unwrap(), config.clone()).unwrap();
        store
            .connection
            .execute("UPDATE snapshot SET version=6", [])
            .unwrap();
        drop(store);
        let store = Store::open(path.to_str().unwrap(), config.clone()).unwrap();
        let version: i64 = store
            .connection
            .query_row("SELECT version FROM snapshot", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 10);
        let before = store.data.execution_binding("tv").unwrap();
        let mut body: Value = serde_json::from_str(
            &store
                .connection
                .query_row::<String, _, _>("SELECT body FROM snapshot", [], |row| row.get(0))
                .unwrap(),
        )
        .unwrap();
        body["execution_registry"]["bindings"]["tv"] = json!({"device_id":"tv","generation":"generation","route":before.routes["remote.press"],"changed_at":chrono::Utc::now(),"native_paths":["apps.launch"]});
        body["devices"]["tv"]["routes"]
            .as_object_mut()
            .unwrap()
            .remove("apps.launch");
        let saved = serde_json::to_string(&body).unwrap();
        store
            .connection
            .execute("UPDATE snapshot SET version=6,body=?1", params![saved])
            .unwrap();
        let events = store.events(0).unwrap().len();
        drop(store);
        assert_eq!(
            Store::open(path.to_str().unwrap(), config.clone())
                .err()
                .unwrap()
                .code,
            "storage_corrupt"
        );
        let connection = Connection::open(&path).unwrap();
        let unchanged: String = connection
            .query_row("SELECT body FROM snapshot", [], |row| row.get(0))
            .unwrap();
        assert_eq!(unchanged, saved);
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count as usize, events);
        connection
            .execute("UPDATE snapshot SET version=7", [])
            .unwrap();
        drop(connection);
        let restored = Store::open(path.to_str().unwrap(), config).unwrap();
        assert_eq!(
            restored.data.execution_binding("tv").unwrap().state,
            "composed"
        );
    }
    #[test]
    fn v5_upgrades_but_hidden_or_missing_execution_registry_does_not_rewrite_snapshot() {
        let path =
            std::env::temp_dir().join(format!("limeiot-binding-v6-{}.sqlite", limeiot_core::id()));
        {
            let store = Store::open(path.to_str().unwrap(), adapter_config()).unwrap();
            let mut body = serde_json::to_value(&store.data).unwrap();
            body.as_object_mut().unwrap().remove("execution_registry");
            store
                .connection
                .execute("UPDATE snapshot SET version=5,body=?1", [body.to_string()])
                .unwrap();
        }
        {
            let store = Store::open(path.to_str().unwrap(), adapter_config()).unwrap();
            assert!(store.data.execution_registry.bindings.is_empty());
            let version = store
                .connection
                .query_row("SELECT version FROM snapshot", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap();
            assert_eq!(version, 10);
            store
                .connection
                .execute("UPDATE snapshot SET version=5", [])
                .unwrap();
        }
        assert!(
            matches!(Store::open(path.to_str().unwrap(),adapter_config()),Err(error) if error.code=="storage_corrupt")
        );
        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT version FROM snapshot", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            5
        );
        connection
            .execute(
                "UPDATE snapshot SET version=6,body=json_remove(body,'$.execution_registry')",
                [],
            )
            .unwrap();
        let saved = connection
            .query_row("SELECT body FROM snapshot", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap();
        assert!(
            matches!(Store::open(path.to_str().unwrap(),adapter_config()),Err(error) if error.code=="storage_corrupt")
        );
        assert_eq!(
            connection
                .query_row("SELECT body FROM snapshot", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            saved
        );
    }
    #[test]
    fn corrupt_execution_binding_and_original_result_do_not_rewrite_snapshot() {
        use limeiot_core::execution_binding::{Change, Offer, Request};
        for variant in 0..4 {
            let path = std::env::temp_dir().join(format!(
                "limeiot-binding-corrupt-{}.sqlite",
                limeiot_core::id()
            ));
            let (mut saved, event_count) = {
                let mut store = Store::open(path.to_str().unwrap(), adapter_config()).unwrap();
                let view = store.data.execution_binding("tv").unwrap();
                let offer = Offer {
                    device_id: "tv".into(),
                    route: view.routes["remote.press"].clone(),
                    model_revision: view.model_revision.clone(),
                    paths: ["remote.press".into(), "apps.launch".into()].into(),
                };
                let applied = store
                    .update("execution.operation", |data| {
                        data.apply_execution_change(
                            Request {
                                space_id: "home".into(),
                                idempotency_key: "bind".into(),
                                change: Change::Bind {
                                    device_id: "tv".into(),
                                    route: offer.route.clone(),
                                    expected_binding_revision: view.revision,
                                    expected_model_revision: view.model_revision,
                                },
                            },
                            Some(&offer),
                            chrono::Utc::now(),
                        )
                    })
                    .unwrap();
                assert_eq!(applied.status, "applied", "{:?}", applied.reason);
                (
                    serde_json::to_value(&store.data).unwrap(),
                    store.events(0).unwrap().len(),
                )
            };
            match variant {
                0 => {
                    saved["devices"]["tv"]["routes"]
                        .as_object_mut()
                        .unwrap()
                        .remove("apps.launch");
                }
                1 => {
                    saved["execution_registry"]["operations"]["bind"]["result"]["device_id"] =
                        json!("other")
                }
                2 => {
                    saved["execution_registry"]["operations"]["bind"]["result"]["state"] =
                        json!("revoked")
                }
                _ => saved["execution_registry"]["bindings"]["tv"]["route"] = json!(null),
            }
            let body = saved.to_string();
            let connection = Connection::open(&path).unwrap();
            connection
                .execute("UPDATE snapshot SET body=?1", [&body])
                .unwrap();
            assert!(
                matches!(Store::open(path.to_str().unwrap(), adapter_config()), Err(error) if error.code == "storage_corrupt"),
                "variant {variant}"
            );
            assert_eq!(
                connection
                    .query_row("SELECT body FROM snapshot", [], |row| row
                        .get::<_, String>(0))
                    .unwrap(),
                body
            );
            assert_eq!(
                connection
                    .query_row("SELECT version FROM snapshot", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                10
            );
            assert_eq!(
                connection
                    .query_row("SELECT COUNT(*) FROM events", [], |row| row
                        .get::<_, usize>(0))
                    .unwrap(),
                event_count
            );
        }
    }
    #[test]
    fn failed_commit_does_not_publish_memory_or_audit_changes() {
        let mut store = Store::open(":memory:", config()).unwrap();
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        let output = store.update("test.write", |data| {
            data.space_id = "changed".into();
            Ok(())
        });
        assert_eq!(output.unwrap_err().code, "storage_unavailable");
        assert_eq!(store.data.space_id, "space-demo");
        assert_eq!(store.events(0).unwrap().len(), 1);
    }
    #[test]
    fn rejected_business_change_rolls_back() {
        let mut store = Store::open(":memory:", config()).unwrap();
        let result = store.update("test.error", |data| {
            data.space_id = "changed".into();
            Err::<(), _>(err("rejected"))
        });
        assert!(result.is_err());
        assert_eq!(store.data.space_id, "space-demo");
    }
    #[test]
    fn device_info_is_ephemeral_and_failed_commit_does_not_publish_it() {
        use limeiot_core::protocol::Envelope;
        let mut store = Store::open(":memory:", config()).unwrap();
        let now = chrono::Utc::now();
        let revision = store.data.devices["device-button"].model_revision.clone();
        let hello: Envelope = serde_json::from_value(json!({"v":1,"kind":"hello","message_id":"hello-info","device_id":"device-button","model_revision":revision,"boot_id":"info-boot","seq":1,"body":{"challenge":"info-challenge"}})).unwrap();
        store
            .update("device.hello", |data| data.ingest(hello, now))
            .unwrap();
        let session = store.data.devices["device-button"].session_id.clone();
        let state: Envelope = serde_json::from_value(json!({"v":1,"kind":"state","message_id":"state-info","device_id":"device-button","model_revision":revision,"boot_id":"info-boot","session_id":session,"seq":2,"body":{"type":"snapshot","revision":1,"properties":[]}})).unwrap();
        store
            .update("device.state", |data| data.ingest(state, now))
            .unwrap();
        let vector: Value = serde_json::from_str(include_str!(
            "../../../../contracts/examples/ota-firmware.json"
        ))
        .unwrap();
        let mut body = vector["request"]["device"].clone();
        body["device_id"] = json!("device-button");
        body["model_revision"] = json!(revision);
        let report: Envelope = serde_json::from_value(json!({"v":1,"kind":"device_info","message_id":"device-info","device_id":"device-button","model_revision":revision,"boot_id":"info-boot","session_id":session,"seq":3,"body":body})).unwrap();
        store
            .update("device.info", |data| data.ingest(report.clone(), now))
            .unwrap();
        assert!(store.data.current_device_info("device-button", now).is_ok());
        let saved: String = store
            .connection
            .query_row("SELECT body FROM snapshot", [], |r| r.get(0))
            .unwrap();
        assert!(
            serde_json::from_str::<Value>(&saved).unwrap()["devices"]["device-button"]
                .get("device_info")
                .is_none()
        );
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        let mut next = report;
        next.seq = Some(4);
        next.body["firmware_version"] = json!("0.2.0");
        assert_eq!(
            store
                .update("device.info", |data| data.ingest(next, now))
                .unwrap_err()
                .code,
            "storage_unavailable"
        );
        let original = store
            .data
            .current_device_info("device-button", now)
            .unwrap();
        assert_eq!(original.seq, 3);
        assert_eq!(original.device.firmware_version, "0.1.0");
        // 设备已离线时，断线恢复仍须清掉不参与快照序列化的旧观测。
        store.data.devices.get_mut("device-button").unwrap().ready = false;
        store
            .update("broker.disconnected", |data| {
                data.recover();
                Ok(())
            })
            .unwrap();
        assert!(store.data.devices["device-button"].device_info.is_none());
    }
    #[test]
    fn model_change_commit_failure_keeps_original_registry_and_event_log() {
        let mut store = Store::open(":memory:", config()).unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../contracts/examples/model-release.json"
        ))
        .unwrap();
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        let request = limeiot_core::model_registry::Request {
            space_id: "space-demo".into(),
            idempotency_key: "trust".into(),
            change: limeiot_core::model_registry::Change::TrustAdd {
                trust: fixture["trust"].clone(),
                expected_signing_key_id: fixture["trust"]["signing_key_id"]
                    .as_str()
                    .unwrap()
                    .into(),
            },
        };
        let result = store.update("model.operation", |data| {
            data.apply_model_change(request, chrono::Utc::now())
        });
        assert_eq!(result.unwrap_err().code, "storage_unavailable");
        assert!(
            store.data.model_registry.trusts.is_empty()
                && store.data.model_registry.operations.is_empty()
        );
        assert_eq!(store.events(0).unwrap().len(), 1);
    }
    #[test]
    fn ota_change_commit_failure_does_not_publish_trust_or_original_decision() {
        let mut store = Store::open(":memory:", config()).unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../contracts/examples/ota-firmware.json"
        ))
        .unwrap();
        let trust = &fixture["request"]["trust"];
        let change = limeiot_core::ota_tasks::parse_change(
            &serde_json::to_vec(&json!({
                "type":"trust.add", "trust":trust, "expected_signing_key_id":trust["signing_key_id"]
            }))
            .unwrap(),
        )
        .unwrap();
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        let result = store.update("ota.operation", |data| {
            data.apply_ota_change(
                limeiot_core::ota_tasks::Request {
                    space_id: "space-demo".into(),
                    idempotency_key: "original-ota".into(),
                    change,
                },
                chrono::Utc::now(),
            )
        });
        assert_eq!(result.unwrap_err().code, "storage_unavailable");
        assert!(store.data.ota_registry.trusts.is_empty());
        assert!(store.data.ota_registry.operations.is_empty());
        assert_eq!(store.events(0).unwrap().len(), 1);
    }
    fn ota_execution_store() -> (Store, String) {
        use limeiot_core::ota_tasks::{parse_change, Request};
        use limeiot_core::protocol::Envelope;
        let mut store = Store::open(":memory:", config()).unwrap();
        let at: chrono::DateTime<chrono::Utc> = "2026-11-02T00:00:00Z".parse().unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../contracts/examples/ota-firmware.json"
        ))
        .unwrap();
        let device = "device-lamp";
        let revision = store.data.devices[device].model_revision.clone();
        let task_id = store.update("ota.fixture", |data| {
            let hello: Envelope = serde_json::from_value(json!({"v":1,"kind":"hello","message_id":"hello-ota","device_id":device,"model_revision":revision,"boot_id":"boot-ota","seq":1,"body":{"challenge":"ota-challenge"}})).unwrap();
            data.ingest(hello, at)?;
            let session = data.devices[device].session_id.clone();
            for (seq, kind, body) in [
                (2, "state", json!({"type":"snapshot","revision":1,"properties":[{"path":"light.power","value":false,"observed_at":at,"quality":"confirmed","source":"fixture"},{"path":"light.brightness","value":0,"observed_at":at,"quality":"confirmed","source":"fixture"}]})),
                (3, "device_info", fixture["request"]["device"].clone()),
            ] {
                data.ingest(serde_json::from_value(json!({"v":1,"kind":kind,"message_id":format!("ota-{seq}"),"device_id":device,"model_revision":revision,"boot_id":"boot-ota","session_id":session,"seq":seq,"body":body})).unwrap(), at)?;
            }
            let apply = |data: &mut Data, body: Value| {
                data.apply_ota_change(Request { space_id:"space-demo".into(), idempotency_key:limeiot_core::id(), change:parse_change(&serde_json::to_vec(&body).unwrap()).unwrap() }, at)
            };
            let trust = &fixture["request"]["trust"];
            let trust_id = apply(data, json!({"type":"trust.add","trust":trust,"expected_signing_key_id":trust["signing_key_id"]}))?.resource.unwrap().id;
            let task_id = apply(data, json!({"type":"tasks.plan","device_id":device,"trust_id":trust_id,"manifest":fixture["request"]["manifest"],"expires_at":at+chrono::Duration::minutes(10)}))?.resource.unwrap().id;
            for kind in ["tasks.approve", "tasks.execute"] {
                let revision = data.ota_registry.tasks[&task_id].revision.clone();
                let result = apply(data, json!({"type":kind,"task_id":task_id,"expected_revision":revision}))?;
                assert_eq!(result.status, "applied");
            }
            Ok(task_id)
        }).unwrap();
        (store, task_id)
    }
    #[test]
    fn ota_dispatch_commit_failure_returns_no_message_and_preserves_unsent_intent() {
        let (mut store, task_id) = ota_execution_store();
        let before = serde_json::to_value(&store.data).unwrap();
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        let at = "2026-11-02T00:00:00Z".parse().unwrap();
        let result = store.update("ota.dispatch", |data| Ok(data.prepare_ota_dispatch(at)));
        assert_eq!(result.unwrap_err().code, "storage_unavailable");
        assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
        assert!(store.data.ota_registry.tasks[&task_id]
            .execution
            .as_ref()
            .unwrap()
            .attempted_at
            .is_none());
        store
            .connection
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        assert_eq!(
            store
                .update("ota.dispatch", |data| Ok(data.prepare_ota_dispatch(at)))
                .unwrap()
                .len(),
            1
        );
        assert!(store
            .update("ota.dispatch", |data| Ok(data.prepare_ota_dispatch(at)))
            .unwrap()
            .is_empty());
        store.data.validate_ota_registry().unwrap();
    }
    #[test]
    fn ota_terminal_receipt_commit_failure_preserves_device_occupancy() {
        let (mut store, task_id) = ota_execution_store();
        let at = "2026-11-02T00:00:00Z".parse().unwrap();
        store
            .update("ota.dispatch", |data| Ok(data.prepare_ota_dispatch(at)))
            .unwrap();
        let task = &store.data.ota_registry.tasks[&task_id];
        let execution = task.execution.as_ref().unwrap();
        let device = &store.data.devices["device-lamp"];
        let message: limeiot_core::protocol::Envelope = serde_json::from_value(json!({
            "v":1,"kind":"ota_result","message_id":"ota-rejected","device_id":"device-lamp",
            "model_revision":device.model_revision,"boot_id":device.boot_id,"session_id":device.session_id,"seq":device.last_seq+1,
            "body":{"task_id":task_id,"execution_id":execution.envelope.body["execution_id"],"request_digest":execution.request_digest,
                "manifest_digest":task.manifest_digest,"status":"rejected","firmware_version":task.baseline.device.firmware_version,
                "security_epoch":task.baseline.device.security_epoch,"image_sha256":format!("sha256:{}","0".repeat(64)),
                "pending_update":false,"error":"device_rejected"}
        })).unwrap();
        let before = serde_json::to_value(&store.data).unwrap();
        let events = store.events(0).unwrap().len();
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert_eq!(
            store
                .update("ota.receipt", |data| data.ingest(message.clone(), at))
                .unwrap_err()
                .code,
            "storage_unavailable"
        );
        assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
        assert!(store.data.ota_reserves_device("device-lamp", at));
        assert_eq!(store.events(0).unwrap().len(), events);
        store
            .connection
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        store
            .update("ota.receipt", |data| data.ingest(message, at))
            .unwrap();
        assert!(!store.data.ota_reserves_device("device-lamp", at));
        store.data.validate_ota_registry().unwrap();
    }
    #[test]
    fn v3_ota_tasks_upgrade_to_v8_but_a_current_task_missing_execution_is_not_rewritten() {
        let (mut store, task_id) = ota_execution_store();
        // 使用尚未执行的旧任务形态，模拟v3；旧版本不能携带新增执行字段或状态。
        let task = store.data.ota_registry.tasks.get_mut(&task_id).unwrap();
        task.status = limeiot_core::ota_tasks::Status::Approved;
        task.execution = None;
        let mut body = serde_json::to_value(&store.data).unwrap();
        body.as_object_mut().unwrap().remove("execution_registry");
        body["ota_registry"]["tasks"][&task_id]
            .as_object_mut()
            .unwrap()
            .remove("execution");
        let file =
            std::env::temp_dir().join(format!("limeiot-ota-v4-{}.sqlite", limeiot_core::id()));
        let path = file.to_str().unwrap();
        {
            let disk = Store::open(path, config()).unwrap();
            disk.connection
                .execute("UPDATE snapshot SET version=3,body=?1", [body.to_string()])
                .unwrap();
        }
        {
            let disk = Store::open(path, config()).unwrap();
            assert_eq!(
                disk.data.ota_registry.tasks[&task_id].status,
                limeiot_core::ota_tasks::Status::Planned
            );
            let (version, raw): (i64, String) = disk
                .connection
                .query_row("SELECT version,body FROM snapshot", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap();
            assert_eq!(version, 10);
            let mut value: Value = serde_json::from_str(&raw).unwrap();
            assert!(value["ota_registry"]["tasks"][&task_id]["execution"].is_null());
            value["ota_registry"]["tasks"][&task_id]
                .as_object_mut()
                .unwrap()
                .remove("execution");
            disk.connection
                .execute("UPDATE snapshot SET body=?1", [value.to_string()])
                .unwrap();
        }
        assert!(
            matches!(Store::open(path, config()), Err(error) if error.code == "storage_corrupt")
        );
        let connection = Connection::open(path).unwrap();
        let raw: String = connection
            .query_row("SELECT body FROM snapshot", [], |r| r.get(0))
            .unwrap();
        assert!(
            serde_json::from_str::<Value>(&raw).unwrap()["ota_registry"]["tasks"][&task_id]
                .get("execution")
                .is_none()
        );
        drop(connection);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn v2_snapshot_upgrades_and_current_without_ota_registry_is_not_rewritten() {
        let file =
            std::env::temp_dir().join(format!("limeiot-ota-upgrade-{}.sqlite", limeiot_core::id()));
        let path = file.to_str().unwrap();
        {
            let store = Store::open(path, config()).unwrap();
            let mut body = serde_json::to_value(&store.data).unwrap();
            body.as_object_mut().unwrap().remove("execution_registry");
            body.as_object_mut().unwrap().remove("ota_registry");
            store
                .connection
                .execute("UPDATE snapshot SET version=2,body=?1", [body.to_string()])
                .unwrap();
        }
        {
            let store = Store::open(path, config()).unwrap();
            let (version, raw): (i64, String) = store
                .connection
                .query_row("SELECT version,body FROM snapshot", [], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .unwrap();
            assert_eq!(version, 10);
            let mut body: Value = serde_json::from_str(&raw).unwrap();
            assert!(body["model_registry"].is_object() && body["ota_registry"].is_object());
            body.as_object_mut().unwrap().remove("ota_registry");
            store
                .connection
                .execute("UPDATE snapshot SET body=?1", [body.to_string()])
                .unwrap();
        }
        assert!(matches!(Store::open(path,config()),Err(error) if error.code=="storage_corrupt"));
        let connection = Connection::open(path).unwrap();
        let raw: String = connection
            .query_row("SELECT body FROM snapshot", [], |row| row.get(0))
            .unwrap();
        assert!(serde_json::from_str::<Value>(&raw)
            .unwrap()
            .get("ota_registry")
            .is_none());
        drop(connection);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn automation_budget_commit_failure_and_restart_keep_original_ledger() {
        use chrono::{DateTime, Duration, Utc};
        use limeiot_core::protocol::{Envelope, Rule};
        fn report(
            store: &mut Store,
            device: &str,
            kind: &str,
            body: Value,
            now: DateTime<Utc>,
        ) -> Result<()> {
            let binding = &store.data.devices[device];
            let message: Envelope = serde_json::from_value(json!({"v":1,"kind":kind,
                "message_id":format!("message-{}",binding.last_seq+1),"device_id":device,
                "model_revision":binding.model_revision,"boot_id":format!("boot-{device}"),
                "session_id":binding.session_id,"seq":binding.last_seq+1,"body":body}))
            .unwrap();
            store
                .update("device.message", |data| data.ingest(message, now))
                .map(|_| ())
        }
        fn connect(store: &mut Store, now: DateTime<Utc>) {
            for (device, properties) in [
                ("device-button", json!([])),
                (
                    "device-lamp",
                    json!([
                        {"path":"light.power","value":true,"observed_at":now,"quality":"confirmed","source":"fixture"},
                        {"path":"light.brightness","value":50,"observed_at":now,"quality":"confirmed","source":"fixture"}
                    ]),
                ),
            ] {
                report(store, device, "hello", json!({"challenge":"fixture"}), now).unwrap();
                report(
                    store,
                    device,
                    "state",
                    json!({"type":"snapshot","revision":1,"properties":properties}),
                    now,
                )
                .unwrap();
            }
        }
        fn event(store: &mut Store, id: &str, now: DateTime<Utc>) -> Result<()> {
            report(
                store,
                "device-button",
                "event",
                json!({"event_id":id,"path":"button.pressed",
                "occurred_at":now,"historical":false,"data":{"count":1}}),
                now,
            )
        }
        let now: DateTime<Utc> = "2026-11-03T00:00:00Z".parse().unwrap();
        let path =
            std::env::temp_dir().join(format!("limeiot-budget-{}.sqlite", limeiot_core::id()));
        let config = config();
        let mut store = Store::open(path.to_str().unwrap(), config.clone()).unwrap();
        connect(&mut store, now);
        let mut rule: Rule = serde_json::from_str(include_str!(
            "../../../../contracts/examples/button-light.json"
        ))
        .unwrap();
        rule.cooldown_ms = 0;
        store
            .update("rule.deployed", |data| data.deploy(rule.clone()))
            .unwrap();
        for index in 0..63 {
            event(&mut store, &format!("press-{index}"), now).unwrap();
            let commands = store
                .update("dispatch", |data| Ok(data.prepare_dispatch(now)))
                .unwrap();
            assert_eq!(commands.len(), 1);
            let operation = &commands[0].body["operation"];
            let mut reported = serde_json::Map::new();
            reported.insert(
                operation["path"].as_str().unwrap().into(),
                operation["value"].clone(),
            );
            report(
                &mut store,
                "device-lamp",
                "result",
                json!({"command_id":commands[0].body["command_id"],
                "status":"confirmed","evidence":{"type":"device_result","reported":reported}}),
                now,
            )
            .unwrap();
        }
        assert_eq!(store.data.commands.len(), 63);
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        let before = serde_json::to_value(&store.data).unwrap();
        let events = store.events(0).unwrap().len();
        assert_eq!(
            event(&mut store, "last-slot", now).unwrap_err().code,
            "storage_unavailable"
        );
        assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
        assert_eq!(store.events(0).unwrap().len(), events);
        store
            .connection
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        event(&mut store, "last-slot", now).unwrap();
        assert_eq!(store.data.commands.len(), 64);
        let command_ids = store.data.commands.keys().cloned().collect::<Vec<_>>();
        // 超预算运行本身也必须原子落盘；失败不能提前消耗事件身份或公布拒绝记录。
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        let before = serde_json::to_value(&store.data).unwrap();
        let events = store.events(0).unwrap().len();
        assert_eq!(
            event(&mut store, "exhausted", now).unwrap_err().code,
            "storage_unavailable"
        );
        assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
        assert_eq!(store.events(0).unwrap().len(), events);
        store
            .connection
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        event(&mut store, "exhausted", now).unwrap();
        let rejected = store
            .data
            .runs
            .values()
            .find(|r| r.event_id == "exhausted")
            .unwrap()
            .clone();
        assert_eq!(
            rejected.error.as_deref(),
            Some("automation_budget_exceeded")
        );
        assert!(rejected.command_ids.is_empty());
        assert_eq!(
            store.data.commands.keys().cloned().collect::<Vec<_>>(),
            command_ids
        );
        drop(store);
        let mut store = Store::open(path.to_str().unwrap(), config).unwrap();
        connect(&mut store, now + Duration::milliseconds(1));
        event(&mut store, "after-restart", now + Duration::milliseconds(2)).unwrap();
        assert_eq!(
            store.data.commands.keys().cloned().collect::<Vec<_>>(),
            command_ids
        );
        assert_eq!(store.data.runs[&rejected.run_id].error, rejected.error);
        assert!(
            store
                .data
                .runs
                .values()
                .filter(|r| r.error.as_deref() == Some("automation_budget_exceeded"))
                .count()
                == 2
        );
        assert!(store
            .data
            .prepare_dispatch(now + Duration::milliseconds(3))
            .is_empty());
        assert_eq!(
            store
                .connection
                .query_row("SELECT version FROM snapshot", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            10
        );
    }
    #[test]
    fn cyclic_rule_rejection_and_snapshot_recovery_never_publish_or_rewrite() {
        let config = config();
        let path =
            std::env::temp_dir().join(format!("limeiot-rule-cycle-{}.sqlite", limeiot_core::id()));
        let mut store = Store::open(path.to_str().unwrap(), config.clone()).unwrap();
        let rule: limeiot_core::protocol::Rule = serde_json::from_value(json!({
            "version":1,"id":"cyclic","trigger":{"device":"device-lamp",
            "property":{"path":"light.brightness","unit":"percent","edge":"rising","threshold":50,"hysteresis":5}},
            "conditions":[],"actions":[{"device":"device-lamp","set":{"path":"light.brightness","value":20}}],"cooldown_ms":10000
        })).unwrap();
        let before = serde_json::to_value(&store.data).unwrap();
        let event_count = store.events(0).unwrap().len();
        assert_eq!(
            store
                .update("rule.deployed", |data| data.deploy(rule.clone()))
                .unwrap_err()
                .code,
            "rule_cycle"
        );
        assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
        assert_eq!(store.events(0).unwrap().len(), event_count);
        let saved: String = store
            .connection
            .query_row("SELECT body FROM snapshot", [], |row| row.get(0))
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), before);
        drop(store);
        // 模拟旧程序已经保存的环路；启动必须在写gateway.recovered之前拒绝。
        let mut corrupt = before;
        corrupt["deployments"]["cyclic"] =
            json!({"rule":rule,"revision":digest(&rule).unwrap(),"last_run":null});
        let body = corrupt.to_string();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute("UPDATE snapshot SET body=?1", [&body])
            .unwrap();
        assert!(
            matches!(Store::open(path.to_str().unwrap(), config), Err(error) if error.code == "storage_corrupt")
        );
        assert_eq!(
            connection
                .query_row("SELECT body FROM snapshot", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            body
        );
        assert_eq!(
            connection
                .query_row("SELECT version FROM snapshot", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            10
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM events", [], |row| row
                    .get::<_, usize>(0))
                .unwrap(),
            event_count
        );
    }
    #[test]
    fn property_threshold_commit_is_atomic_and_v10_recovery_never_replays_edges() {
        use chrono::{DateTime, Duration, Utc};
        use limeiot_core::{
            model::Model,
            protocol::{Envelope, Rule},
        };
        fn report(
            store: &mut Store,
            device: &str,
            kind: &str,
            body: Value,
            now: DateTime<Utc>,
        ) -> Result<()> {
            let binding = &store.data.devices[device];
            let message: Envelope = serde_json::from_value(json!({"v":1,"kind":kind,
                "message_id":format!("message-{}",binding.last_seq+1),"device_id":device,
                "model_revision":binding.model_revision,"boot_id":binding.boot_id.clone().unwrap_or_else(||format!("boot-{device}")),
                "session_id":binding.session_id,"seq":binding.last_seq+1,"body":body})).unwrap();
            store
                .update("device.message", |data| data.ingest(message, now))
                .map(|_| ())
        }
        fn sample(store: &mut Store, value: i64, now: DateTime<Utc>) -> Result<()> {
            report(
                store,
                "sensor",
                "state",
                json!({"type":"snapshot","revision":store.data.devices["sensor"].state_revision+1,
                "properties":[{"path":"environment.temperature","value":value,"observed_at":now,"quality":"confirmed","source":"fixture.sht3x"},
                    {"path":"environment.humidity","value":5000,"observed_at":now,"quality":"confirmed","source":"fixture.sht3x"}]}),
                now,
            )
        }
        let now: DateTime<Utc> = "2026-11-03T00:00:00Z".parse().unwrap();
        let lamp: Model =
            serde_json::from_str(include_str!("../../../../contracts/models/lamp.json")).unwrap();
        let sensor: Model = serde_json::from_str(include_str!(
            "../../../../contracts/models/environment.json"
        ))
        .unwrap();
        let config: Config =
            serde_json::from_value(json!({"space_id":"home","models":[lamp,sensor],"devices":[
            {"device_id":"lamp","model_revision":digest(&lamp).unwrap()},
            {"device_id":"sensor","model_revision":digest(&sensor).unwrap()}]}))
            .unwrap();
        let path =
            std::env::temp_dir().join(format!("limeiot-threshold-{}.sqlite", limeiot_core::id()));
        let mut store = Store::open(path.to_str().unwrap(), config.clone()).unwrap();
        for device in ["lamp", "sensor"] {
            report(
                &mut store,
                device,
                "hello",
                json!({"challenge":"challenge"}),
                now,
            )
            .unwrap();
        }
        report(&mut store,"lamp","state",json!({"type":"snapshot","revision":1,"properties":[
            {"path":"light.power","value":true,"observed_at":now,"quality":"confirmed","source":"fixture"},
            {"path":"light.brightness","value":50,"observed_at":now,"quality":"confirmed","source":"fixture"}]}),now).unwrap();
        let rule:Rule=serde_json::from_value(json!({"version":1,"id":"threshold","trigger":{"device":"sensor","property":{
            "path":"environment.temperature","unit":"celsius_x100","edge":"rising","threshold":2800,"hysteresis":100}},
            "conditions":[],"actions":[{"device":"lamp","set":{"path":"light.brightness","value":30}}],"cooldown_ms":0})).unwrap();
        store
            .update("rules.deployed", |data| data.deploy(rule))
            .unwrap();
        sample(&mut store, 2700, now + Duration::seconds(1)).unwrap();
        let before = serde_json::to_value(&store.data).unwrap();
        let events = store.events(0).unwrap().len();
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert_eq!(
            sample(&mut store, 2900, now + Duration::seconds(2))
                .unwrap_err()
                .code,
            "storage_unavailable"
        );
        assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
        assert_eq!(store.events(0).unwrap().len(), events);
        store
            .connection
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        sample(&mut store, 2900, now + Duration::seconds(2)).unwrap();
        assert_eq!(store.data.runs.len(), 1);
        store
            .update("dispatch", |data| {
                Ok(data.prepare_dispatch(now + Duration::seconds(2)))
            })
            .unwrap();
        let original = store.data.commands.keys().next().unwrap().clone();
        assert!(store
            .data
            .runs
            .values()
            .next()
            .unwrap()
            .property_trigger
            .is_some());
        drop(store);
        let mut store = Store::open(path.to_str().unwrap(), config.clone()).unwrap();
        assert_eq!(store.data.commands[&original].status, "unknown");
        report(
            &mut store,
            "sensor",
            "hello",
            json!({"challenge":"new-challenge"}),
            now + Duration::seconds(3),
        )
        .unwrap();
        sample(&mut store, 2900, now + Duration::seconds(4)).unwrap();
        assert_eq!(store.data.runs.len(), 1);
        let raw: String = store
            .connection
            .query_row("SELECT body FROM snapshot", [], |r| r.get(0))
            .unwrap();
        assert!(!raw.contains("threshold_cursors"));
        store
            .connection
            .execute("UPDATE snapshot SET version=8", [])
            .unwrap();
        drop(store);
        assert!(
            matches!(Store::open(path.to_str().unwrap(),config),Err(error) if error.code=="storage_corrupt")
        );
        let disk = Connection::open(path).unwrap();
        let stored: (i64, String) = disk
            .query_row("SELECT version,body FROM snapshot", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(stored, (8, raw));
    }
    #[test]
    fn old_snapshot_upgrades_to_v10_and_future_versions_are_not_rewritten() {
        let file =
            std::env::temp_dir().join(format!("limeiot-registry-{}.sqlite", limeiot_core::id()));
        let path = file.to_str().unwrap();
        let mut original = serde_json::to_value(Data::new(config()).unwrap()).unwrap();
        original
            .as_object_mut()
            .unwrap()
            .remove("execution_registry");
        original.as_object_mut().unwrap().remove("model_registry");
        original.as_object_mut().unwrap().remove("ota_registry");
        {
            let connection = Connection::open(path).unwrap();
            connection.execute_batch("CREATE TABLE snapshot (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, config_hash TEXT NOT NULL, body TEXT NOT NULL)").unwrap();
            connection
                .execute(
                    "INSERT INTO snapshot VALUES(1,1,?1,?2)",
                    params![digest(&config()).unwrap(), original.to_string()],
                )
                .unwrap();
        }
        {
            let store = Store::open(path, config()).unwrap();
            let (version, body): (i64, String) = store
                .connection
                .query_row("SELECT version,body FROM snapshot WHERE id=1", [], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .unwrap();
            assert_eq!(version, 10);
            assert!(serde_json::from_str::<Value>(&body).unwrap()["model_registry"].is_object());
            assert!(serde_json::from_str::<Value>(&body).unwrap()["ota_registry"].is_object());
            store
                .connection
                .execute("UPDATE snapshot SET version=13", [])
                .unwrap();
        }
        assert!(
            matches!(Store::open(path, config()), Err(error) if error.code == "storage_config_mismatch")
        );
        let connection = Connection::open(path).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT version FROM snapshot", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            13
        );
        drop(connection);
        std::fs::remove_file(file).unwrap();
    }
}
