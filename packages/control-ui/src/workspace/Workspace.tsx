import { useState } from "react";
import { z } from "zod";
import {
  ArrowRight,
  Boxes,
  Cpu,
  House,
  Network,
  ShieldCheck,
} from "lucide-react";
import { APIError, journal, original, pending, type Entry } from "./api";
import { useWorkspace } from "./context";
import {
  cliSchema,
  gatewaysSchema,
  nativeSchema,
  productsSchema,
  spaceSchema,
  statusSchema,
  summariesSchema,
} from "./contracts";
import {
  ActionLink,
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

export function Overview() {
  const { call, t, spaces, space, href } = useWorkspace();
  const products = useResource("overview-products", (signal) =>
    call("/api/console/v1/products", productsSchema, undefined, signal),
  );
  const gateways = useResource(
    "overview-gateways:" + space?.space_id,
    (signal) =>
      space
        ? call(
            `/api/console/v1/spaces/${encodeURIComponent(space.space_id)}/gateways`,
            gatewaysSchema,
            undefined,
            signal,
          )
        : Promise.resolve({ gateways: [] }),
  );
  const steps = [
    ["stepProduct", "stepProductBody", "products", Boxes],
    ["stepSpace", "stepSpaceBody", "spaces", House],
    ["stepGateway", "stepGatewayBody", "gateways", Network],
    ["stepDevices", "stepDevicesBody", "devices", Cpu],
  ] as const;
  return (
    <>
      <PageTitle title={t("overview")}>
        <ActionLink href={href("products", { new: "1" })}>{t("newProduct")}</ActionLink>
      </PageTitle>
      <div className="metrics">
        {[
          [t("visibleProducts"), products.data?.items.length, Boxes],
          [t("spaceCount"), spaces?.length, House],
          [
            t("gatewayCount"),
            space ? gateways.data?.gateways.length : undefined,
            Network,
          ],
        ].map(([label, count, Icon], index) => {
          const Glyph = Icon as typeof Boxes;
          return (
            <div className="metric" key={index}>
              <div>
                <span>{String(label)}</span>
                <Glyph size={20} />
              </div>
              <strong>{typeof count === "number" ? count : "—"}</strong>
            </div>
          );
        })}
      </div>
      <ErrorNotice
        error={products.error ?? gateways.error}
        retry={() => {
          products.reload();
          gateways.reload();
        }}
      />
      <section className="panel onboarding">
        <div className="panel-heading">
          <h2>{t("getStarted")}</h2>
          <a href="/docs/quick-start/">
            {t("docs")}
            <ArrowRight size={14} />
          </a>
        </div>
        <div className="onboarding-grid">
          {steps.map(([title, body, view, Icon]) => (
            <a href={href(view)} key={view}>
              <div className="step-icon">
                <Icon size={22} />
              </div>
              <h3>{t(title)}</h3>
              <p>{t(body)}</p>
              <ArrowRight size={16} />
            </a>
          ))}
        </div>
      </section>
    </>
  );
}

export function Spaces({ reload }: { reload: () => void }) {
  const { session, spaces, t, locale, call, href, navigate } = useWorkspace(),
    task = useTask();
  const records = useJournal(
    "space-originals",
    session.principal.principal_id,
    (entries) =>
      entries.filter((entry) => entry.kind === "space" && pending(entry)),
  );
  async function create(entry: Entry) {
    await task.run(async () => {
      const log = journal(session.principal.principal_id);
      log.list();
      log.save(entry);
      const space = await call(
        "/api/console/v1/spaces",
        spaceSchema,
        entry.input,
      );
      if (space.name !== entry.input.name)
        throw new APIError("invalid_response");
      log.save({ ...entry, result: space });
      reload();
      navigate(href("gateways", { space: space.space_id }));
    });
    records.reload();
  }
  return (
    <>
      <PageTitle title={t("spaces")} />
      <ErrorNotice error={task.error ?? records.error} />
      {spaces === undefined ? (
        <p role="status">{t("loading")}</p>
      ) : spaces.length ? (
        <div className="panel table-scroll">
          <table>
            <thead><tr><th>{t("spaceName")}</th><th>{t("created")}</th><th>{t("actions")}</th></tr></thead>
            <tbody>{spaces.map((space) => (
              <tr key={space.space_id}>
                <td><a className="table-title" href={href("gateways", { space: space.space_id })}>{space.name}</a><code>{space.space_id}</code></td>
                <td>{when(space.created_at, locale)}</td>
                <td><a href={href("gateways", { space: space.space_id })}>{t("enterSpace")}</a></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
      {records.data?.map((entry) => (
        <div key={entry.key} className="notice">
          <span>
            {t("pendingOriginal")}
            <code>{entry.key}</code>
          </span>
          <button disabled={task.busy} onClick={() => void create(entry)}>
            {t("resumeOriginal")}
          </button>
        </div>
      ))}
      <section className="panel form-panel">
        <h2>{t("newSpace")}</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const name = String(
              new FormData(event.currentTarget).get("name") ?? "",
            ).trim();
            if (!name || Array.from(name).length > 80) return;
            void create(original("space", "", { name }));
          }}
        >
          <label>
            {t("spaceName")}
            <input
              name="name"
              required
              maxLength={80}
              disabled={
                task.busy ||
                records.loading ||
                !!records.error ||
                !!records.data?.length
              }
              placeholder={locale === "zh-CN" ? "例如：家或工作室" : "e.g. Home or studio"}
            />
          </label>
          <button
            className="primary"
            disabled={
              task.busy ||
              records.loading ||
              !!records.error ||
              !!records.data?.length
            }
          >
            {t("newSpace")}
          </button>
        </form>
      </section>
    </>
  );
}

export function Developer({ native }: { native?: string }) {
  const { call, session, t, locale } = useWorkspace(),
    task = useTask();
  const [material, setMaterial] = useState<z.infer<typeof cliSchema>>(),
    [code, setCode] = useState("");
  const review = useResource("native:" + native, (signal) => {
    if (!native) return Promise.resolve(null);
    if (!/^na-[a-f0-9]{64}$/.test(native))
      return Promise.reject(new APIError("invalid_request"));
    return call(
      `/api/console/v1/native-authorizations/${native}`,
      nativeSchema,
      undefined,
      signal,
    );
  });
  async function decide(decision: "approve" | "deny") {
    await task.run(async () => {
      if (
        !review.data ||
        review.data.status !== "pending" ||
        Date.parse(review.data.expires_at) <= Date.now()
      )
        throw new APIError("native_authorization_expired");
      await call(
        `/api/console/v1/native-authorizations/${native}`,
        z.object({ status: z.enum(["approved", "denied"]) }),
        { decision, user_code: code },
      );
      setCode("");
      review.reload();
    });
  }
  return (
    <>
      <PageTitle
        title={t(native ? "nativeTitle" : "connections")}
        description={native ? t("nativeBody") : undefined}
      />
      <ErrorNotice error={task.error ?? review.error} />
      {native ? (
        <section className="panel form-panel">
          {review.loading ? (
            <p role="status">{t("loading")}</p>
          ) : (
            review.data && (
              <>
                <dl>
                  <dt>{t("account")}</dt>
                  <dd>{session.principal.name}</dd>
                  <dt>{t("connections")}</dt>
                  <dd>
                    LimeIoT {review.data.platform === "ios" ? "iOS" : "Android"}
                  </dd>
                  <dt>{t("sessionExpires")}</dt>
                  <dd>{when(review.data.expires_at, locale)}</dd>
                </dl>
                {review.data.status === "pending" &&
                Date.parse(review.data.expires_at) > Date.now() ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void decide("approve");
                    }}
                  >
                    <label>
                      {t("nativeCode")}
                      <input
                        value={code}
                        onChange={(event) =>
                          setCode(event.target.value.toUpperCase())
                        }
                        pattern="[A-Fa-f0-9]{8}"
                        minLength={8}
                        maxLength={8}
                        autoComplete="off"
                        required
                        disabled={task.busy}
                      />
                    </label>
                    <div className="actions">
                      <button
                        className="primary"
                        disabled={task.busy || code.length !== 8}
                      >
                        {t("approve")}
                      </button>
                      <button
                        type="button"
                        disabled={task.busy || code.length !== 8}
                        onClick={() => void decide("deny")}
                      >
                        {t("deny")}
                      </button>
                    </div>
                  </form>
                ) : (
                  <p role="status">{t("nativeDone")}</p>
                )}
              </>
            )
          )}
        </section>
      ) : (
        <section className="panel form-panel">
          <h2>{t("cliTitle")}</h2>
          <p>{t("cliBody")}</p>
          {!material ? (
            <button
              className="primary"
              disabled={task.busy}
              onClick={() =>
                void task.run(async () => {
                  const value = await call(
                    "/api/console/v1/auth/cli",
                    cliSchema,
                    {},
                  );
                  if (
                    value.principal_id !== session.principal.principal_id ||
                    value.origin !== location.origin ||
                    Date.parse(value.expires_at) <= Date.now()
                  )
                    throw new APIError("invalid_response");
                  setMaterial(value);
                })
              }
            >
              {t("createCLI")}
            </button>
          ) : (
            <>
              <p className="notice">{t("secretNotice")}</p>
              <label htmlFor="cli-material">{t("cliMaterial")}</label>
              <textarea
                id="cli-material"
                readOnly
                spellCheck={false}
                value={JSON.stringify(material)}
              />
              <p className="footnote">
                {t("pairExpires", { time: when(material.expires_at, locale) })}
              </p>
              <button onClick={() => setMaterial(undefined)}>
                {t("hideSecret")}
              </button>
            </>
          )}
        </section>
      )}
    </>
  );
}

export function Account({ accountURL }: { accountURL?: string }) {
  const { session, t, locale } = useWorkspace();
  return (
    <>
      <PageTitle title={t("account")} />
      <section className="panel form-panel">
        <div className="profile-avatar">
          <UserInitial name={session.principal.name} />
        </div>
        <h2>{session.principal.name}</h2>
        <dl>
          <dt>{t("account")}</dt>
          <dd>
            <code>{session.principal.principal_id}</code>
          </dd>
          <dt>{t("sessionExpires")}</dt>
          <dd>{when(session.expires_at, locale)}</dd>
          <dt>{t("permissions")}</dt>
          <dd>
            <Badge>{t(session.audience)}</Badge>
          </dd>
        </dl>
        {accountURL && (
          <ActionLink href={accountURL}>{t("accountSecurity")}</ActionLink>
        )}
      </section>
    </>
  );
}
function UserInitial({ name }: { name: string }) {
  return <>{Array.from(name)[0]?.toUpperCase() ?? "L"}</>;
}

export function Admin() {
  const { call, t, locale } = useWorkspace();
  const health = useResource("admin-status", (signal) =>
    call("/api/admin/v1/status", statusSchema, undefined, signal),
  );
  const bindings = useResource("admin-bindings", (signal) =>
    call("/api/admin/v1/gateways", summariesSchema, undefined, signal),
  );
  return (
    <>
      <PageTitle title={t("admin")}>
        <Refresh
          busy={health.loading || bindings.loading}
          onClick={() => {
            health.reload();
            bindings.reload();
          }}
        />
      </PageTitle>
      <ErrorNotice error={health.error ?? bindings.error} />
      <div className="metrics">
        <div className="metric">
          <span>{t("storage")}</span>
          <strong>{health.data ? t(health.data.storage) : "—"}</strong>
        </div>
        <div className="metric">
          <span>{t("liveConnections")}</span>
          <strong>{health.data?.connections ?? "—"}</strong>
        </div>
        <div className="metric">
          <span>{t("capacity")}</span>
          <strong>{health.data?.connection_capacity ?? "—"}</strong>
        </div>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>{t("bindingSummary")}</h2>
          <ShieldCheck size={18} />
        </div>
        {bindings.data?.gateways.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("gateways")}</th>
                  <th>{t("status")}</th>
                  <th>{t("created")}</th>
                </tr>
              </thead>
              <tbody>
                {bindings.data.gateways.map((gateway, index) => (
                  <tr key={gateway.gateway_id + index}>
                    <td>
                      <code>{gateway.gateway_id}</code>
                    </td>
                    <td>
                      <Badge good={gateway.active}>
                        {t(gateway.active ? "bound" : "revoked")}
                      </Badge>
                    </td>
                    <td>{when(gateway.created_at, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : bindings.loading ? (
          <p role="status" className="panel-body">
            {t("loading")}
          </p>
        ) : (
          bindings.data && <Empty title={t("empty")} />
        )}
        <p className="panel-body footnote">
          {health.data &&
            " " + t("sampled", { time: when(health.data.sampled_at, locale) })}
        </p>
      </section>
    </>
  );
}
