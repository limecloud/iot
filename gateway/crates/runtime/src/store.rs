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
}
impl Store {
    pub fn open(path: &str, config: Config) -> Result<Self> {
        let connection = Connection::open(path).map_err(|_| err("storage_unavailable"))?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, config_hash TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, data TEXT NOT NULL);").map_err(|_|err("storage_unavailable"))?;
        let config_hash = digest(&config)?;
        let data = match connection.query_row(
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
                ensure(
                    version == 1 && hash == config_hash,
                    "storage_config_mismatch",
                )?;
                serde_json::from_str(&body).map_err(|_| err("storage_corrupt"))?
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Data::new(config)?,
            Err(_) => return Err(err("storage_unavailable")),
        };
        let mut store = Self {
            connection,
            data,
            config_hash,
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
            return Ok(output);
        }
        let event = serde_json::to_string(&json!({"occurred_at":chrono::Utc::now(),"data":output}))
            .map_err(|_| err("invalid_json"))?;
        let transaction = self
            .connection
            .transaction()
            .map_err(|_| err("storage_unavailable"))?;
        transaction.execute("INSERT INTO snapshot(id,version,config_hash,body) VALUES(1,1,?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body",params![self.config_hash,body]).map_err(|_|err("storage_unavailable"))?;
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
    fn config() -> Config {
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap()
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
}
