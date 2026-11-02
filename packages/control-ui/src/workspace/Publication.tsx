import { useEffect, useRef, useState } from "react";
import { APIError, journal, original, pending, watchJournal, type Entry } from "./api";
import { type Product } from "./contracts";
import { useWorkspace } from "./context";
import {
  headSchema, publisherSchema, publishOperationSchema, verifyPublication,
  verifyPublisher, verifyPublishOperation, type PublishOperation,
} from "./publication-contracts";
import { ErrorNotice, useResource, useTask, when } from "./ui";

function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Publication({ product, clean, disabled }: { product: Product; clean: boolean; disabled: boolean }) {
  const { session, call, t, locale } = useWorkspace(), principal = session.principal.principal_id;
  const base = "/api/console/v1/products/" + encodeURIComponent(product.product_id) + "/releases";
  const [review, setReview] = useState(false), [notice, setNotice] = useState("");
  const task = useTask(), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = useResource("publication:" + principal + ":" + product.product_id, async (signal) => {
    const [owner, head] = await Promise.all([
      call("/api/console/v1/publisher", publisherSchema, undefined, signal),
      call(base + "/head", headSchema, undefined, signal),
    ]);
    const publisher = await verifyPublisher(owner, principal);
    const release = head.release === null ? null : await verifyPublication(head.release, product.product_id, principal);
    if (release && (release.artifact.statement.issuer !== publisher.issuer || release.artifact.statement.publisher_id !== publisher.publisher_id)) throw new APIError("invalid_response");
    return { publisher, release };
  });
  const records = useResource("publication-originals:" + principal + ":" + product.product_id, async () => {
    const entries = journal(principal).list().filter(entry => entry.kind === "release" && entry.scope === product.product_id);
    return Promise.all(entries.map(async entry => ({
      entry,
      result: entry.result === undefined ? undefined : await verifyPublishOperation(entry.result, entry, principal),
    })));
  });
  useEffect(() => watchJournal(principal, records.reload), [principal, records.reload]);
  const status = (entry: Entry, result?: PublishOperation) => t(entry.rejection ? "rejected" :
    result?.status === "published" ? "published" : result?.status === "conflict" ? "conflictStatus" : result?.status === "rejected" ? "releaseRejected" : "pending");

  async function publish() {
    if (!clean || !current.data?.publisher.trust || review || disabled || records.loading || records.error) return;
    await task.run(async () => {
      const log = journal(principal);
      if (log.list().some(entry => entry.kind === "release" && entry.scope === product.product_id && pending(entry))) throw new APIError("pending_original");
      const entry = original("release", product.product_id, {
        expected_revision: product.revision,
        expected_release_id: current.data!.release?.artifact.statement.release_id ?? null,
        visibility: "public",
      });
      log.save(entry);
      setNotice("");
      try {
        const raw = await call(base, publishOperationSchema, entry.input);
        const result = await verifyPublishOperation(raw, entry, principal);
        log.save({ ...entry, result });
        if (alive.current) {
          setNotice(status(entry, result));
          if (result.status === "published") current.reload();
          else setReview(true);
        }
      } catch (error) {
        if (error instanceof APIError && ["invalid_request", "forbidden", "origin_rejected", "csrf_rejected", "release_capacity_reached"].includes(error.code)) {
          log.save({ ...entry, rejection: error.code });
          throw error;
        }
        throw new APIError("release_result_unknown");
      } finally { records.reload(); }
    });
  }
  async function resolve(entry: Entry) {
    await task.run(async () => {
      try {
        const raw = await call("/api/console/v1/release-operations/by-key/" + encodeURIComponent(entry.key), publishOperationSchema);
        const result = await verifyPublishOperation(raw, entry, principal);
        journal(principal).save({ ...entry, result });
        if (alive.current) { setNotice(status(entry, result)); setReview(true); }
      } catch (error) {
        if (error instanceof APIError && error.status === 404) throw new APIError("release_original_not_found");
        throw error;
      } finally { records.reload(); }
    });
  }
  const release = current.data?.release, waiting = records.data?.some(record => pending(record.entry));
  return <section className="panel" aria-label={t("modelPublication")}>
    <div className="panel-heading"><h2>{t("modelPublication")}</h2>
      <button type="button" disabled={task.busy || current.loading} onClick={() => { current.reload(); setReview(false); }}>{t("latestRelease")}</button>
    </div>
    <ErrorNotice error={task.error ?? current.error ?? records.error} retry={current.error ? current.reload : records.error ? records.reload : undefined} />
    <div className="panel-body">
      {notice && <p className="notice" role="status">{notice}</p>}
      {current.loading ? <p role="status">{t("loading")}</p> : current.data && <>
        <dl><dt>{t("publisherNamespace")}</dt><dd><code>{current.data.publisher.namespace}</code></dd>
          {current.data.publisher.trust && <><dt>{t("signingKey")}</dt><dd><code>{current.data.publisher.trust.signing_key_id}</code></dd></>}
          {release && <><dt>{t("currentVersion")}</dt><dd>{String(release.artifact.statement.model.model_version)}</dd>
            <dt>{t("releaseID")}</dt><dd><code>{release.artifact.statement.release_id}</code></dd>
            <dt>{t("candidateRevision")}</dt><dd><code>{release.artifact.statement.model_revision}</code></dd></>}
        </dl>
        {release ? <div className="actions">
          <button type="button" onClick={() => download(release.artifact.statement.release_id + ".json", release.artifact)}>{t("downloadArtifact")}</button>
          <button type="button" onClick={() => download(release.artifact.statement.release_id + "-trust.json", release.trust)}>{t("downloadTrust")}</button>
        </div> : <p className="muted">{t("noRelease")}</p>}
        {!current.data.publisher.trust && <p className="muted">{t("noReleaseKey")}</p>}
      </>}
      {!clean && <p className="muted">{t("saveBeforePublish")}</p>}
      {review && <p className="muted">{t("reviewRelease")}</p>}
      <div className="actions"><button className="primary" type="button"
        disabled={disabled || task.busy || current.loading || !!current.error || !current.data?.publisher.trust || records.loading || !!records.error || waiting || !clean || review}
        onClick={() => void publish()}>{t("publishSaved")}</button></div>
    </div>
    {!!records.data?.length && <div className="table-scroll"><table><thead><tr>
      <th>{t("originalOperation")}</th><th>{t("status")}</th><th>{t("created")}</th><th>{t("actions")}</th>
    </tr></thead><tbody>{records.data.map(({ entry, result }) => <tr key={entry.key}>
      <td><code>{entry.key}</code>{result?.reason && <code>{result.reason}</code>}</td><td>{status(entry, result)}</td><td>{when(entry.created_at, locale)}</td>
      <td>{pending(entry) ? <button type="button" disabled={task.busy} onClick={() => void resolve(entry)}>{t("queryRelease")}</button> : result?.release &&
        <button type="button" onClick={() => download(result.release!.artifact.statement.release_id + ".json", result.release!.artifact)}>{t("downloadArtifact")}</button>}</td>
    </tr>)}</tbody></table></div>}
  </section>;
}
