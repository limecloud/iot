import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { z } from "zod";
import {
  ArrowUpRight,
  BookOpen,
  Boxes,
  Cable,
  ChevronDown,
  CircleHelp,
  Code2,
  Cpu,
  Eye,
  Globe2,
  House,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Music2,
  Network,
  SunMoon,
  UserRound,
  Workflow,
  X,
} from "lucide-react";
import { APIError, request, type Call } from "./api";
import {
  sessionSchema,
  spacesSchema,
  type Audience,
  type Session,
} from "./contracts";
import { Context } from "./context";
import { translator, type MessageKey } from "./i18n";
import { errorText, useResource, useTask } from "./ui";
import { Overview, Spaces, Developer, Account, Admin } from "./Workspace";
import { Products } from "./Products";
import { Gateways } from "./Gateways";
import { Devices, Operations } from "./Devices";
import brand from "./brand.svg";

const navigation = [
  ["overview", LayoutDashboard],
  ["products", Boxes],
  ["spaces", House],
  ["gateways", Network],
  ["devices", Cpu],
  ["operations", Cable],
  ["connections", Code2],
  ["account", UserRound],
] as const;
const configSchema = z.object({ local: z.boolean(), oidc: z.boolean() });

export interface PrivateWorkspace {
  basePath: string;
  local?: {
    render: (view: string, onExpired: () => void) => ReactNode;
    check: () => Promise<void>;
    login: (token: string) => Promise<void>;
    logout: () => Promise<void>;
  };
}

export default function App({
  audience,
  locale,
  accountURL,
  deployment,
}: {
  audience: Audience;
  locale: string;
  accountURL?: string;
  deployment?: PrivateWorkspace;
}) {
  const t = useMemo(() => translator(locale), [locale]),
    prefix = `/api/${audience}/v1/auth`;
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const [session, setSession] = useState<Session | null>(),
    [failure, setFailure] = useState<unknown>(() =>
      new URLSearchParams(location.search).get("auth_error") ===
      "login_incomplete"
        ? new APIError("login_incomplete")
        : undefined,
    ),
    [attempt, setAttempt] = useState(0);
  const config = useResource(prefix + attempt, (signal) =>
    request(`${prefix}/config`, configSchema, undefined, undefined, signal),
  );
  const generation = useRef(0),
    loginTask = useTask();
  useEffect(() => {
    if (deployment) return;
    if (!new URLSearchParams(location.search).has("auth_error")) return;
    try {
      const preferred = sessionStorage.getItem(`limeiot.${audience}.locale`);
      if (preferred === "zh-CN" && locale !== preferred)
        location.replace(`/zh-cn/${audience}/${location.search}`);
      else sessionStorage.removeItem(`limeiot.${audience}.locale`);
    } catch {
      /* 语言记忆失败时仍显示可恢复的登录页面。 */
    }
  }, [audience, locale]);
  useEffect(() => {
    let alive = true;
    const abort = new AbortController();
    void request(
      `${prefix}/session`,
      sessionSchema,
      undefined,
      undefined,
      abort.signal,
    )
      .then((value) => {
        if (
          value.audience !== audience ||
          Date.parse(value.expires_at) <= Date.now()
        )
          throw new APIError("identity_rejected", 401);
        return Promise.resolve(audience === "console" ? deployment?.local?.check() : undefined).then(() => {
          if (alive) setSession(value);
        });
      })
      .catch((error) => {
        if (alive) {
          setSession(null);
          if (!(error instanceof APIError && error.status === 401))
            setFailure(error);
        }
      });
    return () => {
      alive = false;
      abort.abort();
      generation.current++;
    };
  }, [prefix, attempt]);
  const call: Call = useCallback(
    async (path, schema, input, signal) => {
      if (!path.startsWith(`/api/${audience}/v1/`))
        throw new APIError("forbidden", 403);
      const current = generation.current;
      try {
        const value = await request(
          path,
          schema,
          session ?? undefined,
          input,
          signal,
        );
        if (current !== generation.current)
          throw new APIError("identity_rejected", 401);
        return value;
      } catch (error) {
        if (
          error instanceof APIError &&
          error.status === 401 &&
          generation.current === current
        ) {
          generation.current++;
          setSession(null);
          setFailure(error);
        }
        throw error;
      }
    },
    [session, audience],
  );
  async function logout() {
    await loginTask.run(async () => {
      await Promise.all([audience === "console" ? deployment?.local?.logout() : undefined, call(
        `${prefix}/logout`,
        z.object({ logged_out: z.literal(true) }),
        {},
      )]);
      generation.current++;
      setSession(null);
      setFailure(undefined);
    });
  }
  async function login(token?: string) {
    await loginTask.run(async () => {
      if (token !== undefined) {
        await request(
          `${prefix}/local`,
          z.object({ logged_in: z.literal(true) }),
          undefined,
          { token },
        );
        try {
          if (audience === "console") await deployment?.local?.login(token);
        } catch (error) {
          // 本地认证失败时撤销刚建立的控制面会话，避免留下半登录状态。
          const created = await request(`${prefix}/session`, sessionSchema);
          await request(`${prefix}/logout`, z.object({ logged_out: z.literal(true) }), created, {});
          throw error;
        }
        setAttempt((value) => value + 1);
        return;
      }
      const native = new URLSearchParams(location.search).get("native");
      const value = await request(
        `${prefix}/start`,
        z.object({ authorize_url: z.url() }),
        undefined,
        audience === "console" && /^na-[a-f0-9]{64}$/.test(native ?? "")
          ? { native_authorization: native }
          : {},
      );
      const url = new URL(value.authorize_url);
      if (
        url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname)
        )
      )
        throw new APIError("invalid_response");
      try {
        sessionStorage.setItem(`limeiot.${audience}.locale`, locale);
      } catch {
        /* 语言记忆失败不影响认证。 */
      }
      location.assign(url.href);
    });
  }
  useEffect(() => {
    if (!session) return;
    try {
      const preferred = sessionStorage.getItem(`limeiot.${audience}.locale`);
      sessionStorage.removeItem(`limeiot.${audience}.locale`);
      if (!deployment && preferred === "zh-CN" && locale !== preferred)
        location.replace(`/zh-cn/${audience}/${location.search}`);
    } catch {
      /* 不读取或保存任何身份凭据。 */
    }
    const timer = setTimeout(
      () => {
        generation.current++;
        setSession(null);
        setFailure(new APIError("identity_rejected", 401));
      },
      Math.min(
        2147483647,
        Math.max(0, Date.parse(session.expires_at) - Date.now()),
      ),
    );
    return () => clearTimeout(timer);
  }, [session]);
  const problem = loginTask.error ?? failure ?? config.error;
  const expired = !loginTask.error && failure instanceof APIError && failure.status === 401;
  if (session)
    return (
      <Workspace
        key={session.csrf_token}
        audience={audience}
        deployment={deployment}
        onLocalExpired={() => { generation.current++; setSession(null); setFailure(new APIError("identity_rejected", 401)); }}
        locale={locale}
        t={t}
        session={session}
        call={call}
        logout={logout}
        busy={loginTask.busy}
        error={loginTask.error}
        accountURL={accountURL}
      />
    );
  if (session === undefined)
    return <main className="session-loading">
      <p role="status">{t("checkingSession")}</p>
      {deployment?.local && <a href="/local/">{t("localControl")}</a>}
    </main>;
  return (
    <main className="signin">
      <div className="signin-story">
        <a
          className="console-brand"
          href={deployment?.basePath ?? (locale === "zh-CN" ? "/zh-cn/" : "/")}
        >
          <img src={brand} alt="" width={34} height={34} />
          Lime<span>IoT</span>
        </a>
        <a href={deployment ? "https://iot.limeai.run/docs/" : "/docs/"}>
          <BookOpen size={16} />
          {t("docs")}
          <ArrowUpRight size={14} />
        </a>
      </div>
      <div className="signin-form">
        <div className="signin-card">
          <h1>{t(deployment?.local ? "privateInstance" : audience)}</h1>
          <p role={expired ? "status" : undefined}>{t(expired ? "sessionEnded" : deployment ? "privateLoginBody" : audience === "admin" ? "adminBody" : "loginBody")}</p>
          {config.loading ? (
            <p role="status">{t("loading")}</p>
          ) : (
            <>
              {config.data?.oidc && (
                <button
                  className="primary signin-button"
                  disabled={loginTask.busy}
                  onClick={() => void login()}
                >
                  {t(loginTask.busy ? "redirecting" : expired ? "loginAgain" : "login")}
                  <ArrowUpRight size={16} />
                </button>
              )}
              {config.data?.local && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget,
                      token = String(new FormData(form).get("token") ?? "");
                    form.reset();
                    void login(token);
                  }}
                >
                  <label>
                    {t("localToken")}
                    <input
                      name="token"
                      type="password"
                      autoComplete="off"
                      required
                      minLength={32}
                      disabled={loginTask.busy}
                    />
                  </label>
                  <button className="primary" disabled={loginTask.busy}>
                    {t("localLogin")}
                  </button>
                </form>
              )}
              {!config.data?.oidc && !config.data?.local && (
                <p role="status">{t("unavailable")}</p>
              )}
            </>
          )}
          {!!problem && !expired && (
            <p role="alert" className="notice notice-error">
              {loginTask.error instanceof APIError && loginTask.error.status === 401 ? t("invalidCredentials") : errorText(problem, t)}
            </p>
          )}
          {!!problem && !config.data?.oidc && !config.data?.local && !loginTask.busy && (
            <button
              className="text-button"
              onClick={() => {
                setFailure(undefined);
                setSession(undefined);
                setAttempt((value) => value + 1);
              }}
            >
              {t("retry")}
            </button>
          )}
          <a className="signin-help" href={deployment ? "https://iot.limeai.run/docs/deployment/" : "/docs/quick-start/"}>{t("loginHelp")}</a>
          {deployment?.local && <a className="signin-help" href="/local/">{t("localControl")}</a>}
        </div>
      </div>
    </main>
  );
}

function Workspace({
  audience,
  locale,
  t,
  session,
  call,
  logout,
  busy,
  error,
  accountURL,
  deployment,
  onLocalExpired,
}: {
  audience: Audience;
  locale: string;
  t: ReturnType<typeof translator>;
  session: Session;
  call: Call;
  logout: () => Promise<void>;
  busy: boolean;
  error: unknown;
  accountURL?: string;
  deployment?: PrivateWorkspace;
  onLocalExpired: () => void;
}) {
  const local = deployment?.local;
  const tasks = local ? ([
    ["overview", LayoutDashboard], ["devices", Cpu], ["automation", Workflow], ["text", MessageSquare], ["companion", MessageSquare], ["media", Music2], ["vision", Eye], ["ai", Cpu],
    ["operations", Cable], ["products", Boxes], ["models", Boxes], ["firmware", Cpu],
    ["spaces", House], ["gateways", Network], ["connections", Code2], ["account", UserRound],
  ] as const) : navigation;
  const [search, setSearch] = useState(location.search);
  const params = new URLSearchParams(search),
    requested = params.get("view") ?? "overview";
  const view = tasks.some(([key]) => key === requested)
    ? requested
    : "overview";
  const [mobile, setMobile] = useState(false),
    [theme, setTheme] = useState("system");
  const spaces = useResource(
    "spaces:" + session.principal.principal_id,
    (signal) =>
      audience === "console" && !params.has("native")
        ? call("/api/console/v1/spaces", spacesSchema, undefined, signal)
        : Promise.resolve({ spaces: [] }),
  );
  const selected = params.get("space"),
    space = spaces.data?.spaces.find((item) => item.space_id === selected);
  const base = deployment?.basePath ?? `${locale === "zh-CN" ? "/zh-cn" : ""}/${audience}/`;
  const navigate = useCallback((target: string) => {
    // 离开页面后才返回的写入结果只更新原记录，不把用户拉回旧任务。
    if (location.search !== search) return;
    const url = new URL(target, location.href);
    if (url.origin !== location.origin || url.pathname !== base || url.hash)
      return;
    setMobile(false);
    if (url.href === location.href) return;
    history.pushState(null, "", url.pathname + url.search);
    setSearch(url.search);
  }, [base, search]);
  useEffect(() => {
    const restore = () => setSearch(location.search);
    addEventListener("popstate", restore);
    return () => removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    setMobile(false);
    document.getElementById("workspace-main")?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [search]);
  function followLink(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
    const url = new URL(anchor.href);
    if (url.origin !== location.origin || url.pathname !== base || url.hash) return;
    if (deployment && url.searchParams.has("lang") && url.searchParams.get("lang") !== locale) return;
    event.preventDefault();
    navigate(url.href);
  }
  const href = (next = "overview", values: Record<string, string> = {}) => {
    const query = new URLSearchParams({
      view: next,
      ...(deployment ? { lang: locale } : {}),
      ...(selected ? { space: selected } : {}),
      ...values,
    });
    return base + "?" + query;
  };
  useEffect(() => {
    try {
      setTheme(localStorage.getItem("limeiot-theme") ?? "system");
    } catch {
      /* 系统主题仍可用。 */
    }
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobile(false);
    };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [mobile]);
  const languageQuery = new URLSearchParams(search);
  languageQuery.set("lang", locale === "en" ? "zh-CN" : "en");
  const languageURL = deployment ? base + "?" + languageQuery : `${locale === "zh-CN" ? "" : "/zh-cn"}/${audience}/${location.search}`;
  return (
    <Context.Provider
      value={{
        session,
        call,
        t,
        locale,
        spaces: spaces.data?.spaces,
        space,
        href,
        navigate,
      }}
    >
      <div className="workspace" onClick={followLink}>
        <a className="skip-link" href="#workspace-main">
          {t("skip")}
        </a>
        {mobile && (
          <button
            className="sidebar-overlay"
            aria-label={t("close")}
            onClick={() => setMobile(false)}
          />
        )}
        <aside
          id="workspace-sidebar"
          className={`sidebar${mobile ? " open" : ""}`}
        >
          <button
            className="icon-button sidebar-close"
            aria-label={t("close")}
            onClick={() => setMobile(false)}
          >
            <X size={20} />
          </button>
          <a className="console-brand" href={base}>
            <img src={brand} alt="" width={32} height={32} />
            Lime<span>IoT</span>
          </a>
          <div className="workspace-label">{t(audience === "console" ? deployment ? "privateInstance" : "officialCloud" : "admin")}</div>
          <nav aria-label={t("menu")}>
            {(audience === "console"
              ? tasks
              : ([
                  ["overview", LayoutDashboard],
                  ["account", UserRound],
                ] as const)
            ).map(([key, Icon]) => (
              <div key={key} className={audience === "console" && ["spaces", "connections"].includes(key) ? "nav-section" : undefined}>
              {audience === "console" && key === "spaces" && <span className="nav-label">{t("spaceDevices")}</span>}
              {audience === "console" && key === "connections" && <span className="nav-label">{t("settings")}</span>}
              <a
                key={key}
                href={href(key)}
                aria-current={view === key ? "page" : undefined}
              >
                <Icon size={18} strokeWidth={1.7} />
                {t(key as MessageKey)}
              </a>
              </div>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <a href={deployment ? "https://iot.limeai.run/docs/" : "/docs/"}>
              <BookOpen size={18} />
              {t("docs")}
              <ArrowUpRight size={14} />
            </a>
            <a href={deployment ? local ? "/local/" : "/" : locale === "zh-CN" ? "/zh-cn/" : "/"}>
              <CircleHelp size={18} />
              {t(local ? "localControl" : "home")}
            </a>
          </div>
        </aside>
        <div className="workspace-body">
          <header className="workspace-bar">
            <div className="bar-start">
              <button
                className="icon-button mobile-toggle"
                aria-label={t("menu")}
                aria-expanded={mobile}
                aria-controls="workspace-sidebar"
                onClick={() => setMobile(!mobile)}
              >
                {mobile ? <X size={20} /> : <Menu size={20} />}
              </button>
              <a className="mobile-brand" href={base} aria-label="LimeIoT"><img src={brand} alt="" width={24} height={24} /><span>LimeIoT</span></a>
              <span className="bar-title">
                {t(local ? "privateInstance" : audience)}
              </span>
              {audience === "console" && ["overview", "spaces", "gateways", "devices", "operations"].includes(view) && (
                <label className="space-picker">
                  <House size={15} />
                  <select
                    aria-label={t("selectedSpace")}
                    value={selected ?? ""}
                    onChange={(event) =>
                      navigate(href(view, { space: event.target.value }))
                    }
                  >
                    <option value="">{t(local && ["devices", "operations"].includes(view) ? "localGateway" : "chooseSpace")}</option>
                    {spaces.data?.spaces.map((item) => (
                      <option key={item.space_id} value={item.space_id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={13} />
                </label>
              )}
            </div>
            <div className="bar-end">
              {!local && <a
                className="icon-button"
                href={languageURL}
                aria-label={`${t("language")} ${locale === "en" ? "中" : "EN"}`}
              >
                <Globe2 size={17} />
                <span>{locale === "en" ? "中" : "EN"}</span>
              </a>}
              <label className="theme-control">
                <SunMoon size={17} />
                <select
                  aria-label={t("theme")}
                  value={theme}
                  onChange={(event) => {
                    const next = event.target.value;
                    setTheme(next);
                    if (next === "system")
                      delete document.documentElement.dataset.theme;
                    else document.documentElement.dataset.theme = next;
                    try {
                      localStorage.setItem("limeiot-theme", next);
                    } catch {
                      /* 仍应用本页选择。 */
                    }
                  }}
                >
                  <option value="system">{t("system")}</option>
                  <option value="light">{t("light")}</option>
                  <option value="dark">{t("dark")}</option>
                </select>
              </label>
              <span className="account-name">{session.principal.name}</span>
              <button
                className="icon-button"
                disabled={busy}
                onClick={() => void logout()}
                aria-label={t("logout")}
              >
                <LogOut size={17} />
              </button>
            </div>
          </header>
          <main id="workspace-main" className="workspace-content" tabIndex={-1}>
            {!!error && (
              <p role="alert" className="notice notice-error">
                {errorText(error, t)}
              </p>
            )}
            {!!spaces.error && audience === "console" && (
              <p role="alert" className="notice notice-error">
                {errorText(spaces.error, t)}
                <button onClick={spaces.reload}>{t("retry")}</button>
              </p>
            )}
            {audience === "console" && selected && !space && spaces.data && (!local || ["overview", "spaces", "gateways", "devices", "operations"].includes(view)) && (
              <p role="alert" className="notice notice-error">
                {t("err_not_found")}
              </p>
            )}
            {view === "account" ? (
              <Account accountURL={accountURL} />
            ) : audience === "admin" ? (
              <Admin />
            ) : params.has("native") ? (
              <Developer native={params.get("native") ?? ""} />
            ) : local && (["automation", "text", "companion", "media", "vision", "ai", "models", "firmware"].includes(view) || !selected && ["devices", "operations"].includes(view)) ? (
              local.render(view === "operations" ? "activity" : view, onLocalExpired)
            ) : view === "products" ? (
              <Products />
            ) : view === "spaces" ? (
              <Spaces reload={spaces.reload} />
            ) : view === "gateways" ? (
              <><Gateways key={space?.space_id ?? "none"} />{local && <section className="local-pairing-section">{local.render("connections", onLocalExpired)}</section>}</>
            ) : view === "devices" ? (
              <Devices key={space?.space_id ?? "none"} />
            ) : view === "operations" ? (
              <Operations key={space?.space_id ?? "none"} />
            ) : view === "connections" ? (
              <Developer />
            ) : (
              <Overview />
            )}
          </main>
        </div>
      </div>
    </Context.Provider>
  );
}
