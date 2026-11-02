import { z } from "zod";

const id = z.string().min(1).max(255);
const date = z.iso.datetime({ offset: true });
export const sessionSchema = z.object({
  audience: z.enum(["console", "admin"]),
  principal: z.object({ principal_id: id, name: z.string() }),
  csrf_token: z.string().min(32),
  expires_at: date,
});
export type Session = z.infer<typeof sessionSchema>;
export type Audience = Session["audience"];
export const spaceSchema = z.object({
  space_id: id,
  name: z.string(),
  created_at: date,
});
export const spacesSchema = z.object({
  spaces: z.array(spaceSchema).max(1000),
});
export type Space = z.infer<typeof spaceSchema>;
export const gatewaySchema = z.object({
  gateway_id: id,
  space_id: id,
  principal_id: id,
  local_space_id: id,
  revision: id,
  active: z.boolean(),
  scopes: z.array(z.string()),
  created_at: date,
});
export const gatewaysSchema = z.object({
  gateways: z.array(gatewaySchema).max(1000),
});
export type Gateway = z.infer<typeof gatewaySchema>;
export const connectionSchema = z.object({
  connected: z.boolean(),
  binding_revision: id.optional(),
  last_seen_at: date.nullish(),
});
export const pairSchema = z.object({
  control_origin: z.url(),
  code: z.string().regex(/^[a-f0-9]{64}$/),
  pairing: z.object({
    pairing_id: id,
    expires_at: date,
    claimed: z.boolean(),
    cancelled: z.boolean(),
  }),
});
export type Pair = z.infer<typeof pairSchema>;
export const productSchema = z.object({
  product_id: z.string().regex(/^product-[a-f0-9]{64}$/),
  principal_id: id,
  name: z.string(),
  revision: z.string().regex(/^prodrev-[a-f0-9]{64}$/),
  document_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  model: z.record(z.string(), z.unknown()),
  status: z.literal("draft"),
  validation: z.literal("unvalidated"),
  created_at: date,
  updated_at: date,
});
export type Product = z.infer<typeof productSchema>;
export const productsSchema = z.object({
  items: z.array(productSchema).max(16),
  next: z.string().nullable(),
});
export const productOperationSchema = z.object({
  operation_id: z.string().regex(/^prodop-[a-f0-9]{64}$/),
  principal_id: id,
  kind: z.enum(["products.create", "products.save"]),
  product_id: id,
  request_digest: z.string().regex(/^[a-f0-9]{64}$/),
  request: z.record(z.string(), z.unknown()),
  status: z.enum(["saved", "conflict"]),
  product: productSchema,
  created_at: date,
});
export const deviceSchema = z.object({
  device_id: id,
  model_revision: id,
  ready: z.boolean(),
  last_seen: date.nullable(),
  reported: z.record(
    z.string(),
    z.object({ value: z.unknown(), observed_at: date, quality: z.string() }),
  ),
});
export type Device = z.infer<typeof deviceSchema>;
export const devicesSchema = z.object({
  items: z.array(deviceSchema).max(128),
  next: z.string().nullable(),
  binding_revision: id,
});
export const modelSchema = z.object({
  revision: id,
  model: z.object({
    model_id: id,
    services: z.array(
      z.object({
        id,
        properties: z.array(
          z.object({
            id,
            schema: z.object({
              type: z.string(),
              minimum: z.number().optional(),
              maximum: z.number().optional(),
            }),
            access: z.array(z.string()),
          }),
        ),
      }),
    ),
  }),
});
export type Model = z.infer<typeof modelSchema>["model"];
export const remoteSchema = z
  .object({
    remote_id: z.string().regex(/^remote-[a-f0-9]{64}$/),
    status: z.enum([
      "accepted",
      "dispatched",
      "unknown",
      "confirmed",
      "failed",
      "rejected",
      "expired",
    ]),
    request: z.record(z.string(), z.unknown()),
    local_result: z
      .looseObject({
        evidence: z.looseObject({ type: z.string().optional() }).nullish(),
      })
      .nullable(),
    created_at: date,
  })
  .refine(
    (value) =>
      value.status !== "confirmed" ||
      value.local_result?.evidence?.type === "device_result",
  );
export type Remote = z.infer<typeof remoteSchema>;
export const terminal = (value: unknown) =>
  ["confirmed", "failed", "rejected", "expired"].includes(String(value));
export const statusSchema = z.object({
  storage: z.enum(["ready", "degraded"]),
  connections: z.number().int().nonnegative(),
  connection_capacity: z.number().int().nonnegative(),
  sampled_at: date,
});
export const summariesSchema = z.object({
  gateways: z
    .array(z.object({ gateway_id: id, active: z.boolean(), created_at: date }))
    .max(1000),
});
export const cliSchema = z.object({
  version: z.literal(1),
  origin: z.url(),
  audience: z.literal("console"),
  session: z.string().min(32),
  principal_id: id,
  expires_at: date,
});
export const nativeSchema = z.object({
  authorization_id: id,
  platform: z.enum(["ios", "android"]),
  status: z.enum(["pending", "approved", "denied", "cancelled"]),
  expires_at: date,
});

export function sameJSON(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

// 保留用户输入语义，拒绝 JSON.parse 会静默覆盖的重复字段。
export function parseDraft(text: string): Record<string, unknown> {
  if (new TextEncoder().encode(text).length > 8192)
    throw new Error("invalid_draft_document");
  const value: unknown = JSON.parse(text),
    stack: { keys?: Set<string>; key: boolean }[] = [];
  if (new TextEncoder().encode(JSON.stringify(value)).length > 8192)
    throw new Error("invalid_draft_document");
  let nodes = 0;
  for (const [token] of text.matchAll(
    /"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
  )) {
    const top = stack.at(-1);
    if (token === ":") continue;
    if (token === ",") {
      if (top?.keys) top.key = true;
      continue;
    }
    if (token === "}" || token === "]") {
      stack.pop();
      continue;
    }
    if (token.startsWith('"')) {
      const string: string = JSON.parse(token);
      if (!string.isWellFormed()) throw new Error("invalid_draft_document");
      if (top?.keys && top.key) {
        if (top.keys.has(string)) throw new Error("invalid_draft_document");
        top.keys.add(string);
        top.key = false;
        continue;
      }
    }
    if (++nodes > 2048 || stack.length > 16)
      throw new Error("invalid_draft_document");
    if (token === "{" || token === "[")
      stack.push({ keys: token === "{" ? new Set() : undefined, key: true });
    else if (/^-?\d/.test(token)) {
      const number = Number(token);
      if (
        !Number.isFinite(number) ||
        (Number.isInteger(number) && !Number.isSafeInteger(number))
      )
        throw new Error("invalid_draft_document");
    }
  }
  return z.record(z.string(), z.unknown()).parse(value);
}
