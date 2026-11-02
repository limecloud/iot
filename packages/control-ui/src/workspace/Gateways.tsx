import { useEffect, useState } from "react";
import { z } from "zod";
import { Check, Copy, Plus } from "lucide-react";
import { APIError, journal, original, pending, type Entry } from "./api";
import {
  connectionSchema,
  gatewaysSchema,
  pairSchema,
  type Gateway,
  type Pair,
} from "./contracts";
import { useWorkspace } from "./context";
import {
  Badge,
  Empty,
  ErrorNotice,
  PageTitle,
  Refresh,
  useResource,
  useJournal,
  useTask,
  when,
} from "./ui";

export function Gateways() {
  const { space, t } = useWorkspace();
  return space ? (
    <GatewayPanel />
  ) : (
    <>
      <PageTitle title={t("gateways")} />
      <Empty title={t("chooseSpace")} body={t("noSpace")} />
    </>
  );
}
function GatewayPanel() {
  const { space, session, call, t, locale, href } = useWorkspace(),
    task = useTask(),
    prefix = `/api/console/v1/spaces/${encodeURIComponent(space!.space_id)}`;
  const [pair, setPair] = useState<Pair>(),
    [write, setWrite] = useState(false),
    [editing, setEditing] = useState(false),
    [revoke, setRevoke] = useState<Gateway>(),
    [message, setMessage] = useState(""),
    [now, setNow] = useState(Date.now());
  const gateways = useResource(
    "gateways:" + space!.space_id,
    async (signal) => {
      const value = await call(
        prefix + "/gateways",
        gatewaysSchema,
        undefined,
        signal,
      );
      if (
        value.gateways.some(
          (gateway) =>
            gateway.space_id !== space!.space_id ||
            gateway.principal_id !== session.principal.principal_id,
        )
      )
        throw new APIError("invalid_response");
      return value;
    },
  );
  const records = useJournal(
    "pair-originals:" + space!.space_id,
    session.principal.principal_id,
    (entries) =>
      entries.filter(
        (entry) =>
          entry.kind === "pair" &&
          entry.scope === space!.space_id &&
          pending(entry),
      ),
  );
  useEffect(() => {
    if (!pair) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pair]);
  async function create(entry?: Entry) {
    await task.run(async () => {
      const log = journal(session.principal.principal_id),
        all = log.list();
      if (
        !entry &&
        all.some(
          (item) =>
            item.kind === "pair" &&
            item.scope === space!.space_id &&
            pending(item),
        )
      )
        throw new APIError("pending_original");
      const request =
        entry ??
        original("pair", space!.space_id, {
          scopes: write ? ["commands.write", "devices.read"] : ["devices.read"],
        });
      log.save(request);
      const value = await call(prefix + "/pairings", pairSchema, request.input);
      if (value.control_origin !== location.origin)
        throw new APIError("invalid_response");
      log.save({ ...request, result: { resolved: true } });
      setPair(value);
      setEditing(false);
      setMessage("");
      setNow(Date.now());
      records.reload();
    });
  }
  const available =
    pair &&
    !pair.pairing.cancelled &&
    !pair.pairing.claimed &&
    Date.parse(pair.pairing.expires_at) > now;
  const active = gateways.data?.gateways.find((gateway) => gateway.active);
  useEffect(() => {
    if (active && pair) {
      setPair(undefined);
      setMessage(t("gatewayConnected"));
    }
  }, [active?.revision, pair]);
  return (
    <>
      <PageTitle title={t("gateways")}>
        {(!pair || active) && <Refresh busy={gateways.loading} onClick={gateways.reload} />}
        {active && <a className="button primary" href={href("devices")}>{t("stepDevices")}</a>}
      </PageTitle>
      <ErrorNotice
        error={task.error ?? gateways.error ?? records.error}
        retry={gateways.error ? gateways.reload : undefined}
      />
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {gateways.loading && !pair ? (
        <p role="status">{t("loading")}</p>
      ) : null}
      {!active && (gateways.data || pair) && (
        <section className="gateway-setup" aria-label={t("pairGateway")}>
          <h2>{t("pairGateway")}</h2>
          <ol className="pair-steps" aria-label={t("pairProgress")}>
            {["pairPermissions", "pairLocalApproval", "pairComplete"].map((key, index) => (
              <li key={key} aria-current={index === (pair && !editing ? 1 : 0) ? "step" : undefined}>
                <span>{index + 1}</span>{t(key as "pairPermissions" | "pairLocalApproval" | "pairComplete")}
              </li>
            ))}
          </ol>
          {!pair || editing ? (
            <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
              <fieldset disabled={task.busy}>
                <legend>{t("permissions")}</legend>
                <div className="required-permission"><Check size={16} />{t("readDevices")}<small>{t("requiredPermission")}</small></div>
                <label className="checkbox">
                  <input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)} />
                  {t("controlDevices")}
                </label>
              </fieldset>
              <p className="setup-instruction">{t("pairBody")}</p>
              {pair && available && <p className="footnote">{t("pairPreviousValid")}</p>}
              <div className="actions">
                <button className="primary" disabled={task.busy || records.loading || !!records.error || !!records.data?.length}>
                  <Plus size={16} />{t("generatePair")}
                </button>
                {editing && <button type="button" disabled={task.busy} onClick={() => setEditing(false)}>{t("cancel")}</button>}
              </div>
            </form>
          ) : (
            <div className="pair-result">
              <div className="pair-result-heading">
                <h3>{t(available ? "pairWaiting" : "pairExpired")}</h3>
                <span className="footnote">{t("pairExpires", { time: when(pair.pairing.expires_at, locale) })}</span>
              </div>
              {available ? (
                <>
                  <p className="setup-instruction">{t("pairPaste")}</p>
                  <div className="actions">
                    <button className="primary" onClick={() => {
                      void navigator.clipboard.writeText(JSON.stringify(pair))
                        .then(() => setMessage(t("copied")))
                        .catch(() => setMessage(t("copyFailed")));
                    }}><Copy size={16} />{t("copyPair")}</button>
                    <button disabled={gateways.loading} onClick={gateways.reload}>{t(gateways.loading ? "loading" : "checkBinding")}</button>
                  </div>
                  <details className="pair-raw">
                    <summary>{t("pairDetails")}</summary>
                    <label htmlFor="pair-data">{t("pairData")}</label>
                    <textarea id="pair-data" readOnly value={JSON.stringify(pair)} spellCheck={false} />
                  </details>
                </>
              ) : <p className="setup-instruction">{t("pairExpiredBody")}</p>}
              <button className="text-button pair-adjust" disabled={task.busy} onClick={() => { setEditing(true); setMessage(""); }}>{t(available ? "adjustPermissions" : "regeneratePair")}</button>
            </div>
          )}
        </section>
      )}
      {gateways.data?.gateways.length ? (
        <div className="panel table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("gateways")}</th>
                <th>{t("status")}</th>
                <th>{t("connection")}</th>
                <th>{t("permissions")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {gateways.data.gateways.map((gateway) => (
                <tr key={gateway.revision}>
                  <td>
                    <code>{gateway.gateway_id}</code>
                    <small>{when(gateway.created_at, locale)}</small>
                  </td>
                  <td>
                    <Badge good={gateway.active}>
                      {t(gateway.active ? "bound" : "revoked")}
                    </Badge>
                  </td>
                  <td>
                    {gateway.active ? (
                      <Connection gateway={gateway} prefix={prefix} />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {gateway.scopes.map((scope) => (
                      <Badge key={scope}>
                        {scope === "devices.read"
                          ? t("readDevices")
                          : scope === "commands.write"
                            ? t("controlDevices")
                            : scope}
                      </Badge>
                    ))}
                  </td>
                  <td>
                    {gateway.active && (
                      <button
                        className="danger"
                        disabled={task.busy}
                        onClick={() => setRevoke(gateway)}
                      >
                        {t("revoke")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {revoke && (
        <section
          className="panel confirmation"
          role="group"
          aria-label={t("revokeTitle")}
        >
          <h2>{t("revokeTitle")}</h2>
          <p>{t("revokeBody")}</p>
          <code>{revoke.gateway_id}</code>
          <div className="actions">
            <button
              className="danger"
              disabled={task.busy}
              onClick={() =>
                void task.run(async () => {
                  await call(
                    `${prefix}/gateways/${encodeURIComponent(revoke.gateway_id)}/revoke`,
                    z.object({ revoked: z.literal(true) }),
                    { revision: revoke.revision },
                  );
                  setRevoke(undefined);
                  setPair(undefined);
                  gateways.reload();
                })
              }
            >
              {t("confirmRevoke")}
            </button>
            <button disabled={task.busy} onClick={() => setRevoke(undefined)}>
              {t("cancel")}
            </button>
          </div>
        </section>
      )}
      {records.data?.map((entry) => (
        <div className="notice" key={entry.key}>
          <span>{t("pendingOriginal")}</span>
          <button disabled={task.busy} onClick={() => void create(entry)}>
            {t("resumeOriginal")}
          </button>
        </div>
      ))}
    </>
  );
}
function Connection({ gateway, prefix }: { gateway: Gateway; prefix: string }) {
  const { call, t } = useWorkspace();
  const state = useResource("connection:" + gateway.revision, (signal) =>
    call(
      `${prefix}/gateways/${encodeURIComponent(gateway.gateway_id)}/connection`,
      connectionSchema,
      undefined,
      signal,
    ),
  );
  return state.error ? (
    <span title={t("err_network")}>{t("unknown")}</span>
  ) : state.data ? (
    <Badge
      good={
        state.data.connected && state.data.binding_revision === gateway.revision
      }
    >
      {t(
        state.data.connected && state.data.binding_revision === gateway.revision
          ? "online"
          : "offline",
      )}
    </Badge>
  ) : (
    <span>{t("loading")}</span>
  );
}
