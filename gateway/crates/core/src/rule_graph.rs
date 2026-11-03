//! 阈值规则按设备/属性建立依赖图；动作缺少效果声明时保守连接目标设备的全部阈值来源。
use crate::{
    engine::Data,
    ensure,
    protocol::{Action, Rule, Trigger},
    Result,
};
use std::collections::{BTreeMap, BTreeSet};

type Signal = (String, String);
type Graph = BTreeMap<Signal, BTreeSet<Signal>>;

fn visit(
    signal: &Signal,
    graph: &Graph,
    visiting: &mut BTreeSet<Signal>,
    done: &mut BTreeSet<Signal>,
) -> Result<()> {
    if done.contains(signal) {
        return Ok(());
    }
    ensure(visiting.insert(signal.clone()), "rule_cycle")?;
    if let Some(targets) = graph.get(signal) {
        for target in targets {
            visit(target, graph, visiting, done)?;
        }
    }
    visiting.remove(signal);
    done.insert(signal.clone());
    Ok(())
}

fn validate<'a>(rules: impl Iterator<Item = &'a Rule>) -> Result<()> {
    let rules: Vec<_> = rules.collect();
    ensure(rules.len() <= 64, "capacity_exceeded")?;
    ensure(
        rules.iter().all(|rule| rule.actions.len() <= 16),
        "unsupported_rule",
    )?;
    let sources: BTreeSet<_> = rules
        .iter()
        .filter_map(|rule| match &rule.trigger {
            Trigger::Property { device, property } => Some((device.clone(), property.path.clone())),
            Trigger::Event { .. } | Trigger::Schedule { .. } => None,
        })
        .collect();
    let mut graph = Graph::new();
    for rule in rules {
        let Trigger::Property { device, property } = &rule.trigger else {
            continue;
        };
        let targets = graph
            .entry((device.clone(), property.path.clone()))
            .or_default();
        for action in &rule.actions {
            match action {
                Action::Set { device, set } => {
                    targets.insert((device.clone(), set.path.clone()));
                }
                Action::Invoke { device, .. } => {
                    targets.extend(sources.iter().filter(|(id, _)| id == device).cloned());
                }
            }
        }
    }
    let mut visiting = BTreeSet::new();
    let mut done = BTreeSet::new();
    for signal in graph.keys() {
        visit(signal, &graph, &mut visiting, &mut done)?;
    }
    Ok(())
}

impl Data {
    pub fn validate_rule_graph(&self) -> Result<()> {
        validate(self.deployments.values().map(|deployment| &deployment.rule))
    }

    pub(crate) fn validate_rule_replacement(&self, candidate: &Rule) -> Result<()> {
        validate(
            self.deployments
                .values()
                .map(|deployment| &deployment.rule)
                .filter(|rule| rule.id != candidate.id)
                .chain(std::iter::once(candidate)),
        )
    }
}
