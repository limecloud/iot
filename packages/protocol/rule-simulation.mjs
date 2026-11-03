import { canonicalJSON, documentDigest } from './model-validation.mjs';

const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reasons = new Set(['device_not_found', 'model_authority_unavailable', 'device_offline', 'invalid_condition', 'unconfirmed_observation', 'future_observation', 'stale_observation', 'missing_observation']);
function nodesValid(conditions, nodes) {
  if (!Array.isArray(nodes) || nodes.length !== conditions.length) return false;
  return conditions.every((condition, index) => {
    const node = nodes[index]; if (!object(node) || typeof node.matched !== 'boolean') return false;
    if (condition.all || condition.any) {
      const children = condition.all ?? condition.any;
      return !node.reason && !node.observation && !node.model_revision && nodesValid(children, node.children) && node.matched === (condition.all ? node.children.every(child => child.matched) : node.children.some(child => child.matched));
    }
    if (node.children?.length || !/^sha256:[a-f0-9]{64}$/.test(node.model_revision ?? '')) return false;
    if (node.reason !== undefined) return reasons.has(node.reason) && node.matched === false;
    const observation = node.observation;
    if (!object(observation) || observation.quality !== 'confirmed' || !Number.isFinite(Date.parse(observation.observed_at)) || typeof observation.value !== typeof condition.value) return false;
    const a = observation.value, b = condition.value;
    const matched = { eq: () => a === b, ne: () => a !== b, lt: () => a < b, lte: () => a <= b, gt: () => a > b, gte: () => a >= b }[condition.operator]?.();
    return node.matched === matched;
  });
}
// 把预演与待部署的完整规则绑定，条件不满足不能伪装成触发样例有效。
export async function verifyRuleSimulation(rule, proof, validation) {
  const revision = await documentDigest(rule);
  let valid = object(proof) && validation?.valid === true && validation.revision === revision && proof.revision === revision && proof.executed === false && proof.simulation === true;
  if (rule.conditions.length) {
    const evaluation = proof?.condition_evaluation;
    valid &&= proof.trigger_matched === true && object(evaluation) && Number.isFinite(Date.parse(evaluation.evaluated_at)) && same(evaluation.conditions, rule.conditions) && nodesValid(rule.conditions, evaluation.results) &&
      evaluation.matched === evaluation.results.every(node => node.matched) && proof.matched === evaluation.matched && same(proof.proposed_actions, proof.matched ? rule.actions : []);
  } else valid &&= proof.matched === true && proof.condition_evaluation === undefined && same(proof.proposed_actions, rule.actions);
  if (!valid) throw new Error('invalid_simulation');
  return proof;
}
