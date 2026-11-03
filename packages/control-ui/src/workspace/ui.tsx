import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { RefreshCw } from "lucide-react";
import { APIError, journal, watchJournal, type Entry } from "./api";
import { useWorkspace } from "./context";
import type { MessageKey, Translator } from "./i18n";
import messages from "./locales/en.json";

export function errorText(error: unknown, t: Translator) {
  if (!(error instanceof APIError)) return t("err_network");
  const key = `err_${error.code}` as MessageKey;
  return key in messages ? t(key) : t("err_other", { code: error.code });
}
export function useResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
) {
  const [version, setVersion] = useState(0),
    [state, setState] = useState<{ key: string; data?: T; error?: unknown }>({
      key,
    });
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    setState({ key });
    void load(abort.signal)
      .then((data) => {
        if (active) setState({ key, data });
      })
      .catch((error) => {
        if (active) setState({ key, error });
      });
    return () => {
      active = false;
      abort.abort();
    };
  }, [key, version]);
  const current = state.key === key ? state : { key };
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return {
    ...current,
    loading: current.data === undefined && current.error === undefined,
    reload,
  };
}
export function useJournal(
  key: string,
  principal: string,
  select: (entries: Entry[]) => Entry[] | Promise<Entry[]>,
) {
  const records = useResource(key, async () =>
    select(journal(principal).list()),
  );
  useEffect(
    () => watchJournal(principal, records.reload),
    [principal, records.reload],
  );
  return records;
}
export function useTask() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const sending = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      return await action();
    } catch (error) {
      if (alive.current) setError(error);
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return { busy, error, run };
}
export function ErrorNotice({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  const { t } = useWorkspace();
  return error ? (
    <div role="alert" className="notice notice-error">
      <span>{errorText(error, t)}</span>
      {retry && <button onClick={retry}>{t("retry")}</button>}
    </div>
  ) : null;
}
export function Empty({
  title,
  body,
  children,
}: {
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      {body && <p>{body}</p>}
      {children}
    </div>
  );
}
export function PageTitle({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  );
}
export function Refresh({
  busy,
  onClick,
}: {
  busy?: boolean;
  onClick: () => void;
}) {
  const { t } = useWorkspace();
  return (
    <button disabled={busy} onClick={onClick}>
      <RefreshCw size={15} />
      {t("refresh")}
    </button>
  );
}
export function ActionLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a className="button primary" href={href}>
      {children}
    </a>
  );
}
export function Badge({
  children,
  good,
  warning,
}: {
  children: ReactNode;
  good?: boolean;
  warning?: boolean;
}) {
  return (
    <span className={`badge${good ? " good" : warning ? " warning" : ""}`}>
      {children}
    </span>
  );
}
export const when = (value: string | null | undefined, locale: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
