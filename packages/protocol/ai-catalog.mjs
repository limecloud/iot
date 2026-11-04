import schema from '../../contracts/ai-catalog.schema.json' with { type: 'json' };
import { parseBoundedJSON, sameJSON } from './products.mjs';
import { verifyTextCapabilities } from './text.mjs';
import { verifyVisionCapabilities } from './vision.mjs';
import { verifyTranscriptionCapabilities } from './transcription.mjs';
import { verifySpeechCapabilities } from './speech.mjs';

const fields = (v, names) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
const definitions = schema.properties.definitions.const;
const validators = { 'text.generate': verifyTextCapabilities, 'vision.understand': verifyVisionCapabilities, 'audio.transcribe': verifyTranscriptionCapabilities, 'audio.synthesize': verifySpeechCapabilities };
const fail = () => { throw new Error('invalid_ai_catalog'); };

export function verifyAiCatalog(value, space) {
  if (typeof space !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(space) || !fields(value, 'schema_version,space_id,definitions,deployments,health,routing') || value.schema_version !== 1 || value.space_id !== space || !sameJSON(value.definitions, definitions) || !sameJSON(value.routing, schema.properties.routing.const) || !Array.isArray(value.deployments) || value.deployments.length > definitions.length || !Array.isArray(value.health) || value.health.length !== definitions.length) fail();
  const deployed = new Set(), observed = new Set(), ids = new Set(definitions.map(d => d.capability_id));
  for (const item of value.deployments) {
    if (!fields(item, 'capability_id,identity,configuration,license,cost_policy,resource_requirements,quality') || !ids.has(item.capability_id) || deployed.has(item.capability_id) || item.license !== null || item.cost_policy !== null || item.resource_requirements !== null || item.quality !== null || !item.configuration || typeof item.configuration !== 'object' || Array.isArray(item.configuration) || ['configured', 'capability', 'deployment'].some(key => Object.hasOwn(item.configuration, key))) fail();
    const identity = item.identity;
    try {
      if (item.capability_id === 'automation.rule_draft') {
        if (!fields(identity, 'adapter,revision,model,data_location') || identity.adapter !== 'ollama' || identity.revision !== null || typeof identity.model !== 'string' || !/^[A-Za-z0-9_:./-]{1,128}$/.test(identity.model) || identity.data_location !== 'local' || !sameJSON(item.configuration, { concurrency: 1, max_output_tokens: 1024 })) fail();
      } else validators[item.capability_id]({ ...item.configuration, configured: true, capability: item.capability_id, deployment: identity });
    } catch { fail(); }
    deployed.add(item.capability_id);
  }
  for (const item of value.health) {
    if (!fields(item, 'capability_id,status,checked_at') || !ids.has(item.capability_id) || observed.has(item.capability_id) || item.checked_at !== null || item.status !== (deployed.has(item.capability_id) ? 'unknown' : 'not_configured')) fail();
    observed.add(item.capability_id);
  }
  return value;
}

export function parseAiCatalog(raw, space) {
  try { return verifyAiCatalog(parseBoundedJSON(raw, { maxBytes: 32768, maxDepth: 8, maxNodes: 2048 }), space); }
  catch { fail(); }
}
