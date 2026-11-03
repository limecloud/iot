//! 从原命令账本计算空间自动化预算，不保存可被重启清空的第二套计数。
use crate::{engine::Data, ensure, err, Result};
use chrono::{DateTime, Duration, Utc};

pub const WINDOW_SECONDS: i64 = 60;
pub const COMMAND_LIMIT: usize = 64;

impl Data {
    pub(crate) fn check_rule_budget(&self, actions: usize, now: DateTime<Utc>) -> Result<()> {
        let start = now
            .checked_sub_signed(Duration::seconds(WINDOW_SECONDS))
            .ok_or_else(|| err("automation_budget_exceeded"))?;
        let mut used = 0;
        for command in self.commands.values().filter(|c| c.run_id.is_some()) {
            // 失败、过期和unknown仍消耗已受理名额。未来时刻保守计入，回拨不释放预算。
            let issued: DateTime<Utc> =
                serde_json::from_value(command.envelope.body["issued_at"].clone())
                    .map_err(|_| err("storage_corrupt"))?;
            if issued > start {
                used += 1;
            }
        }
        ensure(
            actions <= COMMAND_LIMIT && used <= COMMAND_LIMIT - actions,
            "automation_budget_exceeded",
        )
    }
}
