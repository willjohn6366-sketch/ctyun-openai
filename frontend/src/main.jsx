import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./ui.css";

const VERSION = "0.0.2";
const VERSION_URL =
  "https://raw.githubusercontent.com/willjohn6366-sketch/ctyun-openai/main/version.json";
const REPO_URL = "https://github.com/willjohn6366-sketch/ctyun-openai";

const TABS = [
  { id: "home", label: "首页" },
  { id: "account", label: "账号管理" },
  { id: "settings", label: "设置" },
  { id: "about", label: "关于" }
];

const LEAVE_DURATION = 150;
const ENTER_DURATION = 220;
const ACTIVE_PAGE_KEY = "ct-api-active-page";
const DEFAULT_PAGE = "home";
const PAGE_PATHS = {
  home: "/",
  account: "/account",
  settings: "/settings",
  about: "/about"
};
const PATH_PAGES = Object.entries(PAGE_PATHS).reduce((pages, [page, path]) => {
  pages[path] = page;
  return pages;
}, {});

function getPageFromPath() {
  if (typeof window === "undefined") return DEFAULT_PAGE;
  return PATH_PAGES[window.location.pathname] || DEFAULT_PAGE;
}

function updateUrlForPage(page, mode = "push") {
  if (typeof window === "undefined") return;
  const path = PAGE_PATHS[page] || PAGE_PATHS[DEFAULT_PAGE];
  if (window.location.pathname === path) return;
  window.history[mode === "replace" ? "replaceState" : "pushState"]({ page }, "", path);
}

function getStoredPage() {
  if (typeof window === "undefined") return DEFAULT_PAGE;

  const routePage = getPageFromPath();
  if (routePage !== DEFAULT_PAGE || window.location.pathname === PAGE_PATHS[DEFAULT_PAGE]) {
    return routePage;
  }

  const storedPage = window.localStorage.getItem(ACTIVE_PAGE_KEY);
  return TABS.some((tab) => tab.id === storedPage) ? storedPage : DEFAULT_PAGE;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data?.error?.message || "请求失败");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function modelStatusClass(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "avaiable" || normalized === "available") {
    return "badge";
  }
  return "badge error";
}

function renderStatusText(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "avaiable" || normalized === "available") {
    return "● 可用";
  }
  if (!status) {
    return "● 未知";
  }
  return `● ${status}`;
}

function compareVersions(currentVersion, nextVersion) {
  const current = String(currentVersion || "")
    .split(".")
    .map((part) => Number(part) || 0);
  const next = String(nextVersion || "")
    .split(".")
    .map((part) => Number(part) || 0);
  const length = Math.max(current.length, next.length);

  for (let index = 0; index < length; index += 1) {
    const currentPart = current[index] || 0;
    const nextPart = next[index] || 0;

    if (nextPart > currentPart) return 1;
    if (nextPart < currentPart) return -1;
  }

  return 0;
}

function App() {
  const [activePage, setActivePage] = useState(getStoredPage);
  const [displayPage, setDisplayPage] = useState(getStoredPage);
  const [pageStage, setPageStage] = useState("entered");
  const [isDark, setIsDark] = useState(false);
  const [toast, setToast] = useState("");
  const [authChecked, setAuthChecked] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [dashboard, setDashboard] = useState(null);
  const [config, setConfig] = useState(null);
  const [cookieInput, setCookieInput] = useState("");
  const [listenPort, setListenPort] = useState(3000);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateStatus, setUpdateStatus] = useState(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    document.body.classList.toggle("dark", isDark);
  }, [isDark]);

  useEffect(() => {
    window.localStorage.setItem(ACTIVE_PAGE_KEY, activePage);
  }, [activePage]);

  useEffect(() => {
    function syncPageFromHistory() {
      const nextPage = getPageFromPath();
      setActivePage(nextPage);
      setDisplayPage(nextPage);
      setPageStage("entered");
    }

    window.addEventListener("popstate", syncPageFromHistory);
    return () => window.removeEventListener("popstate", syncPageFromHistory);
  }, []);

  useEffect(() => {
    let timer = 0;
    if (toast) {
      timer = window.setTimeout(() => setToast(""), 2200);
    }
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!isUpdating) return undefined;

    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const status = await requestJson("/api/update/status");
        if (cancelled) return;
        setUpdateStatus(status);

        if (status.status === "failed") {
          setIsUpdating(false);
          showToast(status.message || "更新失败");
        }

        if (status.status === "restarting") {
          setIsUpdating(false);
          showToast("更新完成，服务正在重启");
          window.setTimeout(() => window.location.reload(), 3500);
        }
      } catch {
        if (!cancelled) {
          window.setTimeout(() => window.location.reload(), 3500);
        }
      }
    }, 1400);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isUpdating]);

  const showToast = (message) => setToast(message);

  function handleRequestError(error) {
    if (error.status === 401) {
      setAuthUser(null);
      setDashboard(null);
      setConfig(null);
      window.history.replaceState({ page: "login" }, "", "/login");
      showToast("登录已过期，请重新登录");
      return;
    }
    showToast(error.message);
  }

  async function loadDashboard() {
    const nextDashboard = await requestJson("/api/dashboard");
    setDashboard(nextDashboard);
  }

  async function checkAuth() {
    return requestJson("/api/auth/me", {
      headers: {
        "cache-control": "no-cache"
      }
    });
  }

  async function loadConfig() {
    const nextConfig = await requestJson("/api/config");
    setConfig(nextConfig);
    setCookieInput("");
    setListenPort(nextConfig.listenPort || 3000);
  }

  useEffect(() => {
    let cancelled = false;

    checkAuth()
      .then((data) => {
        if (!cancelled) setAuthUser(data.user);
      })
      .catch((error) => {
        if (!cancelled && error.status !== 401) showToast(error.message);
      })
      .finally(() => {
        if (!cancelled) setAuthChecked(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function recheckAuth() {
      checkAuth().catch((error) => {
        if (error.status !== 401) return;
        setAuthUser(null);
        setDashboard(null);
        setConfig(null);
        setActivePage(DEFAULT_PAGE);
        setDisplayPage(DEFAULT_PAGE);
        setPageStage("entered");
        window.history.replaceState({ page: "login" }, "", "/login");
      });
    }

    window.addEventListener("pageshow", recheckAuth);
    window.addEventListener("focus", recheckAuth);
    return () => {
      window.removeEventListener("pageshow", recheckAuth);
      window.removeEventListener("focus", recheckAuth);
    };
  }, []);

  useEffect(() => {
    if (!authUser) return;

    Promise.all([loadDashboard(), loadConfig()]).catch((error) => {
      handleRequestError(error);
    });
  }, [authUser]);

  useEffect(() => {
    if (activePage === displayPage) return;

    setPageStage("leaving");
    const switchTimer = window.setTimeout(() => {
      setDisplayPage(activePage);
      setPageStage("entering");
    }, LEAVE_DURATION);

    return () => {
      window.clearTimeout(switchTimer);
    };
  }, [activePage, displayPage]);

  useEffect(() => {
    if (pageStage !== "entering") return;

    const enterTimer = window.setTimeout(() => {
      setPageStage("entered");
    }, ENTER_DURATION);

    return () => {
      window.clearTimeout(enterTimer);
    };
  }, [pageStage, displayPage]);

  const account = dashboard?.account || {};
  const usage = dashboard?.usage || {};
  const models = dashboard?.models || [];
  const hasAccount = Boolean(account.nickName || account.mobile || account.clientId);
  const accountName = hasAccount ? account.nickName || account.name || "未知账号" : "未登录";
  const accountMeta = hasAccount
    ? [account.mobile ? `手机：${account.mobile}` : "", account.expiresAt ? `令牌过期：${formatDate(account.expiresAt)}` : ""]
        .filter(Boolean)
        .join(" · ") || account.accountError || "已读取账号信息"
    : "请在账号管理中配置 Cookie";

  async function refreshDashboard() {
    try {
      await loadDashboard();
      showToast("已刷新");
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function saveCookie() {
    try {
      const cookie = cookieInput.trim();
      if (!cookie) {
        showToast("请先粘贴 JWT 令牌");
        return;
      }
      const nextConfig = await requestJson("/api/config", {
        method: "POST",
        body: JSON.stringify({ cookie })
      });
      setConfig(nextConfig);
      setCookieInput("");
      await loadDashboard();
      showToast("Cookie 已保存");
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function saveServiceConfig(patch = {}) {
    try {
      if (!Number.isInteger(Number(listenPort)) || Number(listenPort) < 1024 || Number(listenPort) > 65535) {
        showToast("端口请输入 1024 到 65535 之间的整数");
        return;
      }
      const nextConfig = await requestJson("/api/config", {
        method: "POST",
        body: JSON.stringify({
          listenPort: Number(listenPort),
          serviceEnabled: config?.serviceEnabled ?? true,
          ...patch,
          autoStart: true
        })
      });
      setConfig(nextConfig);
      setListenPort(nextConfig.listenPort || 3000);
      showToast(nextConfig.portChanged ? `已切换到 ${nextConfig.baseUrl}` : "服务配置已保存");
      if (nextConfig.portChanged && nextConfig.baseUrl) {
        window.setTimeout(() => {
          window.location.href = new URL(nextConfig.baseUrl).origin;
        }, 900);
      }
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function toggleService() {
    try {
      await saveServiceConfig({ serviceEnabled: !config?.serviceEnabled });
      await loadDashboard();
    } catch (error) {
      handleRequestError(error);
    }
  }

  async function regenerateApiKey() {
    await saveServiceConfig({ regenerateApiKey: true });
    showToast("API 密钥已重新生成");
  }

  async function login(event) {
    event.preventDefault();

    try {
      const username = loginUsername.trim();
      if (!username || !loginPassword) {
        setLoginError("请输入用户名和密码");
        return;
      }

      setLoginError("");
      setIsLoggingIn(true);
      const data = await requestJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username,
          password: loginPassword
        })
      });
      setAuthUser(data.user);
      setActivePage(DEFAULT_PAGE);
      setDisplayPage(DEFAULT_PAGE);
      setPageStage("entered");
      updateUrlForPage(DEFAULT_PAGE, "replace");
      setLoginPassword("");
    } catch (error) {
      setLoginError(error.message);
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function logout() {
    try {
      await requestJson("/api/auth/logout", {
        method: "POST"
      });
    } catch {
      // The local UI should leave the management session even if the request fails.
    } finally {
      setAuthUser(null);
      setDashboard(null);
      setConfig(null);
      setActivePage(DEFAULT_PAGE);
      setDisplayPage(DEFAULT_PAGE);
      setPageStage("entered");
      showToast("已退出登录");
      window.setTimeout(() => {
        window.location.replace(`${window.location.origin}/login`);
      }, 80);
    }
  }

  async function changePassword() {
    try {
      if (!currentPassword || !nextPassword) {
        setPasswordError("当前密码和新密码不能为空");
        return;
      }
      if (nextPassword !== confirmPassword) {
        setPasswordError("两次输入的新密码不一致");
        return;
      }

      setPasswordError("");
      const data = await requestJson("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword,
          nextPassword
        })
      });
      setAuthUser(data.user);
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      document.getElementById("password-dialog")?.hidePopover?.();
      showToast("密码已更新");
    } catch (error) {
      if (error.status === 401) {
        handleRequestError(error);
        return;
      }
      setPasswordError(error.message);
    }
  }

  function resetPasswordDialog() {
    setCurrentPassword("");
    setNextPassword("");
    setConfirmPassword("");
    setPasswordError("");
  }

  async function copyText(text) {
    if (!text) {
      showToast("没有可复制的内容");
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    showToast("已复制到剪贴板");
  }

  async function checkForUpdates() {
    setIsCheckingUpdate(true);
    try {
      const payload = await requestJson("/api/update/check");
      setUpdateInfo(payload);
      setUpdateStatus(payload.status || null);

      if (!payload.updateAvailable) {
        showToast("当前已是最新版");
        return;
      }

      showToast(`发现新版本 ${payload.latestVersion}`);
    } catch (error) {
      handleRequestError(error);
    } finally {
      setIsCheckingUpdate(false);
    }
  }

  async function applyUpdate() {
    try {
      setIsUpdating(true);
      const status = await requestJson("/api/update/apply", {
        method: "POST"
      });
      setUpdateStatus(status);
      showToast("已开始更新");
    } catch (error) {
      setIsUpdating(false);
      handleRequestError(error);
    }
  }

  if (!authChecked) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <div className="login-brand">
            <div className="brand-mark">C</div>
            <div>
              <h1>CT API</h1>
              <p>管理控制台</p>
            </div>
          </div>
          <div className="login-status">正在检查登录状态</div>
        </div>
      </div>
    );
  }

  if (!authUser) {
    if (window.location.pathname !== "/login") {
      window.history.replaceState({ page: "login" }, "", "/login");
    }

    return (
      <div className="login-shell">
        {loginError ? <div className="login-tip">{loginError}</div> : null}
        <form className="login-card" onSubmit={login}>
          <div className="login-brand">
            <div className="brand-mark">C</div>
            <div>
              <h1>CT API</h1>
              <p>管理控制台</p>
            </div>
          </div>
          <label className="field">
            <span>用户名</span>
            <input
              value={loginUsername}
              onChange={(event) => {
                setLoginUsername(event.target.value);
                setLoginError("");
              }}
              autoComplete="username"
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              value={loginPassword}
              onChange={(event) => {
                setLoginPassword(event.target.value);
                setLoginError("");
              }}
              autoComplete="current-password"
              type="password"
            />
          </label>
          <button className="primary-button" disabled={isLoggingIn} type="submit">
            {isLoggingIn ? "登录中" : "登录"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">C</div>
          <div>
            <h1>CT API</h1>
          </div>
        </div>

        <nav className="tabs" aria-label="主导航">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`tab${activePage === tab.id ? " active" : ""}`}
              onClick={() => {
                setActivePage(tab.id);
                updateUrlForPage(tab.id);
              }}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="top-actions">
          <button className="icon-button" onClick={() => setIsDark((value) => !value)} title="切换主题">
            ◐
          </button>
          <div className="user-chip">
            <span>{authUser.username}</span>
            <button onClick={logout} type="button">
              退出
            </button>
          </div>
        </div>
      </header>

      <main className={`page-stage ${pageStage}`}>
        {displayPage === "home" && (
          <section className="page active home-page">
            <div className="summary-grid">
              <article className="summary-card account-card">
                <div className="card-label">当前账号</div>
                <div className="account-line">
                  <div className="account-heading">
                    <h2>{accountName}</h2>
                    {hasAccount && account.vipType ? (
                      <span className="vip-badge">{account.vipType.toUpperCase()}</span>
                    ) : null}
                  </div>
                  <p>{accountMeta}</p>
                </div>
              </article>

              <article className="summary-card">
                <div className="card-label">支持模型</div>
                <div className="metric">
                  <strong>{formatNumber(models.length)}</strong>
                  <span>个模型</span>
                </div>
              </article>

              <article className="summary-card">
                <div className="card-label">总用量</div>
                <div className="metric">
                  <strong>{formatNumber(usage?.total?.tokens)}</strong>
                  <span>tokens</span>
                </div>
                <p>{formatNumber(usage?.total?.requests)} 次请求</p>
              </article>

              <article className="summary-card">
                <div className="card-label">今日用量</div>
                <div className="metric">
                  <strong>{formatNumber(usage?.today?.tokens)}</strong>
                  <span>tokens</span>
                </div>
                <p>{formatNumber(usage?.today?.requests)} 次请求</p>
              </article>
            </div>

            <section className="table-card">
              <div className="toolbar">
                <div>
                  <h2>模型列表</h2>
                  <p>全部 ({models.length})</p>
                </div>
                <div className="toolbar-actions">
                  <button className="primary-button" onClick={refreshDashboard}>
                    刷新
                  </button>
                </div>
              </div>

              <div className="table-header">
                <div>模型 ID</div>
                <div>模型名称</div>
                <div>Key Model</div>
                <div>状态</div>
                <div>类型</div>
              </div>
              <div className="model-list">
                {dashboard?.modelsError ? (
                  <div className="empty-state">模型列表获取失败：{dashboard.modelsError}</div>
                ) : models.length === 0 ? (
                  <div className="empty-state">暂无模型</div>
                ) : (
                  models.map((model) => (
                    <div className="model-row" key={`${model.id}-${model.key_model}`}>
                      <div className="model-id">{model.id}</div>
                      <div>{model.display_name || model.id}</div>
                      <div className="key-model">{model.key_model || "-"}</div>
                      <div>
                        <span className={modelStatusClass(model.status)}>{renderStatusText(model.status)}</span>
                      </div>
                      <div>{model.type || "-"}</div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </section>
        )}

        {displayPage === "account" && (
          <section className="page active">
            <div className="settings-layout">
              <section className="settings-card wide">
                <div className="section-title">
                  <span>Cookie 设置</span>
                  <small>用于请求云电脑上游接口</small>
                </div>

                <label className="field">
                  <span>JWT 令牌（YL-Token）</span>
                  <textarea
                    value={cookieInput}
                    onChange={(event) => setCookieInput(event.target.value)}
                    placeholder="只粘贴 JWT 内容，例如 eyJ...；已保存内容仅显示脱敏预览"
                    spellCheck="false"
                  />
                </label>

                <div className="form-actions">
                  <button className="primary-button" onClick={saveCookie}>
                    保存
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() =>
                      window.open("https://eaichat.ctyun.cn/chat/#/aichat", "_blank", "noopener,noreferrer")
                    }
                    type="button"
                  >
                    重新获取
                  </button>
                </div>

                <div className="status-line">
                  {config?.updatedAt
                    ? `已保存，更新时间：${formatDate(config.updatedAt)}，当前令牌：${config.cookiePreview}`
                    : "尚未保存新的令牌"}
                </div>
              </section>

              <section className="settings-card wide">
                <div className="section-title">
                  <span>Cookie 获取步骤</span>
                  <small>推荐使用油猴脚本，手工方式也可作为备用</small>
                </div>

                <div className="guide-card">
                  <p>
                    <strong>方式一：脚本获取</strong>
                    如果你安装了油猴扩展，点击下载脚本导入油猴中，跳转去云智助手完成登录即可在右下角复制cookie。
                  </p>
                  <div className="form-actions">
                    <a className="secondary-button link-button" href="/ctyun-cookie-helper.user.js" download>
                      下载脚本
                    </a>
                    <button
                      className="secondary-button"
                      onClick={() =>
                        window.open("https://eaichat.ctyun.cn/chat/#/aichat", "_blank", "noopener,noreferrer")
                      }
                      type="button"
                    >
                      跳转去云智助手
                    </button>
                  </div>
                </div>

                <div className="guide-card">
                  <p>
                    <strong>方式二：手工获取</strong>
                    去云智助手完成登录，按 F12 打开浏览器检查 - 应用程序 - Cookie - 找到 YL-Token，复制值。
                  </p>
                </div>
              </section>
            </div>
          </section>
        )}

        {displayPage === "settings" && (
          <section className="page active">
            <div className="settings-layout">
              <section className="settings-card wide service-card">
                <div className="service-head">
                  <div>
                    <div className="section-title compact">
                      <span>API 反代服务</span>
                      <small>管理本地兼容接口</small>
                    </div>
                    <div className={`service-status${config?.serviceEnabled ? "" : " stopped"}`}>
                      <i></i>
                      <div>
                        <strong>{config?.serviceEnabled ? "服务运行中" : "服务已停止"}</strong>
                        <p>
                          {config?.serviceEnabled
                            ? `本地端口 ${config?.listenPort || 3000} 可用`
                            : "兼容接口已暂停"}
                        </p>
                      </div>
                    </div>
                  </div>
                  <button
                    className={config?.serviceEnabled ? "danger-button" : "primary-button"}
                    onClick={toggleService}
                  >
                    {config?.serviceEnabled ? "停止服务" : "启动服务"}
                  </button>
                </div>

                <div className="service-grid">
                  <label className="field">
                    <span>监听端口</span>
                    <div className="port-row">
                      <input
                        value={listenPort}
                        onChange={(event) => setListenPort(event.target.value)}
                        type="number"
                        min="1024"
                        max="65535"
                      />
                      <button className="primary-button" onClick={() => saveServiceConfig()}>
                        保存
                      </button>
                    </div>
                  </label>

                  <label className="field api-key-field">
                    <span>API 密钥</span>
                    <div className="copy-row">
                      <input value={config?.token || ""} readOnly />
                      <button className="secondary-button" onClick={regenerateApiKey} type="button">
                        重新生成
                      </button>
                      <button className="secondary-button" onClick={() => copyText(config?.token || "")} type="button">
                        复制
                      </button>
                    </div>
                  </label>

                  <label className="field service-url-field">
                    <span>代理地址</span>
                    <div className="copy-row">
                      <input value={config?.baseUrl || ""} readOnly />
                      <button
                        className="secondary-button"
                        onClick={() => copyText(config?.baseUrl || "")}
                        type="button"
                      >
                        复制
                      </button>
                    </div>
                  </label>
                </div>
              </section>

              <section className="settings-card wide">
                <div className="section-title">
                  <span>用户管理</span>
                  <small>当前用户：{authUser.username}</small>
                </div>

                <div className="form-actions">
                  <button
                    className="primary-button"
                    onClick={resetPasswordDialog}
                    popoverTarget="password-dialog"
                    type="button"
                  >
                    修改密码
                  </button>
                </div>
              </section>
            </div>
          </section>
        )}

        {displayPage === "about" && (
          <section className="page active">
            <div className="about-layout">
              <section className="settings-card about-card">
                <div className="about-hero">
                  <p className="about-kicker">CT API</p>
                  <p className="about-description">
                    将云电脑中的 AI 应用无缝反代为兼容接口形态，实现跨平台、跨软件的通用化调用。突破了 AI 应用仅限于云电脑内部使用的局限，使 AI 能力可被广泛集成至各类第三方软件与开发环境中，真正实现“一次部署，处处可用”。
                  </p>
                </div>

                <div className="about-footer">
                  <div className="about-version-row">
                    <strong>当前版本 V{VERSION}</strong>
                    <button className="secondary-button" disabled={isCheckingUpdate || isUpdating} onClick={checkForUpdates} type="button">
                      {isCheckingUpdate ? "检查中" : "检查更新"}
                    </button>
                    <a className="source-link" href={REPO_URL} rel="noreferrer" target="_blank">
                      查看源码
                    </a>
                    {updateInfo?.updateAvailable ? (
                      <button className="primary-button" disabled={isUpdating} onClick={applyUpdate} type="button">
                        {isUpdating ? "更新中" : `更新到 V${updateInfo.latestVersion}`}
                      </button>
                    ) : null}
                  </div>
                  {updateInfo?.updateAvailable && updateInfo.changelog ? (
                    <p className="about-signature">{updateInfo.changelog}</p>
                  ) : null}
                  {updateStatus?.status && updateStatus.status !== "idle" ? (
                    <p className="about-signature">{updateStatus.message || updateStatus.status}</p>
                  ) : null}
                  <p className="about-signature">by: 斯坦尼斯王夫斯基</p>
                </div>
              </section>
            </div>
          </section>
        )}
      </main>

      <div className={`toast${toast ? " show" : ""}`} data-message={toast}></div>
      <section className="modal-card password-popover" id="password-dialog" popover="auto" aria-labelledby="password-dialog-title">
            <div className="modal-head">
              <div>
                <h2 id="password-dialog-title">修改密码</h2>
                <p>当前用户：{authUser.username}</p>
              </div>
              <button
                className="icon-button"
                onClick={() => document.getElementById("password-dialog")?.hidePopover?.()}
                title="关闭"
                type="button"
              >
                ×
              </button>
            </div>

            <label className="field">
              <span>当前密码</span>
              <input
                value={currentPassword}
                onChange={(event) => {
                  setCurrentPassword(event.target.value);
                  setPasswordError("");
                }}
                autoComplete="current-password"
                type="password"
              />
            </label>
            <label className="field">
              <span>新密码</span>
              <input
                value={nextPassword}
                onChange={(event) => {
                  setNextPassword(event.target.value);
                  setPasswordError("");
                }}
                autoComplete="new-password"
                type="password"
              />
            </label>
            <label className="field">
              <span>确认新密码</span>
              <input
                value={confirmPassword}
                onChange={(event) => {
                  setConfirmPassword(event.target.value);
                  setPasswordError("");
                }}
                autoComplete="new-password"
                type="password"
              />
            </label>
            {passwordError ? <div className="form-error">{passwordError}</div> : null}
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => document.getElementById("password-dialog")?.hidePopover?.()}
                type="button"
              >
                取消
              </button>
              <button className="primary-button" onClick={changePassword} type="button">
                保存
              </button>
            </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
