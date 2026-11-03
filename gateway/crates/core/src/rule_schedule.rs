//! 固定IANA时区的每周定时；跳过不存在的本地时间，重复时刻只选第一次。
use crate::{digest, engine::Data, ensure, err, protocol::Trigger, Result};
use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MAX_LATENESS_SECONDS: i64 = 5;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schedule {
    pub time: String,
    pub time_zone: String,
    pub weekdays: Vec<u8>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduleEvidence {
    pub scheduled_at: DateTime<Utc>,
    pub local_date: String,
    pub local_time: String,
    pub time_zone: String,
}
impl Schedule {
    fn parsed(&self) -> Result<(NaiveTime, Tz)> {
        let bytes = self.time.as_bytes();
        ensure(
            bytes.len() == 5
                && bytes[2] == b':'
                && bytes
                    .iter()
                    .enumerate()
                    .all(|(i, b)| i == 2 || b.is_ascii_digit())
                && !self.weekdays.is_empty()
                && self.weekdays.len() <= 7
                && self.weekdays.iter().all(|v| (1..=7).contains(v))
                && self.weekdays.iter().collect::<BTreeSet<_>>().len() == self.weekdays.len()
                && self.time_zone.len() <= 128,
            "invalid_schedule",
        )?;
        let time =
            NaiveTime::parse_from_str(&self.time, "%H:%M").map_err(|_| err("invalid_schedule"))?;
        let zone = self
            .time_zone
            .parse::<Tz>()
            .map_err(|_| err("invalid_schedule"))?;
        Ok((time, zone))
    }
    pub fn validate(&self) -> Result<()> {
        self.parsed().map(|_| ())
    }
    pub fn occurrence(&self, date: NaiveDate) -> Result<Option<ScheduleEvidence>> {
        let (time, zone) = self.parsed()?;
        if !self
            .weekdays
            .contains(&(date.weekday().number_from_monday() as u8))
        {
            return Ok(None);
        }
        ensure(
            (1970..=9998).contains(&date.year()),
            "invalid_schedule_time",
        )?;
        // earliest对gap返回None，对fold选择较早的UTC时刻，不补做第二次。
        Ok(zone
            .from_local_datetime(&date.and_time(time))
            .earliest()
            .map(|at| ScheduleEvidence {
                scheduled_at: at.with_timezone(&Utc),
                local_date: date.to_string(),
                local_time: self.time.clone(),
                time_zone: self.time_zone.clone(),
            }))
    }
    pub fn sample(&self, at: DateTime<Utc>) -> Result<Option<ScheduleEvidence>> {
        ensure((1970..=9998).contains(&at.year()), "invalid_schedule_time")?;
        let (_, zone) = self.parsed()?;
        Ok(self
            .occurrence(at.with_timezone(&zone).date_naive())?
            .filter(|e| e.scheduled_at == at))
    }
    pub fn next_after(&self, now: DateTime<Utc>) -> Result<ScheduleEvidence> {
        ensure((1970..=9998).contains(&now.year()), "invalid_schedule_time")?;
        let (_, zone) = self.parsed()?;
        let date = now.with_timezone(&zone).date_naive();
        for offset in 0..=14 {
            let day = date
                .checked_add_signed(Duration::days(offset))
                .ok_or_else(|| err("invalid_schedule_time"))?;
            if let Some(evidence) = self.occurrence(day)? {
                if evidence.scheduled_at > now {
                    return Ok(evidence);
                }
            }
        }
        Err(err("invalid_schedule_time"))
    }
    fn due(&self, after: DateTime<Utc>, now: DateTime<Utc>) -> Result<Option<ScheduleEvidence>> {
        ensure((1970..=9998).contains(&now.year()), "invalid_schedule_time")?;
        if now <= after || now - after > Duration::seconds(MAX_LATENESS_SECONDS) {
            return Ok(None);
        }
        let (_, zone) = self.parsed()?;
        let date = now.with_timezone(&zone).date_naive();
        // 午夜后几秒仍可处理刚跨过的昨日时刻；最多两个日期，不扫描离线历史。
        for day in [Some(date), date.pred_opt()].into_iter().flatten() {
            if let Some(evidence) = self.occurrence(day)? {
                if evidence.scheduled_at > after
                    && evidence.scheduled_at <= now
                    && now - evidence.scheduled_at <= Duration::seconds(MAX_LATENESS_SECONDS)
                {
                    return Ok(Some(evidence));
                }
            }
        }
        Ok(None)
    }
}
impl Data {
    pub fn poll_schedules(&mut self, now: DateTime<Utc>) -> Result<()> {
        ensure((1970..=9998).contains(&now.year()), "invalid_schedule_time")?;
        let resuming = self.schedule_resuming;
        self.schedule_resuming = false;
        let rules: Vec<_> = self
            .deployments
            .values()
            .filter(|d| matches!(d.rule.trigger, Trigger::Schedule { .. }))
            .cloned()
            .collect();
        for deployment in rules {
            let Trigger::Schedule { schedule } = &deployment.rule.trigger else {
                unreachable!()
            };
            let cursor = deployment
                .schedule_cursor
                .ok_or_else(|| err("storage_corrupt"))?;
            // 墙钟回拨不后退高水位；恢复的第一次轮询只建立新基线。
            let checkpoint = now
                .with_nanosecond(0)
                .ok_or_else(|| err("invalid_schedule_time"))?;
            if checkpoint <= cursor {
                continue;
            }
            self.deployments
                .get_mut(&deployment.rule.id)
                .unwrap()
                .schedule_cursor = Some(checkpoint);
            if resuming {
                continue;
            }
            let Some(evidence) = schedule.due(cursor, now)? else {
                continue;
            };
            if deployment.last_run.is_some_and(|at| {
                now - at < Duration::milliseconds(deployment.rule.cooldown_ms as i64)
            }) {
                continue;
            }
            let event_id = format!(
                "schedule-{}",
                &digest(&(deployment.revision.as_str(), &evidence))?[7..]
            );
            self.run_deployment(deployment, &event_id, None, Some(evidence), now)?;
        }
        Ok(())
    }
    pub fn validate_saved_schedules(&self) -> Result<()> {
        for (id, deployment) in &self.deployments {
            ensure(id == &deployment.rule.id, "storage_corrupt")?;
            match &deployment.rule.trigger {
                Trigger::Schedule { schedule } => {
                    schedule.validate()?;
                    ensure(
                        deployment.revision == digest(&deployment.rule)?,
                        "storage_corrupt",
                    )?;
                    let cursor = deployment
                        .schedule_cursor
                        .ok_or_else(|| err("storage_corrupt"))?;
                    ensure((1970..=9998).contains(&cursor.year()), "storage_corrupt")?;
                }
                _ => ensure(deployment.schedule_cursor.is_none(), "storage_corrupt")?,
            }
        }
        for run in self.runs.values() {
            if let Some(evidence) = &run.schedule_trigger {
                ensure(
                    (1970..=9998).contains(&evidence.scheduled_at.year()),
                    "storage_corrupt",
                )?;
                let zone = evidence
                    .time_zone
                    .parse::<Tz>()
                    .map_err(|_| err("storage_corrupt"))?;
                let local = evidence.scheduled_at.with_timezone(&zone);
                let schedule = Schedule {
                    time: evidence.local_time.clone(),
                    time_zone: evidence.time_zone.clone(),
                    weekdays: vec![local.weekday().number_from_monday() as u8],
                };
                ensure(
                    evidence.local_date == local.date_naive().to_string()
                        && schedule.sample(evidence.scheduled_at)?.is_some()
                        && run.property_trigger.is_none()
                        && run.event_id
                            == format!(
                                "schedule-{}",
                                &digest(&(run.rule_revision.as_str(), evidence))?[7..]
                            ),
                    "storage_corrupt",
                )?;
            } else {
                ensure(
                    !self.deployments.values().any(|d| {
                        d.revision == run.rule_revision
                            && matches!(d.rule.trigger, Trigger::Schedule { .. })
                    }),
                    "storage_corrupt",
                )?;
            }
        }
        Ok(())
    }
}
