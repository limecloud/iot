import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { APIError, journal, original, type Entry } from "./api";
import {
  connectionSchema,
  devicesSchema,
  gatewaysSchema,
  modelSchema,
  remoteSchema,
  sameJSON,
  terminal,
  type Device,
  type Model,
  type Remote,
} from "./contracts";
import { useWorkspace } from "./context";
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
import type { MessageKey } from "./i18n";

function verifyRemote(raw: unknown, entry: Entry): Remote {
  const result = remoteSchema.parse(raw);
  const normalize = (value: Record<string, unknown>) => ({
    ...value,
    expires_at: Date.parse(String(value.expires_at)),
  });
  if (!sameJSON(normalize(result.request), normalize(entry.input)))
    throw new APIError("invalid_response");
  return result;
}
const unresolvedRemote = (entry: Entry) =>
  entry.kind === "remote" &&
  !entry.rejection &&
  !terminal((entry.result as Remote | undefined)?.status);

export function Devices() {
  const { space, t } = useWorkspace();
  return space ? (
    <DevicePanel />
  ) : (
    <>
      <PageTitle title={t("devices")} />
      <Empty title={t("chooseSpace")} body={t("noSpace")} />
    </>
  );
}
function DevicePanel() {
  const { space, call, session, t, href } = useWorkspace(),
    task = useTask(),
    principal = session.principal.principal_id;
  const prefix = `/api/console/v1/spaces/${encodeURIComponent(space!.space_id)}`,
    after = new URLSearchParams(location.search).get("after") ?? "";
  const [message, setMessage] = useState("");
  const records = useJournal(
    "device-originals:" + space!.space_id,
    principal,
    (entries) =>
      entries.filter(
        (entry) => entry.kind === "remote" && entry.scope === space!.space_id,
      ),
  );
  const state = useResource(
    "device-page:" + space!.space_id + ":" + after,
    async (signal) => {
      const all = await call(
        prefix + "/gateways",
        gatewaysSchema,
        undefined,
        signal,
      );
      const binding = all.gateways.find(
        (value) =>
          value.active &&
          value.space_id === space!.space_id &&
          value.principal_id === principal,
      );
      if (!binding)
        return {
          binding: undefined,
          connected: false,
          devices: [] as Device[],
          models: {} as Record<string, Model>,
          next: null as string | null,
        };
      const connection = await call(
        `${prefix}/gateways/${encodeURIComponent(binding.gateway_id)}/connection`,
        connectionSchema,
        undefined,
        signal,
      );
      if (
        connection.connected &&
        connection.binding_revision !== binding.revision
      )
        throw new APIError("model_changed");
      if (!connection.connected || !binding.scopes.includes("devices.read"))
        return {
          binding,
          connected: false,
          devices: [] as Device[],
          models: {} as Record<string, Model>,
          next: null as string | null,
        };
      const page = await call(
        prefix +
          "/devices" +
          (after ? "?after=" + encodeURIComponent(after) : ""),
        devicesSchema,
        undefined,
        signal,
      );
      if (
        page.binding_revision !== binding.revision ||
        (page.next === after && page.next !== null)
      )
        throw new APIError("model_changed");
      const revisions = [
        ...new Set(page.items.map((device) => device.model_revision)),
      ];
      const models = Object.fromEntries(
        await Promise.all(
          revisions.map(async (revision) => {
            const value = await call(
              `${prefix}/model-releases/${encodeURIComponent(revision)}`,
              modelSchema,
              undefined,
              signal,
            );
            if (value.revision !== revision)
              throw new APIError("invalid_response");
            return [revision, value.model];
          }),
        ),
      );
      return {
        binding,
        connected: true,
        devices: page.items,
        models,
        next: page.next,
      };
    },
  );
  async function control(device: Device, path: string, value: unknown) {
    await task.run(async () => {
      const current = state.data,
        log = journal(principal);
      if (
        !current?.binding ||
        !current.connected ||
        !device.ready ||
        !current.binding.scopes.includes("commands.write")
      )
        throw new APIError("forbidden");
      if (
        log
          .list()
          .some(
            (entry) =>
              entry.scope === space!.space_id &&
              entry.input.device_id === device.device_id &&
              unresolvedRemote(entry),
          )
      )
        throw new APIError("pending_original");
      const entry = original("remote", space!.space_id, {
        gateway_id: current.binding.gateway_id,
        binding_revision: current.binding.revision,
        device_id: device.device_id,
        model_revision: device.model_revision,
        expires_at: new Date(Date.now() + 25000).toISOString(),
        operation: { type: "property.set", path, value },
      });
      log.save(entry);
      try {
        const result = verifyRemote(
          await call(prefix + "/remote-commands", remoteSchema, entry.input),
          entry,
        );
        log.save({ ...entry, result });
        setMessage(t(result.status));
      } catch (error) {
        if (
          error instanceof APIError &&
          [
            "authentication_required",
            "identity_rejected",
            "forbidden",
            "csrf_rejected",
            "origin_rejected",
            "not_found",
            "invalid_request",
            "invalid_expiry",
            "remote_capacity_reached",
            "gateway_offline",
          ].includes(error.code)
        )
          log.save({ ...entry, rejection: error.code });
        throw error;
      } finally {
        records.reload();
      }
    });
  }
  return (
    <>
      <PageTitle title={t("devices")} description={space!.name}>
        <Refresh busy={state.loading} onClick={state.reload} />
      </PageTitle>
      <ErrorNotice
        error={state.error ?? task.error ?? records.error}
        retry={state.error ? state.reload : undefined}
      />
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {state.loading ? (
        <p role="status">{t("loading")}</p>
      ) : (
        state.data && (
          <>
            <div className="section-toolbar">
              <Badge good={state.data.connected}>
                {t(state.data.connected ? "online" : "offline")}
              </Badge>
              {state.data.binding && (
                <code>{state.data.binding.gateway_id}</code>
              )}
            </div>
            {state.data.devices.length ? (
              <div className="device-grid">
                {state.data.devices.map((device) => (
                  <DeviceCard
                    key={device.device_id}
                    device={device}
                    model={state.data!.models[device.model_revision]}
                    disabled={
                      task.busy ||
                      !state.data!.binding?.scopes.includes("commands.write") ||
                      records.loading ||
                      !!records.error ||
                      !!records.data?.some(
                        (entry) =>
                          entry.input.device_id === device.device_id &&
                          unresolvedRemote(entry),
                      )
                    }
                    onSet={(path, value) => void control(device, path, value)}
                  />
                ))}
              </div>
            ) : (
              <Empty title={t("deviceEmpty")} body={t("deviceEmptyBody")}>
                <ActionLink href={href("gateways")}>
                  {t("pairGateway")}
                </ActionLink>
              </Empty>
            )}
            {state.data.next && (
              <a
                className="button pagination"
                href={href("devices", { after: state.data.next })}
              >
                {t("loadMore")}
              </a>
            )}
          </>
        )
      )}
      {records.data?.some(unresolvedRemote) && (
        <div className="notice">
          <span>{t("pendingOriginal")}</span>
          <a href={href("operations")}>{t("queryOriginal")}</a>
        </div>
      )}
    </>
  );
}
function DeviceCard({
  device,
  model,
  disabled,
  onSet,
}: {
  device: Device;
  model: Model;
  disabled: boolean;
  onSet: (path: string, value: unknown) => void;
}) {
  const { t, locale } = useWorkspace();
  return (
    <article className="panel device-card">
      <div className="device-heading">
        <span className="device-icon">
          <Cpu size={23} />
        </span>
        <div>
          <h2>{device.device_id}</h2>
          <span>{model.model_id}</span>
        </div>
        <Badge good={device.ready}>
          {t(device.ready ? "online" : "offline")}
        </Badge>
      </div>
      <div className="device-properties">
        {model.services.flatMap((service) =>
          service.properties.map((property) => (
            <PropertyControl
              key={service.id + "." + property.id}
              path={service.id + "." + property.id}
              property={property}
              device={device}
              disabled={
                disabled || !device.ready || !property.access.includes("write")
              }
              onSet={(value) => onSet(service.id + "." + property.id, value)}
            />
          )),
        )}
      </div>
      <details>
        <summary>{t("deviceModel")}</summary>
        <dl>
          <dt>{t("lastSeen")}</dt>
          <dd>{when(device.last_seen, locale)}</dd>
          <dt>{t("revision")}</dt>
          <dd>
            <code>{device.model_revision}</code>
          </dd>
        </dl>
        <pre>{JSON.stringify(model, null, 2)}</pre>
      </details>
    </article>
  );
}
function PropertyControl({
  path,
  property,
  device,
  disabled,
  onSet,
}: {
  path: string;
  property: Model["services"][number]["properties"][number];
  device: Device;
  disabled: boolean;
  onSet: (value: unknown) => void;
}) {
  const { t } = useWorkspace(),
    observation = device.reported[path];
  const [value, setValue] = useState(String(observation?.value ?? ""));
  useEffect(() => {
    setValue(String(observation?.value ?? ""));
  }, [observation?.value]);
  if (property.schema.type === "boolean")
    return (
      <div className="property">
        <span>{property.id}</span>
        <button
          role="switch"
          aria-label={path}
          aria-checked={observation?.value === true}
          disabled={disabled || typeof observation?.value !== "boolean"}
          onClick={() => onSet(observation?.value !== true)}
        >
          {observation
            ? t(observation.value ? "on" : "off")
            : t("noObservation")}
        </button>
      </div>
    );
  if (["integer", "number"].includes(property.schema.type))
    return (
      <div className="property">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (value !== "" && Number.isFinite(Number(value)))
              onSet(Number(value));
          }}
        >
          <label htmlFor={device.device_id + path}>
            {property.id}
            <span className="footnote">
              {observation ? String(observation.value) : t("noObservation")}
            </span>
          </label>
          <div className="number-control">
            <input
              id={device.device_id + path}
              type="number"
              min={property.schema.minimum}
              max={property.schema.maximum}
              step={property.schema.type === "integer" ? 1 : "any"}
              required
              value={value}
              disabled={disabled}
              onChange={(event) => setValue(event.target.value)}
            />
            <button disabled={disabled}>{t("set")}</button>
          </div>
        </form>
      </div>
    );
  return (
    <div className="property">
      <span>{property.id}</span>
      <strong>
        {observation ? String(observation.value) : t("noObservation")}
      </strong>
    </div>
  );
}

export function Operations() {
  const { session, space, call, t, locale } = useWorkspace(),
    task = useTask();
  const [message, setMessage] = useState("");
  const records = useJournal(
    "operations:" + space?.space_id,
    session.principal.principal_id,
    (entries) => {
      const values = entries.filter(
        (entry) =>
          entry.kind === "remote" && (!space || entry.scope === space.space_id),
      );
      values.forEach((entry) => {
        if (entry.result) verifyRemote(entry.result, entry);
      });
      return values;
    },
  );
  async function query(entry: Entry, reconcile = false) {
    await task.run(async () => {
      const prefix = `/api/console/v1/spaces/${encodeURIComponent(entry.scope)}/remote-commands`;
      let value: Remote;
      try {
        value = verifyRemote(
          await call(
            prefix + "/by-key/" + encodeURIComponent(entry.key),
            remoteSchema,
          ),
          entry,
        );
      } catch (error) {
        if (error instanceof APIError && error.status === 404) {
          setMessage(t("originalNotFound"));
          return;
        }
        throw error;
      }
      if (reconcile && !terminal(value.status))
        value = verifyRemote(
          await call(
            prefix + "/" + encodeURIComponent(value.remote_id) + "/reconcile",
            remoteSchema,
            {},
          ),
          entry,
        );
      journal(session.principal.principal_id).save({ ...entry, result: value });
      records.reload();
      setMessage(t(value.status));
    });
  }
  return (
    <>
      <PageTitle title={t("operations")} description={t("operationBody")}>
        <Refresh busy={records.loading} onClick={records.reload} />
      </PageTitle>
      <ErrorNotice error={task.error ?? records.error} />
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {records.loading ? (
        <p role="status">{t("loading")}</p>
      ) : records.data?.length ? (
        <div className="panel table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("devices")}</th>
                <th>{t("originalOperation")}</th>
                <th>{t("status")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {records.data.map((entry) => {
                const result = entry.result as Remote | undefined,
                  status = entry.rejection
                    ? "rejected"
                    : (result?.status ?? "unknown");
                return (
                  <tr key={entry.key}>
                    <td>
                      {String(entry.input.device_id)}
                      <small>{when(entry.created_at, locale)}</small>
                    </td>
                    <td>
                      <code>{result?.remote_id ?? entry.key}</code>
                    </td>
                    <td>
                      <Badge
                        good={status === "confirmed"}
                        warning={status === "unknown"}
                      >
                        {t(status as MessageKey)}
                      </Badge>
                    </td>
                    <td>
                      {!entry.rejection && (
                        <div className="actions">
                          <button
                            disabled={task.busy}
                            onClick={() => void query(entry)}
                          >
                            {t("queryOriginal")}
                          </button>
                          {!terminal(result?.status) && (
                            <button
                              disabled={task.busy}
                              onClick={() => void query(entry, true)}
                            >
                              {t("reconcile")}
                            </button>
                          )}
                        </div>
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
          <Empty title={t("operationEmpty")} body={t("operationBody")} />
        )
      )}
    </>
  );
}
