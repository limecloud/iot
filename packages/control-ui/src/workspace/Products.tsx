import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Plus } from "lucide-react";
import {
  APIError,
  journal,
  original,
  pending,
  verifyProductOperation,
  type Entry,
} from "./api";
import {
  parseDraft,
  productOperationSchema,
  productSchema,
  productsSchema,
  sameJSON,
  type Product,
} from "./contracts";
import { useWorkspace } from "./context";
import { ModelCheck } from "./ModelCheck";
import { Publication } from "./Publication";
import {
  ActionLink,
  Badge,
  Empty,
  ErrorNotice,
  PageTitle,
  useResource,
  useJournal,
  useTask,
  when,
} from "./ui";

export function Products() {
  const { href, t } = useWorkspace(),
    params = new URLSearchParams(location.search),
    id = params.get("product");
  return id || params.get("new") === "1" ? (
    <>
      <a className="back-link" href={href("products")}>
        <ArrowLeft size={14} />
        {t("products")}
      </a>
      <ProductEditor key={id ?? "new"} id={id} />
    </>
  ) : (
    <ProductList />
  );
}
function ProductList() {
  const { call, session, t, locale, href } = useWorkspace(),
    after = new URLSearchParams(location.search).get("after") ?? "";
  const products = useResource("products:" + after, async (signal) => {
    const value = await call(
      "/api/console/v1/products" +
        (after ? "?after=" + encodeURIComponent(after) : ""),
      productsSchema,
      undefined,
      signal,
    );
    if (
      value.items.some(
        (product, index) =>
          product.principal_id !== session.principal.principal_id ||
          product.product_id <= (value.items[index - 1]?.product_id ?? after),
      ) ||
      (value.next !== null && value.next !== value.items.at(-1)?.product_id)
    )
      throw new APIError("invalid_response");
    return value;
  });
  return (
    <>
      <PageTitle title={t("products")}>
        <ActionLink href={href("products", { new: "1" })}>
          <Plus size={16} />
          {t("newProduct")}
        </ActionLink>
      </PageTitle>
      <ErrorNotice error={products.error} retry={products.reload} />
      {products.loading ? (
        <p role="status">{t("loading")}</p>
      ) : products.data?.items.length ? (
        <div className="panel table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("products")}</th>
                <th>{t("status")}</th>
                <th>{t("updated")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {products.data.items.map((product) => (
                <tr key={product.product_id}>
                  <td>
                    <a
                      className="table-title"
                      href={href("products", { product: product.product_id })}
                    >
                      {product.name}
                    </a>
                    <code>{product.product_id}</code>
                  </td>
                  <td>
                    <Badge>{t("draft")}</Badge>
                  </td>
                  <td>{when(product.updated_at, locale)}</td>
                  <td>
                    <a href={href("products", { product: product.product_id })}>
                      {t("edit")}
                      <ArrowRight size={14} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        products.data && (
          <Empty title={t("productEmpty")} body={t("productEmptyBody")} />
        )
      )}
      {products.data?.next && (
        <a
          className="button pagination"
          href={href("products", { after: products.data.next })}
        >
          {t("loadMore")}
        </a>
      )}
      <DraftHistory />
    </>
  );
}
function ProductEditor({ id }: { id: string | null }) {
  const { call, session, t, href, navigate } = useWorkspace(),
    principal = session.principal.principal_id;
  const [name, setName] = useState(""),
    [text, setText] = useState("{}"),
    [revision, setRevision] = useState(""),
    [notice, setNotice] = useState(""),
    [server, setServer] = useState<Product>();
  const task = useTask(),
    initialized = useRef(false);
  const records = useJournal("editor-originals:" + id, principal, (entries) =>
    entries.filter(
      (entry) =>
        entry.scope === (id ?? "") &&
        ["product.create", "product.save"].includes(entry.kind) &&
        pending(entry),
    ),
  );
  const latest = useResource("editor:" + id, async (signal) => {
    if (!id) return null;
    if (!/^product-[a-f0-9]{64}$/.test(id))
      throw new APIError("invalid_request");
    const value = await call(
      "/api/console/v1/products/" + encodeURIComponent(id),
      productSchema,
      undefined,
      signal,
    );
    if (value.principal_id !== principal || value.product_id !== id)
      throw new APIError("invalid_response");
    return value;
  });
  useEffect(() => {
    if (latest.data) setServer(latest.data);
  }, [latest.data]);
  useEffect(() => {}, [latest.data]);
  useEffect(() => {
    if (
      initialized.current ||
      records.data === undefined ||
      latest.data === undefined
    )
      return;
    const entry = records.data[0];
    setName(String(entry?.input.name ?? latest.data?.name ?? ""));
    setText(
      JSON.stringify(entry?.input.model ?? latest.data?.model ?? {}, null, 2),
    );
    setRevision(
      String(entry?.input.expected_revision ?? latest.data?.revision ?? ""),
    );
    initialized.current = true;
  }, [latest.data, records.data]);
  async function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    await task.run(async () => {
      const log = journal(principal);
      if (
        log
          .list()
          .some(
            (entry) =>
              ["product.create", "product.save"].includes(entry.kind) &&
              entry.scope === (id ?? "") &&
              pending(entry),
          )
      )
        throw new APIError("pending_original");
      let model: Record<string, unknown>;
      try {
        model = parseDraft(text);
      } catch {
        throw new APIError("invalid_draft_document");
      }
      if (!name.trim() || Array.from(name.trim()).length > 80)
        throw new APIError("invalid_request");
      const entry = original(id ? "product.save" : "product.create", id ?? "", {
        name: name.trim(),
        model,
        ...(id ? { expected_revision: revision } : {}),
      });
      log.save(entry);
      try {
        const raw = await call(
          id
            ? `/api/console/v1/products/${encodeURIComponent(id)}/drafts`
            : "/api/console/v1/products",
          productOperationSchema,
          entry.input,
        );
        const result = verifyProductOperation(raw, entry, principal);
        log.save({ ...entry, result });
        if (!id) {
          navigate(href("products", { product: result.product_id }));
          return;
        }
        setServer(result.product);
        if (result.status === "saved") setRevision(result.product.revision);
        setNotice(t(result.status === "saved" ? "saved" : "conflict"));
      } catch (error) {
        if (
          error instanceof APIError &&
          [
            "forbidden",
            "csrf_rejected",
            "origin_rejected",
            "invalid_request",
            "invalid_draft_document",
            "product_capacity_reached",
          ].includes(error.code)
        )
          log.save({ ...entry, rejection: error.code });
        throw error;
      } finally {
        records.reload();
      }
    });
  }
  const locked =
    task.busy ||
    records.loading ||
    !!records.error ||
    latest.loading ||
    !!latest.error ||
    !!records.data?.length;
  let clean = false;
  try { clean = !!server && server.revision === revision && server.name === name.trim() && sameJSON(server.model, parseDraft(text)); } catch { /* 非法或未保存输入不能发布。 */ }
  return (
    <>
      <PageTitle
        title={t(id ? "edit" : "newProduct")}
        description={t("draftBoundary")}
      />
      <ErrorNotice
        error={task.error ?? latest.error ?? records.error}
        retry={latest.error ? latest.reload : undefined}
      />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <section className="panel editor-panel">
        <div className="panel-heading">
          <h2>{t("products")}</h2>
          <Badge>{t("unvalidated")}</Badge>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="product-name">{t("productName")}</label>
          <input
            id="product-name"
            value={name}
            required
            maxLength={80}
            disabled={task.busy || latest.loading}
            onChange={(event) => setName(event.target.value)}
          />
          <label htmlFor="product-model">{t("modelJSON")}</label>
          <textarea
            id="product-model"
            className="model-editor"
            value={text}
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
            disabled={task.busy || latest.loading}
          />
          <div className="actions">
            <button className="primary" disabled={locked}>
              {t(id ? "save" : "newProduct")}
            </button>
            {id && (
              <button
                type="button"
                disabled={task.busy || latest.loading}
                onClick={() => {
                  latest.reload();
                  setNotice(t("latestRead"));
                }}
              >
                {t("latest")}
              </button>
            )}
          </div>
        </form>
      </section>
      <ModelCheck text={text} disabled={task.busy || latest.loading} />
      {server && <Publication key={principal + ":" + server.product_id} product={server} clean={clean} disabled={locked} />}
      {server && (
        <section className="panel panel-body">
          <h2>{t("serverDraft")}</h2>
          <dl>
            <dt>{t("revision")}</dt>
            <dd>
              <code>{server.revision}</code>
            </dd>
            <dt>{t("digest")}</dt>
            <dd>
              <code>{server.document_digest}</code>
            </dd>
          </dl>
          {server.revision !== revision && (
            <button
              disabled={locked}
              onClick={() => {
                setRevision(server.revision);
                setNotice(t("latestRead"));
              }}
            >
              {t("adopt")}
            </button>
          )}
          <details>
            <summary>{t("modelJSON")}</summary>
            <pre>{JSON.stringify(server.model, null, 2)}</pre>
          </details>
        </section>
      )}
      <DraftHistory
        scope={id ?? ""}
        onResolved={() => {
          records.reload();
          latest.reload();
        }}
      />
    </>
  );
}
function DraftHistory({
  scope,
  onResolved,
}: {
  scope?: string;
  onResolved?: () => void;
}) {
  const { session, call, t, locale, href } = useWorkspace(),
    principal = session.principal.principal_id,
    task = useTask();
  const records = useJournal("draft-history:" + scope, principal, (entries) => {
    const values = entries.filter(
      (entry) =>
        ["product.create", "product.save"].includes(entry.kind) &&
        (scope === undefined || scope === entry.scope),
    );
    values.forEach((entry) => {
      if (entry.result !== undefined)
        verifyProductOperation(entry.result, entry, principal);
    });
    return values;
  });
  async function query(entry: Entry) {
    await task.run(async () => {
      const raw = await call(
        "/api/console/v1/product-operations/by-key/" +
          encodeURIComponent(entry.key),
        productOperationSchema,
      );
      const result = verifyProductOperation(raw, entry, principal);
      journal(principal).save({ ...entry, result });
      records.reload();
      onResolved?.();
    });
  }
  if (records.data?.length === 0 && !records.error && !task.error) return null;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{t("productHistory")}</h2>
      </div>
      <ErrorNotice error={task.error ?? records.error} />
      {records.data?.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("products")}</th>
                <th>{t("status")}</th>
                <th>{t("created")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {records.data.map((entry) => {
                const result = entry.result
                  ? productOperationSchema.parse(entry.result)
                  : undefined;
                return (
                  <tr key={entry.key}>
                    <td>
                      {String(entry.input.name)}
                      <code>{entry.key}</code>
                    </td>
                    <td>
                      <Badge warning={pending(entry)}>
                        {t(
                          entry.rejection
                            ? "rejected"
                            : result?.status === "saved"
                              ? "saved"
                              : result?.status === "conflict"
                                ? "conflictStatus"
                                : "pending",
                        )}
                      </Badge>
                    </td>
                    <td>{when(entry.created_at, locale)}</td>
                    <td>
                      {pending(entry) ? (
                        <button
                          disabled={task.busy}
                          onClick={() => void query(entry)}
                        >
                          {t("queryOriginal")}
                        </button>
                      ) : (
                        result && (
                          <a
                            href={href("products", {
                              product: result.product_id,
                            })}
                          >
                            {t("edit")}
                          </a>
                        )
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        records.data && (
          <p className="panel-body footnote">{t("operationEmpty")}</p>
        )
      )}
    </section>
  );
}
