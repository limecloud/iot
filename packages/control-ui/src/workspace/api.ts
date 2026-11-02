import { z } from "zod";
import {
  productOperationSchema,
  remoteSchema,
  sameJSON,
  terminal,
  type Session,
} from "./contracts";

export class APIError extends Error {
  constructor(
    public code: string,
    public status = 0,
  ) {
    super(code);
  }
}
export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  session?: Session,
  input?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (!/^\/api\/(console|admin)\/v1\//.test(path))
    throw new APIError("invalid_request");
  const response = await fetch(path, {
    method: input === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: {
      ...(input === undefined ? {} : { "Content-Type": "application/json" }),
      ...(session ? { "X-CSRF-Token": session.csrf_token } : {}),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  const text = await response.text();
  if (text.length > 2_000_000)
    throw new APIError("invalid_response", response.status);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new APIError("invalid_response", response.status);
  }
  if (!response.ok) {
    const error = z
      .object({ error: z.object({ code: z.string() }) })
      .safeParse(value);
    throw new APIError(
      error.success ? error.data.error.code : "invalid_response",
      response.status,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new APIError("invalid_response", response.status);
  return parsed.data;
}
export type Call = <T>(
  path: string,
  schema: z.ZodType<T>,
  input?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
const entrySchema = z.object({
  version: z.literal(1),
  key: z.uuid(),
  created_at: z.iso.datetime(),
  kind: z.enum(["space", "pair", "product.create", "product.save", "remote", "release"]),
  scope: z.string(),
  input: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
  rejection: z.string().optional(),
});
export type Entry = z.infer<typeof entrySchema>;
const journalEvent = "limeiot:journal";
export function watchJournal(principal: string, notify: () => void) {
  const prefix = `limeiot.official:v1:${principal}:`;
  const local = (event: Event) => {
    if ((event as CustomEvent<string>).detail === principal) notify();
  };
  const remote = (event: StorageEvent) => {
    if (
      event.storageArea === localStorage &&
      (event.key === null || event.key.startsWith(prefix))
    )
      notify();
  };
  window.addEventListener(journalEvent, local);
  window.addEventListener("storage", remote);
  return () => {
    window.removeEventListener(journalEvent, local);
    window.removeEventListener("storage", remote);
  };
}
export function journal(principal: string, storage: Storage = localStorage) {
  const prefix = `limeiot.official:v1:${principal}:`;
  function parse(raw: string | null, key: string) {
    const value = entrySchema.parse(JSON.parse(raw ?? "null"));
    if (key !== prefix + value.key || value.input.request_key !== value.key)
      throw new APIError("local_record_invalid");
    return value;
  }
  function list(): Entry[] {
    const all: Entry[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) all.push(parse(storage.getItem(key), key));
    }
    return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  function save(value: Entry) {
    const key = prefix + value.key,
      raw = JSON.stringify(value);
    parse(raw, key);
    const previous = storage.getItem(key);
    if (previous) {
      const old = parse(previous, key);
      if (old.kind === "remote" && old.result !== undefined) {
        const before = remoteSchema.parse(old.result),
          after = remoteSchema.parse(value.result);
        if (
          before.remote_id !== after.remote_id ||
          !sameJSON(before.request, after.request) ||
          (terminal(before.status) && !sameJSON(before, after))
        )
          throw new APIError("local_record_changed");
      }
      if (
        !sameJSON(
          [old.kind, old.scope, old.input],
          [value.kind, value.scope, value.input],
        ) ||
        (old.result !== undefined &&
          !sameJSON(old.result, value.result) &&
          old.kind !== "remote") ||
        (old.rejection && old.rejection !== value.rejection)
      )
        throw new APIError("local_record_changed");
    }
    try {
      storage.setItem(key, raw);
      if (storage.getItem(key) !== raw) throw new Error();
    } catch {
      throw new APIError("local_record_unavailable");
    }
    if (typeof window !== "undefined")
      window.dispatchEvent(
        new CustomEvent(journalEvent, { detail: principal }),
      );
  }
  return { list, save };
}
export function original(
  kind: Entry["kind"],
  scope: string,
  input: Record<string, unknown>,
): Entry {
  const key = crypto.randomUUID();
  return {
    version: 1,
    key,
    created_at: new Date().toISOString(),
    kind,
    scope,
    input: { ...input, request_key: key },
  };
}
export const pending = (entry: Entry) =>
  !entry.rejection && entry.result === undefined;

export function verifyProductOperation(
  raw: unknown,
  entry: Entry,
  principal: string,
) {
  const value = productOperationSchema.parse(raw);
  if (
    value.principal_id !== principal ||
    value.product.principal_id !== principal ||
    value.product_id !== value.product.product_id ||
    value.kind !==
      (entry.kind === "product.create" ? "products.create" : "products.save") ||
    (entry.scope && value.product_id !== entry.scope) ||
    !sameJSON(value.request, entry.input) ||
    (entry.kind === "product.create" && value.status !== "saved") ||
    (value.status === "saved" &&
      (value.product.name !== entry.input.name ||
        !sameJSON(value.product.model, entry.input.model) ||
        (entry.kind === "product.save" &&
          value.product.revision === entry.input.expected_revision))) ||
    (value.status === "conflict" &&
      value.product.revision === entry.input.expected_revision)
  )
    throw new APIError("invalid_response");
  return value;
}
