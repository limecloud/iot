import { z } from "zod";
import { APIError, type Entry } from "./api";
import { parseDraft, sameJSON } from "./contracts";
import { checkerSchema, digest, digestSchema, issueSchema, legacyModel, reportSchema, textHash, validatorSchema, verifyReport } from "./model-contracts";

const identifier = (prefix: string) => z.string().regex(new RegExp("^" + prefix + "[a-f0-9]{64}$"));
const releaseID = identifier("release-");
const productID = identifier("product-");
const revision = identifier("prodrev-");
const date = z.iso.datetime();
const scopeShape = {
  issuer: z.url(), publisher_id: identifier("publisher-"),
  namespace: z.string().regex(/^p-[a-f0-9]{30}$/),
};
const trustSchema = z.object({
  version: z.literal(1), ...scopeShape, signing_key_id: digestSchema,
  public_key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
}).strict();
export const publisherSchema = z.object({ ...scopeShape, trust: trustSchema.nullable() }).strict();
export type Publisher = z.infer<typeof publisherSchema>;
export const publishInputSchema = z.object({
  request_key: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  expected_revision: revision, expected_release_id: releaseID.nullable(), visibility: z.literal("public"),
}).strict();
export const publicationSchema = z.object({
  artifact: z.object({
    version: z.literal(1), algorithm: z.literal("Ed25519"), signing_key_id: digestSchema,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    statement: z.object({
      ...scopeShape, product_id: productID, release_id: releaseID, source_revision: revision,
      source_document_digest: digestSchema, visibility: z.literal("public"),
      validator: validatorSchema, compatibility_checker: checkerSchema,
      model_revision: digestSchema, model: z.record(z.string(), z.unknown()),
      baseline: z.object({ release_id: releaseID, model_revision: digestSchema, model_version: z.string().max(64) }).strict().nullable(),
      published_at: date,
    }).strict(),
  }).strict(), trust: trustSchema,
}).strict();
export type Publication = z.infer<typeof publicationSchema>;
export const headSchema = z.object({ release: publicationSchema.nullable() }).strict();
const compatibilitySchema = z.object({
  version: z.literal(1), checker: checkerSchema,
  valid: z.literal(true), compatible: z.boolean(), comparison_digest: digestSchema,
  baseline: reportSchema, candidate: reportSchema,
  issues: z.array(issueSchema).max(32),
}).strict();
export const publishOperationSchema = z.object({
  operation_id: identifier("relop-"), principal_id: identifier("p-"), product_id: productID,
  request_digest: identifier(""), request: publishInputSchema,
  status: z.enum(["published", "rejected", "conflict"]), reason: z.string().nullable(),
  source_revision: revision, source_document_digest: digestSchema, head_release_id: releaseID.nullable(),
  validation: reportSchema.nullable(), compatibility: compatibilitySchema.nullable(),
  release: publicationSchema.nullable(), created_at: date,
}).strict();
export type PublishOperation = z.infer<typeof publishOperationSchema>;
function fail(): never { throw new APIError("invalid_response"); }
const sameScope = (one: z.infer<typeof trustSchema>, two: Pick<Publisher, "issuer" | "publisher_id" | "namespace">) =>
  one.issuer === two.issuer && one.publisher_id === two.publisher_id && one.namespace === two.namespace;

export async function verifyPublisher(raw: unknown, principal: string) {
  const value = publisherSchema.parse(raw), url = new URL(value.issuer);
  if (!/^p-[a-f0-9]{64}$/.test(principal) || value.issuer !== url.origin || url.username || url.password ||
    !["https:", "http:"].includes(url.protocol) || url.protocol === "http:" && !["127.0.0.1", "[::1]"].includes(url.hostname)) fail();
  const hash = await textHash("LimeIoT Publisher v1\n" + value.issuer + "\n" + principal);
  if (value.publisher_id !== "publisher-" + hash || value.namespace !== "p-" + hash.slice(0, 30) || value.trust && !sameScope(value.trust, value)) fail();
  return value;
}

// 可信API资源绑定检查；验签、兼容性和安装授权由核心组件承担。
export async function verifyPublication(raw: unknown, product: string, principal: string) {
  const value = publicationSchema.parse(raw), statement = value.artifact.statement;
  if (statement.validator === "limeiot.model/1.0.0" ?
    statement.compatibility_checker !== "limeiot.model-compatibility/1.0.0" || !legacyModel(statement.model) :
    statement.compatibility_checker !== "limeiot.model-compatibility/1.1.0") fail();
  if (new TextEncoder().encode(JSON.stringify(value.artifact)).length > 12288 ||
    statement.product_id !== product || !sameScope(value.trust, statement) ||
    value.artifact.signing_key_id !== value.trust.signing_key_id ||
    statement.model_revision !== await digest(statement.model) ||
    typeof statement.model.model_id !== "string" || !statement.model.model_id.startsWith("urn:" + statement.namespace + ":")) fail();
  parseDraft(JSON.stringify(statement.model));
  await verifyPublisher({ issuer: statement.issuer, publisher_id: statement.publisher_id, namespace: statement.namespace, trust: value.trust }, principal);
  return value;
}

export async function verifyPublishOperation(raw: unknown, entry: Entry, principal: string) {
  const value = publishOperationSchema.parse(raw), request = publishInputSchema.parse(entry.input);
  if (entry.kind !== "release" || entry.key !== request.request_key || value.principal_id !== principal ||
    value.product_id !== entry.scope || !sameJSON(value.request, request) ||
    "sha256:" + value.request_digest !== await digest({ kind: "releases.create", product_id: entry.scope, request })) fail();
  if (value.status === "conflict") {
    if (value.release !== null || value.validation !== null || value.compatibility !== null ||
      !["draft_revision_conflict", "release_baseline_conflict"].includes(value.reason ?? "") ||
      value.reason === "draft_revision_conflict" && value.source_revision === request.expected_revision ||
      value.reason === "release_baseline_conflict" && (value.source_revision !== request.expected_revision || value.head_release_id === request.expected_release_id)) fail();
    return value;
  }
  if (value.source_revision !== request.expected_revision || value.head_release_id !== request.expected_release_id || !value.validation) fail();
  await verifyReport(value.validation, value.source_document_digest);
  if (value.compatibility) {
    const compared = value.compatibility;
    if (compared.compatible !== (compared.issues.length === 0) || !sameJSON(compared.candidate, value.validation) ||
      compared.checker === "limeiot.model-compatibility/1.0.0" &&
      (compared.baseline.validator !== "limeiot.model/1.0.0" || compared.candidate.validator !== "limeiot.model/1.0.0") ||
      !compared.baseline.valid || !compared.baseline.document_digest || compared.baseline.document_digest !== compared.baseline.model_revision) fail();
    await verifyReport(compared.baseline, compared.baseline.document_digest);
  }
  if (value.status === "published") {
    if (value.reason !== null || !value.validation.valid || request.expected_release_id === null && value.compatibility !== null ||
      request.expected_release_id !== null && !value.compatibility?.compatible) fail();
    const release = await verifyPublication(value.release, entry.scope, principal), statement = release.artifact.statement;
    if (statement.validator !== value.validation.validator ||
      value.compatibility && statement.compatibility_checker !== value.compatibility.checker ||
      statement.source_revision !== value.source_revision || statement.source_document_digest !== value.source_document_digest ||
      statement.model_revision !== value.validation.model_revision || !sameJSON(statement.model, value.validation.normalized_model) ||
      (statement.baseline?.release_id ?? null) !== request.expected_release_id || statement.baseline !== null &&
      (statement.baseline.model_revision !== value.compatibility?.baseline.model_revision || statement.baseline.model_version !== value.compatibility?.baseline.normalized_model?.model_version)) fail();
  } else if (value.release !== null || !["invalid_release_model", "release_model_namespace_mismatch", "incompatible_release_model", "model_id_already_published"].includes(value.reason ?? "") ||
    value.reason === "invalid_release_model" && value.validation.valid || value.reason === "incompatible_release_model" && !value.compatibility ||
    value.reason === "incompatible_release_model" && value.compatibility?.compatible) fail();
  return value;
}
