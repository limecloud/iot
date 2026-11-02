// 版本与包络边界；模型定义语义仍由 Rust 执行。
export const MODEL_VALIDATOR = 'limeiot.model/1.1.0';
export const MODEL_CHECKER = 'limeiot.model-compatibility/1.1.0';
export const LEGACY_VALIDATOR = 'limeiot.model/1.0.0';
export const LEGACY_CHECKER = 'limeiot.model-compatibility/1.0.0';

export function legacyModel(model) {
  return model?.schema_version === 1 && Array.isArray(model.services) &&
    model.services.every(service => Array.isArray(service.actions) && service.actions.length === 0);
}

export function releaseContract(statement) {
  return statement?.validator === MODEL_VALIDATOR && statement.compatibility_checker === MODEL_CHECKER ||
    statement?.validator === LEGACY_VALIDATOR && statement.compatibility_checker === LEGACY_CHECKER && legacyModel(statement.model);
}
