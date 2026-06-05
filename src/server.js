import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRecentLogs, logRequest } from "./request-log.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const DIST_DIR = join(ROOT_DIR, "dist");
const PUBLIC_DIR = existsSync(DIST_DIR) ? DIST_DIR : join(ROOT_DIR, "frontend");
const DATA_DIR = join(ROOT_DIR, "data");
const CONFIG_FILE = join(DATA_DIR, "config.json");
const USAGE_FILE = join(DATA_DIR, "usage.json");
const USERS_FILE = join(DATA_DIR, "users.json");
const UPDATE_STATUS_FILE = join(DATA_DIR, "update-status.json");
const UPDATE_BACKUP_DIR = join(DATA_DIR, "backups");
const UPDATE_STATUS_STALE_MS = 2 * 60 * 1000;

const DEFAULT_PORT = 3000;
const LISTEN_HOST = "0.0.0.0";
const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_PASSWORD = "admin";
const SESSION_COOKIE = "ct_api_session";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const VERSION_URL = "https://raw.githubusercontent.com/willjohn6366-sketch/ctyun-openai/main/version.json";
const SOURCE_TARBALL_URL = "https://codeload.github.com/willjohn6366-sketch/ctyun-openai/tar.gz/main";

const UPSTREAM_URL =
  process.env.UPSTREAM_URL ||
  "https://eaichat.ctyun.cn/ai/platform/v2/cp/v1/chat/completions";
const MODELS_FILE = join(ROOT_DIR, "models.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function safeReadJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function safeWriteJson(file, data) {
  ensureDataDir();
  writeFileSync(file, JSON.stringify(data, null, 2));
}

function createIdleUpdateStatus() {
  return {
    status: "idle",
    message: "",
    updatedAt: new Date().toISOString()
  };
}

function createDefaultUserConfig() {
  const now = new Date().toISOString();
  return {
    username: DEFAULT_ADMIN_USERNAME,
    ...createPasswordRecord(DEFAULT_ADMIN_PASSWORD),
    createdAt: now,
    updatedAt: now
  };
}

function ensureDataFiles() {
  ensureDataDir();

  if (!existsSync(CONFIG_FILE)) {
    safeWriteJson(CONFIG_FILE, {
      upstreamToken: "",
      apiKey: "",
      listenPort: DEFAULT_PORT,
      serviceEnabled: true,
      autoStart: true,
      updatedAt: null
    });
  }

  if (!existsSync(USAGE_FILE)) {
    safeWriteJson(USAGE_FILE, []);
  }

  if (!existsSync(USERS_FILE)) {
    safeWriteJson(USERS_FILE, createDefaultUserConfig());
  }

  if (!existsSync(UPDATE_STATUS_FILE)) {
    safeWriteJson(UPDATE_STATUS_FILE, createIdleUpdateStatus());
  }
}

function readLocalVersionInfo() {
  const versionInfo = safeReadJson(join(ROOT_DIR, "version.json"), {});
  const packageInfo = safeReadJson(join(ROOT_DIR, "package.json"), {});

  return {
    version: versionInfo.version || packageInfo.version || "0.0.0",
    changelog: versionInfo.changelog || ""
  };
}

function compareVersions(currentVersion, latestVersion) {
  const currentParts = String(currentVersion || "0.0.0")
    .split(".")
    .map((part) => Number(part) || 0);
  const latestParts = String(latestVersion || "0.0.0")
    .split(".")
    .map((part) => Number(part) || 0);
  const length = Math.max(currentParts.length, latestParts.length);

  for (let index = 0; index < length; index += 1) {
    const current = currentParts[index] || 0;
    const latest = latestParts[index] || 0;
    if (latest > current) return 1;
    if (latest < current) return -1;
  }

  return 0;
}

function readUpdateStatus() {
  return safeReadJson(UPDATE_STATUS_FILE, createIdleUpdateStatus());
}

function writeUpdateStatus(patch) {
  const nextStatus = {
    ...readUpdateStatus(),
    ...patch,
    updatedAt: new Date().toISOString()
  };
  safeWriteJson(UPDATE_STATUS_FILE, nextStatus);
  return nextStatus;
}

function normalizeUpdateStatus(status = readUpdateStatus()) {
  if (!status || typeof status !== "object") {
    return createIdleUpdateStatus();
  }

  const nextStatus = {
    ...createIdleUpdateStatus(),
    ...status
  };

  const lastUpdatedAt = new Date(nextStatus.updatedAt || 0).getTime();
  const isExpirableState = nextStatus.status === "running" || nextStatus.status === "restarting";
  const isExpired =
    isExpirableState && Number.isFinite(lastUpdatedAt) && Date.now() - lastUpdatedAt > UPDATE_STATUS_STALE_MS;

  if (!isExpired) return nextStatus;

  return writeUpdateStatus({
    ...createIdleUpdateStatus(),
    startedAt: null,
    finishedAt: new Date().toISOString(),
    error: ""
  });
}

function reconcileUpdateStatusOnStartup() {
  const status = normalizeUpdateStatus(readUpdateStatus());

  if (status.status !== "restarting") {
    return status;
  }

  return writeUpdateStatus({
    ...createIdleUpdateStatus(),
    startedAt: status.startedAt || null,
    finishedAt: new Date().toISOString(),
    error: ""
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function createUpdaterScript() {
  const root = shellQuote(ROOT_DIR);
  const statusFile = shellQuote(UPDATE_STATUS_FILE);
  const backupDir = shellQuote(UPDATE_BACKUP_DIR);
  const tarballUrl = shellQuote(SOURCE_TARBALL_URL);
  const serverPid = shellQuote(String(process.pid));

  return `
set -u
ROOT=${root}
STATUS_FILE=${statusFile}
BACKUP_DIR=${backupDir}
TARBALL_URL=${tarballUrl}
SERVER_PID=${serverPid}

write_status() {
  node --input-type=commonjs - "$STATUS_FILE" "$1" "$2" <<'NODE'
const fs = require("fs");
const [file, status, message] = process.argv.slice(2);
const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
fs.writeFileSync(file, JSON.stringify({ ...current, status, message, updatedAt: new Date().toISOString() }, null, 2));
NODE
}

fail() {
  write_status failed "$1"
  exit 1
}

run() {
  message="$1"
  shift
  write_status running "$message"
  "$@" || fail "$message 失败"
}

run_sh() {
  message="$1"
  command="$2"
  write_status running "$message"
  sh -c "$command" || fail "$message 失败"
}

mkdir -p "$BACKUP_DIR" || fail "创建备份目录失败"
TMP_DIR=$(mktemp -d) || fail "创建临时目录失败"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

BACKUP_FILE="$BACKUP_DIR/update-$(date +%Y%m%d-%H%M%S).tgz"
run_sh "正在创建备份" "cd \\"$ROOT\\" && tar --exclude='./data/backups' --exclude='./node_modules' --exclude='./.git' -czf \\"$BACKUP_FILE\\" ."
run "正在下载更新" curl -L "$TARBALL_URL" -o "$TMP_DIR/source.tgz"
mkdir -p "$TMP_DIR/source" || fail "创建源码目录失败"
run "正在解压更新" tar -xzf "$TMP_DIR/source.tgz" -C "$TMP_DIR/source" --strip-components=1
run_sh "正在覆盖项目文件" "cd \\"$TMP_DIR/source\\" && tar --exclude='./data' --exclude='./node_modules' --exclude='./.git' -cf - . | tar -C \\"$ROOT\\" -xf -"
run_sh "正在安装依赖" "cd \\"$ROOT\\" && npm install"
run_sh "正在构建前端" "cd \\"$ROOT\\" && npm run build"

write_status restarting "更新完成，正在重启服务"
if [ -f /.dockerenv ]; then
  kill -TERM "$SERVER_PID"
else
  sh -c "cd \\"$ROOT\\" && sleep 2 && npm start >> \\"$ROOT/data/server.log\\" 2>&1" &
  kill -TERM "$SERVER_PID"
fi
`;
}

function startUpdateTask() {
  mkdirSync(UPDATE_BACKUP_DIR, { recursive: true });
  writeUpdateStatus({
    status: "running",
    message: "正在准备更新",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: ""
  });

  const child = spawn("sh", ["-c", createUpdaterScript()], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  return readUpdateStatus();
}

function createPasswordRecord(password, salt = randomBytes(16).toString("base64url")) {
  return {
    salt,
    passwordHash: scryptSync(String(password || ""), salt, 32).toString("base64url")
  };
}

function isValidUserConfig(user) {
  return Boolean(
    user &&
      typeof user.username === "string" &&
      user.username &&
      typeof user.salt === "string" &&
      user.salt &&
      typeof user.passwordHash === "string" &&
      user.passwordHash
  );
}

function readUserConfig() {
  ensureDataDir();

  if (!existsSync(USERS_FILE)) {
    const defaultUser = createDefaultUserConfig();
    safeWriteJson(USERS_FILE, defaultUser);
    return defaultUser;
  }

  const user = safeReadJson(USERS_FILE, null);
  if (isValidUserConfig(user)) return user;

  const defaultUser = createDefaultUserConfig();
  safeWriteJson(USERS_FILE, defaultUser);
  return defaultUser;
}

function writeUserConfig(user) {
  const nextUser = {
    ...user,
    updatedAt: new Date().toISOString()
  };
  safeWriteJson(USERS_FILE, nextUser);
  return nextUser;
}

function verifyPassword(user, password) {
  try {
    const expected = Buffer.from(user.passwordHash, "base64url");
    const actual = scryptSync(String(password || ""), user.salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function getSessionSecret(user) {
  return createHash("sha256")
    .update(`${user.username}:${user.salt}:${user.passwordHash}`)
    .digest();
}

function signSessionPayload(payloadText, user) {
  return createHmac("sha256", getSessionSecret(user)).update(payloadText).digest("base64url");
}

function createSessionValue(user) {
  const payload = {
    username: user.username,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000
  };
  const payloadText = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${payloadText}.${signSessionPayload(payloadText, user)}`;
}

function parseCookieHeader(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex === -1) return cookies;
      const key = part.slice(0, separatorIndex);
      const value = part.slice(separatorIndex + 1);
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  return parts.join("; ");
}

function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, "", { maxAge: 0 });
}

function getSessionUser(req) {
  const user = readUserConfig();
  const sessionValue = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionValue) return null;

  const [payloadText, signature] = sessionValue.split(".");
  if (!payloadText || !signature) return null;

  const expectedSignature = signSessionPayload(payloadText, user);
  const expectedBuffer = Buffer.from(expectedSignature);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
    if (payload.username !== user.username || Number(payload.exp || 0) < Date.now()) return null;
    return {
      username: user.username,
      updatedAt: user.updatedAt || null
    };
  } catch {
    return null;
  }
}

function requireAdminAuth(req, res) {
  const user = getSessionUser(req);
  if (user) return user;

  sendJson(res, 401, {
    error: {
      message: "请先登录",
      type: "authentication_error"
    }
  });
  return null;
}

function normalizePort(value, fallback) {
  const port = Number(value);
  if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
  return fallback;
}

function createApiKey() {
  return `sk-ctyun-${randomBytes(24).toString("base64url")}`;
}

function normalizeBearerToken(token) {
  let value = String(token || "").trim();
  if (!value) return "";
  if (/^bearer\s+/i.test(value)) {
    value = value.replace(/^bearer\s+/i, "").trim();
  }
  if (/^yl-token=/i.test(value)) {
    value = value.slice("yl-token=".length).trim();
  }
  if (value.includes(";")) {
    const match = value
      .split(";")
      .map((part) => part.trim())
      .find((part) => /^yl-token=/i.test(part));
    if (match) {
      value = match.slice("yl-token=".length).trim();
    }
  }
  return value;
}

function readConfig() {
  const config = safeReadJson(CONFIG_FILE, {});
  const upstreamToken = normalizeBearerToken(config.upstreamToken || config.cookie || "");
  return {
    upstreamToken,
    apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
    listenPort: normalizePort(config.listenPort, DEFAULT_PORT),
    serviceEnabled: typeof config.serviceEnabled === "boolean" ? config.serviceEnabled : true,
    autoStart: true,
    updatedAt: config.updatedAt || null
  };
}

function upgradeLegacyConfig() {
  const rawConfig = safeReadJson(CONFIG_FILE, {});
  const normalizedToken = normalizeBearerToken(rawConfig.upstreamToken || rawConfig.cookie || "");
  const needsUpgrade =
    rawConfig &&
    (typeof rawConfig.cookie === "string" ||
      rawConfig.upstreamToken !== normalizedToken ||
      !Object.prototype.hasOwnProperty.call(rawConfig, "upstreamToken"));

  if (!needsUpgrade) return;

  const nextConfig = {
    ...rawConfig,
    upstreamToken: normalizedToken
  };

  delete nextConfig.cookie;
  safeWriteJson(CONFIG_FILE, nextConfig);
}

function readModelCatalog() {
  const fallback = [
    {
      id: "default-model",
      object: "model",
      created: 0,
      owned_by: "ctyun",
      display_name: "default-model",
      key_model: "default-model",
      status: "available",
      type: "text"
    }
  ];

  const raw = safeReadJson(MODELS_FILE, fallback);
  if (!Array.isArray(raw) || raw.length === 0) return fallback;

  return raw
    .filter(
      (item) =>
        item &&
        (
          (typeof item.presetModelName === "string" && item.presetModelName.trim()) ||
          (typeof item.title === "string" && item.title.trim()) ||
          (typeof item.id === "string" && item.id.trim())
        )
    )
    .map((item) => ({
      id: String(
        item.key_model ||
          item.presetModelName ||
          item.title ||
          item.display_name ||
          item.name ||
          item.id
      ).trim(),
      object: "model",
      created: 0,
      owned_by: item.owned_by || "ctyun",
      title:
        item.key_model ||
        item.presetModelName ||
        item.title ||
        item.display_name ||
        item.name ||
        item.id.trim(),
      presetModelName: item.presetModelName || item.title || item.display_name || item.name || item.id.trim(),
      typeLabel: item.typeLabel || item.type_label || item.type || "",
      seriesLabel: item.seriesLabel || item.series_label || "",
      modelAbilityLabelName:
        item.modelAbilityLabelName || item.model_ability_label_name || item.abilityLabelName || "",
      display_name: item.presetModelName || item.display_name || item.name || item.id.trim(),
      key_model:
        item.key_model ||
        item.presetModelName ||
        item.modelId ||
        item.display_name ||
        item.id.trim(),
      source_model_id: item.modelId || item.id.trim(),
      status: item.status || "available",
      type: item.type || "text"
    }));
}

function getDefaultModelId() {
  return readModelCatalog()[0]?.id || "default-model";
}

function resolveUpstreamModel(requestedModel) {
  const requested = String(requestedModel || "").trim();
  const catalog = readModelCatalog();
  if (!requested) {
    return catalog[0]?.key_model || catalog[0]?.id || "default-model";
  }

  const match = catalog.find(
    (item) =>
      requested === String(item.id || "") ||
      requested === String(item.key_model || "") ||
      requested === String(item.title || "") ||
      requested === String(item.presetModelName || "") ||
      requested === String(item.display_name || "") ||
      requested === String(item.source_model_id || "")
  );

  return match?.key_model || requested;
}

function writeConfig(nextConfig) {
  const current = readConfig();
  const config = {
    ...current,
    ...nextConfig,
    upstreamToken:
      typeof nextConfig.upstreamToken === "string"
        ? normalizeBearerToken(nextConfig.upstreamToken)
        : current.upstreamToken,
    apiKey:
      typeof nextConfig.apiKey === "string" && nextConfig.apiKey
        ? nextConfig.apiKey
        : current.apiKey || createApiKey(),
    listenPort: normalizePort(nextConfig.listenPort, current.listenPort),
    serviceEnabled:
      typeof nextConfig.serviceEnabled === "boolean"
        ? nextConfig.serviceEnabled
        : current.serviceEnabled,
    autoStart: true,
    updatedAt: new Date().toISOString()
  };

  safeWriteJson(CONFIG_FILE, config);
  return config;
}

function getAvailableProxyHosts() {
  const interfaces = networkInterfaces();
  const hosts = [];
  const seen = new Set();

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        if (seen.has(entry.address)) continue;
        seen.add(entry.address);
        hosts.push({
          label: `${name} (${entry.address})`,
          host: entry.address,
          internal: false
        });
      }
    }
  }

  if (!seen.has("127.0.0.1")) {
    hosts.unshift({
      label: "本机 (127.0.0.1)",
      host: "127.0.0.1",
      internal: true
    });
  }

  return hosts;
}

function buildProxyUrls(port) {
  const hosts = getAvailableProxyHosts();
  const urls = hosts.map((item) => ({
    ...item,
    baseUrl: `http://${item.host}:${port}`,
    chatCompletionsUrl: `http://${item.host}:${port}/v1/chat/completions`
  }));
  const preferred = urls.find((item) => !item.internal) || urls[0];

  return {
    baseUrl: preferred?.baseUrl || `http://127.0.0.1:${port}`,
    chatCompletionsUrl: preferred?.chatCompletionsUrl || `http://127.0.0.1:${port}/v1/chat/completions`,
    proxyUrls: urls
  };
}

function readUsage() {
  return safeReadJson(USAGE_FILE, []);
}

function appendUsage(entry) {
  const usage = readUsage();
  usage.push(entry);

  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const compacted = usage.filter((item) => new Date(item.createdAt).getTime() >= ninetyDaysAgo);
  safeWriteJson(USAGE_FILE, compacted);
}

function summarizeUsage() {
  const usage = readUsage();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  const total = usage.reduce(
    (acc, item) => {
      acc.promptTokens += Number(item.promptTokens || 0);
      acc.completionTokens += Number(item.completionTokens || 0);
      acc.tokens += Number(item.tokens || 0);
      acc.requests += 1;
      return acc;
    },
    { promptTokens: 0, completionTokens: 0, tokens: 0, requests: 0 }
  );

  const today = usage
    .filter((item) => new Date(item.createdAt).getTime() >= todayStartMs)
    .reduce(
      (acc, item) => {
        acc.promptTokens += Number(item.promptTokens || 0);
        acc.completionTokens += Number(item.completionTokens || 0);
        acc.tokens += Number(item.tokens || 0);
        acc.requests += 1;
        return acc;
      },
      { promptTokens: 0, completionTokens: 0, tokens: 0, requests: 0 }
    );

  return {
    total,
    today,
    source: "local_estimate",
    note: "当前用量统计为代理本地估算值。"
  };
}

function maskText(value, prefix = 10, suffix = 10) {
  const text = String(value || "");
  if (text.length <= prefix + suffix) return text ? "***" : "";
  return `${text.slice(0, prefix)}...${text.slice(-suffix)}`;
}

function getMaskedTokenPreview(token) {
  return maskText(normalizeBearerToken(token));
}

function parseJwtPayload(token) {
  try {
    const [, payload] = String(token || "").split(".");
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function getAccountInfo(token) {
  const payload = parseJwtPayload(normalizeBearerToken(token));
  if (!payload) {
    return {
      name: "未配置令牌",
      clientId: "",
      role: "",
      resource: "",
      expiresAt: ""
    };
  }

  return {
    name: payload.clientId || payload.role || "CT API User",
    clientId: payload.clientId || "",
    role: payload.role || "",
    resource: payload.resource || "",
    expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : ""
  };
}

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text") return item.text || "";
        return "";
      })
      .join("\n");
  }
  return "";
}

function estimateTokensFromMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((total, message) => {
    const text = extractTextFromContent(message?.content);
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const nonCjk = text.length - cjk;
    return total + Math.max(1, Math.ceil(cjk * 1.2 + nonCjk / 4) + 12);
  }, 0);
}

function estimateTokensFromOutput(payloadText) {
  const text = String(payloadText || "");
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const nonCjk = text.length - cjk;
  return Math.max(1, Math.ceil(cjk * 1.2 + nonCjk / 4));
}

function getRequestBearer(req) {
  const auth = req.headers.authorization || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

function validateApiKey(req) {
  const bearer = getRequestBearer(req);
  const config = readConfig();
  return Boolean(config.apiKey) && bearer === config.apiKey;
}

function requireApiKey(req, res) {
  if (validateApiKey(req)) return true;

  sendJson(res, 401, {
    error: {
      message: "Invalid or missing API key",
      type: "authentication_error"
    }
  });
  return false;
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,anthropic-version,x-api-key",
    ...extraHeaders
  });
  res.end(statusCode === 204 ? "" : JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function normalizeCompletion(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices) {
      if (choice && choice.finish_reason === "") choice.finish_reason = null;
    }
  }
  return payload;
}

function normalizeSseText(text) {
  return String(text || "")
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      const data = line.slice(5).trimStart();
      if (data === "[DONE]" || data.trim() === "") return line;
      try {
        return `data: ${JSON.stringify(normalizeCompletion(JSON.parse(data)))}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

function getUpstreamAuthHeader() {
  const config = readConfig();
  const token = normalizeBearerToken(config.upstreamToken);
  return token ? `Bearer ${token}` : "";
}

function buildUpstreamHeaders() {
  const authorization = getUpstreamAuthHeader();
  if (!authorization) {
    const error = new Error("上游令牌未配置");
    error.status = 400;
    throw error;
  }

  return {
    accept: "*/*",
    "content-type": "application/json",
    authorization,
    "user-agent": "ctyun-openai-proxy"
  };
}

function buildSupportedModels() {
  return {
    object: "list",
    data: readModelCatalog()
  };
}

async function getAvailableModels() {
  return buildSupportedModels();
}

function normalizeChatRequest(body) {
  if (!Array.isArray(body.messages)) {
    const error = new Error("`messages` must be an array.");
    error.status = 400;
    throw error;
  }

  const requestedModel =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : getDefaultModelId();

  return {
    ...body,
    model: resolveUpstreamModel(requestedModel),
    original_model: requestedModel,
    stream: Boolean(body.stream)
  };
}

async function proxyChatCompletions(req, res) {
  if (!requireApiKey(req, res)) return;

  if (!readConfig().serviceEnabled) {
    sendJson(res, 503, {
      error: {
        message: "API proxy service is stopped",
        type: "service_unavailable"
      }
    });
    return;
  }

  const openaiBody = normalizeChatRequest(await readJsonBody(req));
  const requestId = createHash("sha1")
    .update(`${Date.now()}-${JSON.stringify(openaiBody)}`)
    .digest("hex")
    .slice(0, 16);
  const promptTokens = estimateTokensFromMessages(openaiBody.messages);

  const upstream = await fetch(UPSTREAM_URL, {
    method: "POST",
    headers: buildUpstreamHeaders(),
    body: JSON.stringify(openaiBody)
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    logRequest({ requestId, openaiBody, ctyunBody: openaiBody, result: { ok: false, status: upstream.status } });
    sendJson(
      res,
      upstream.status || 502,
      {
        error: {
          message: text || `Upstream returned HTTP ${upstream.status}.`,
          type: "upstream_error"
        }
      }
    );
    return;
  }

  if (openaiBody.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*"
    });

    const decoder = new TextDecoder();
    let completionPreview = "";
    for await (const chunk of upstream.body) {
      const text = decoder.decode(chunk, { stream: true });
      completionPreview += text;
      res.write(normalizeSseText(text));
    }
    const tail = decoder.decode();
    if (tail) {
      completionPreview += tail;
      res.write(normalizeSseText(tail));
    }

    appendUsage({
      id: requestId,
      createdAt: new Date().toISOString(),
      model: openaiBody.model,
      keyModel: openaiBody.model,
      promptTokens,
      completionTokens: estimateTokensFromOutput(completionPreview),
      tokens: promptTokens + estimateTokensFromOutput(completionPreview)
    });
    logRequest({ requestId, openaiBody, ctyunBody: openaiBody, result: { ok: true, stream: true } });
    res.end();
    return;
  }

  const payload = normalizeCompletion(await upstream.json());
  const completionTokens = estimateTokensFromOutput(JSON.stringify(payload?.choices || payload));
  appendUsage({
    id: requestId,
    createdAt: new Date().toISOString(),
    model: openaiBody.model,
    keyModel: openaiBody.model,
    promptTokens,
    completionTokens,
    tokens: promptTokens + completionTokens
  });
  logRequest({ requestId, openaiBody, ctyunBody: openaiBody, result: { ok: true, stream: false } });
  sendJson(res, 200, payload);
}

function extractAnthropicTextBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (block.type === "text") return block.text || "";
      if (block.type === "tool_result") {
        if (typeof block.content === "string") return block.content;
        if (Array.isArray(block.content)) {
          return block.content
            .map((item) => (typeof item?.text === "string" ? item.text : typeof item === "string" ? item : ""))
            .join("\n");
        }
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toOpenAIBodyFromAnthropic(body) {
  const messages = [];
  const requestedModel =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : getDefaultModelId();

  if (typeof body.system === "string" && body.system.trim()) {
    messages.push({
      role: "system",
      content: body.system
    });
  }

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      const textBlocks = [];
      for (const block of message.content) {
        if (block?.type === "text") {
          textBlocks.push({ type: "text", text: block.text || "" });
          continue;
        }
        if (block?.type === "tool_use") {
          messages.push({
            role: "assistant",
            content: textBlocks.length > 0 ? textBlocks : "",
            tool_calls: [
              {
                id: block.id,
                type: "function",
                function: {
                  name: block.name || "",
                  arguments: JSON.stringify(block.input || {})
                }
              }
            ]
          });
          textBlocks.length = 0;
        }
      }

      if (textBlocks.length > 0) {
        messages.push({
          role: "assistant",
          content: textBlocks
        });
      }
      continue;
    }

    if (message?.role === "user" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "tool_result") {
          messages.push({
            role: "tool",
            tool_call_id: block.tool_use_id || "",
            content: extractAnthropicTextBlocks(block.content)
          });
        }
      }
    }

    messages.push({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: Array.isArray(message?.content) ? extractAnthropicTextBlocks(message.content) : message?.content || ""
    });
  }

  return {
    model: resolveUpstreamModel(requestedModel),
    original_model: requestedModel,
    messages,
    tools: Array.isArray(body.tools)
      ? body.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description || "",
            parameters: tool.input_schema || { type: "object", properties: {} }
          }
        }))
      : undefined,
    tool_choice:
      body.tool_choice && typeof body.tool_choice === "object" && body.tool_choice.type === "tool"
        ? { type: "function", function: { name: body.tool_choice.name || "" } }
        : undefined,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: Boolean(body.stream)
  };
}

function toAnthropicStopReason(finishReason) {
  if (finishReason === "tool_calls") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  return "end_turn";
}

function buildAnthropicMessageResponseFromOpenAI(payload, fallbackModel) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];

  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      content.push({
        type: "tool_use",
        id: toolCall.id || `toolu_${randomBytes(8).toString("hex")}`,
        name: toolCall.function?.name || "",
        input: (() => {
          try {
            return JSON.parse(toolCall.function?.arguments || "{}");
          } catch {
            return {};
          }
        })()
      });
    }
  }

  return {
    id: payload?.id || `msg_${randomBytes(12).toString("hex")}`,
    type: "message",
    role: "assistant",
    model: payload?.model || fallbackModel || getDefaultModelId(),
    content,
    stop_reason: toAnthropicStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(payload?.usage?.prompt_tokens || 0),
      output_tokens: Number(payload?.usage?.completion_tokens || 0)
    }
  };
}

function writeAnthropicEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamAnthropicMessage(res, message) {
  writeAnthropicEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: message.id,
      type: "message",
      role: "assistant",
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: 0
      }
    }
  });

  let contentIndex = 0;
  let emittedOutputTokens = 0;
  for (const block of message.content) {
    if (block.type === "text") {
      writeAnthropicEvent(res, "content_block_start", {
        type: "content_block_start",
        index: contentIndex,
        content_block: { type: "text", text: "" }
      });
      writeAnthropicEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: contentIndex,
        delta: { type: "text_delta", text: block.text }
      });
      writeAnthropicEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: contentIndex
      });
      emittedOutputTokens += estimateTokensFromOutput(block.text);
      contentIndex += 1;
      continue;
    }

    if (block.type === "tool_use") {
      writeAnthropicEvent(res, "content_block_start", {
        type: "content_block_start",
        index: contentIndex,
        content_block: {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: {}
        }
      });
      writeAnthropicEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: contentIndex,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input || {})
        }
      });
      writeAnthropicEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: contentIndex
      });
      emittedOutputTokens += estimateTokensFromOutput(JSON.stringify(block.input || {}));
      contentIndex += 1;
    }
  }

  writeAnthropicEvent(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: null
    },
    usage: {
      output_tokens: emittedOutputTokens
    }
  });
  writeAnthropicEvent(res, "message_stop", { type: "message_stop" });
}

async function proxyAnthropicMessages(req, res) {
  if (!requireApiKey(req, res)) return;

  if (!readConfig().serviceEnabled) {
    sendJson(res, 503, {
      type: "error",
      error: {
        type: "service_unavailable",
        message: "API proxy service is stopped"
      }
    });
    return;
  }

  const anthropicBody = await readJsonBody(req);
  const openaiBody = toOpenAIBodyFromAnthropic(anthropicBody);
  const requestId = createHash("sha1")
    .update(`${Date.now()}-${JSON.stringify(openaiBody)}`)
    .digest("hex")
    .slice(0, 16);
  const promptTokens = estimateTokensFromMessages(openaiBody.messages);

  const upstream = await fetch(UPSTREAM_URL, {
    method: "POST",
    headers: buildUpstreamHeaders(),
    body: JSON.stringify(openaiBody)
  });

  const rawText = await upstream.text();
  if (!upstream.ok) {
    sendJson(res, upstream.status || 502, {
      type: "error",
      error: {
        type: "upstream_error",
        message: rawText || `Upstream request failed with status ${upstream.status}`
      }
    });
    return;
  }

  const normalized = normalizeSseText(rawText);
  const chunks = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((text) => text && text !== "[DONE]");

  let finalPayload = null;
  for (const text of chunks) {
    try {
      finalPayload = normalizeCompletion(JSON.parse(text));
    } catch {
      // Ignore non-json lines.
    }
  }

  if (!finalPayload) {
    sendJson(res, 502, {
      type: "error",
      error: {
        type: "upstream_error",
        message: "Upstream returned empty response"
      }
    });
    return;
  }

  const completionTokens = estimateTokensFromOutput(JSON.stringify(finalPayload?.choices || finalPayload));
  appendUsage({
    id: requestId,
    createdAt: new Date().toISOString(),
    model: openaiBody.model,
    keyModel: openaiBody.model,
    promptTokens,
    completionTokens,
    tokens: promptTokens + completionTokens
  });

  const message = buildAnthropicMessageResponseFromOpenAI(
    finalPayload,
    anthropicBody.model || getDefaultModelId()
  );
  if (anthropicBody.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*"
    });
    streamAnthropicMessage(res, message);
    res.end();
    return;
  }

  sendJson(res, 200, message);
}

async function handleModels(req, res) {
  if (!requireApiKey(req, res)) return;

  if (!readConfig().serviceEnabled) {
    sendJson(res, 503, {
      error: {
        message: "API proxy service is stopped",
        type: "service_unavailable"
      }
    });
    return;
  }

  sendJson(res, 200, await getAvailableModels());
}

async function handleConversations(req, res) {
  if (!requireApiKey(req, res)) return;
  sendJson(res, 200, {
    object: "list",
    data: [],
    first_id: null,
    last_id: null,
    has_more: false,
    metadata: {
      total: 0,
      page: 0,
      size: 0
    }
  });
}

async function handleConversationItems(req, res, conversationId) {
  if (!requireApiKey(req, res)) return;
  if (!conversationId) {
    sendJson(res, 400, {
      error: {
        message: "conversation_id is required",
        type: "invalid_request_error"
      }
    });
    return;
  }

  sendJson(res, 200, {
    object: "list",
    data: [],
    first_id: null,
    last_id: null,
    has_more: false,
    metadata: {
      conversation_id: conversationId,
      total: 0,
      page: 0,
      size: 0
    }
  });
}

async function handleConversation(req, res, conversationId) {
  if (!requireApiKey(req, res)) return;
  if (!conversationId) {
    sendJson(res, 400, {
      error: {
        message: "conversation_id is required",
        type: "invalid_request_error"
      }
    });
    return;
  }

  sendJson(res, 200, {
    id: conversationId,
    object: "conversation",
    created_at: 0,
    metadata: {}
  });
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const user = readUserConfig();
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  if (username !== user.username || !verifyPassword(user, password)) {
    sendJson(res, 401, {
      error: {
        message: "用户名或密码错误",
        type: "authentication_error"
      }
    });
    return;
  }

  sendJson(
    res,
    200,
    {
      ok: true,
      user: {
        username: user.username,
        updatedAt: user.updatedAt || null
      }
    },
    {
      "set-cookie": serializeCookie(SESSION_COOKIE, createSessionValue(user), {
        maxAge: SESSION_MAX_AGE_SECONDS
      })
    }
  );
}

async function handleLogout(_req, res) {
  sendJson(
    res,
    200,
    {
      ok: true
    },
    {
      "set-cookie": clearSessionCookie()
    }
  );
}

async function handleCurrentUser(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, {
      error: {
        message: "请先登录",
        type: "authentication_error"
      }
    });
    return;
  }

  sendJson(res, 200, { user });
}

async function handleChangePassword(req, res) {
  const user = requireAdminAuth(req, res);
  if (!user) return;

  const body = await readJsonBody(req);
  const currentPassword = String(body.currentPassword || "");
  const nextPassword = String(body.nextPassword || "");
  const config = readUserConfig();

  if (!verifyPassword(config, currentPassword)) {
    sendJson(res, 400, {
      error: {
        message: "当前密码错误",
        type: "invalid_request_error"
      }
    });
    return;
  }

  const nextUser = writeUserConfig({
    ...config,
    ...createPasswordRecord(nextPassword)
  });

  sendJson(
    res,
    200,
    {
      ok: true,
      user: {
        username: nextUser.username,
        updatedAt: nextUser.updatedAt || null
      }
    },
    {
      "set-cookie": serializeCookie(SESSION_COOKIE, createSessionValue(nextUser), {
        maxAge: SESSION_MAX_AGE_SECONDS
      })
    }
  );
}

async function handleDashboard(_req, res) {
  const config = readConfig();
  const account = getAccountInfo(config.upstreamToken);
  const models = (await getAvailableModels()).data;

  sendJson(res, 200, {
    account: {
      ...account,
      accountError: config.upstreamToken ? "" : "请在账号管理中配置上游令牌"
    },
    service: {
      enabled: config.serviceEnabled,
      autoStart: config.autoStart,
      listenPort: config.listenPort
    },
    models,
    modelsError: "",
    usage: summarizeUsage()
  });
}

async function handleGetConfig(_req, res) {
  const config = readConfig();
  const token = config.apiKey || createApiKey();
  const urls = buildProxyUrls(config.listenPort);

  if (!config.apiKey) {
    writeConfig({ apiKey: token });
  }

  sendJson(res, 200, {
    hasToken: Boolean(config.upstreamToken),
    tokenPreview: getMaskedTokenPreview(config.upstreamToken),
    updatedAt: config.updatedAt,
    serviceEnabled: config.serviceEnabled,
    autoStart: config.autoStart,
    listenPort: config.listenPort,
    token,
    baseUrl: urls.baseUrl,
    chatCompletionsUrl: urls.chatCompletionsUrl,
    proxyUrls: urls.proxyUrls
  });
}

async function handlePostConfig(req, res) {
  const body = await readJsonBody(req);
  const current = readConfig();
  const upstreamToken =
    typeof body.upstreamToken === "string" ? normalizeBearerToken(body.upstreamToken) : current.upstreamToken;

  if (typeof body.upstreamToken === "string" && !upstreamToken) {
    sendJson(res, 400, {
      error: {
        message: "upstreamToken is required",
        type: "invalid_request_error"
      }
    });
    return;
  }

  const config = writeConfig({
    upstreamToken,
    serviceEnabled: body.serviceEnabled,
    autoStart: true,
    listenPort: body.listenPort,
    apiKey: body.regenerateApiKey ? createApiKey() : current.apiKey
  });
  const urls = buildProxyUrls(config.listenPort);

  const portChanged = config.listenPort !== currentListenPort;
  if (portChanged) {
    schedulePortChange(config.listenPort);
  }

  sendJson(res, 200, {
    ok: true,
    hasToken: Boolean(config.upstreamToken),
    tokenPreview: getMaskedTokenPreview(config.upstreamToken),
    updatedAt: config.updatedAt,
    serviceEnabled: config.serviceEnabled,
    autoStart: config.autoStart,
    listenPort: config.listenPort,
    portChanged,
    token: config.apiKey,
    baseUrl: urls.baseUrl,
    chatCompletionsUrl: urls.chatCompletionsUrl,
    proxyUrls: urls.proxyUrls
  });
}

async function fetchRemoteVersionInfo() {
  const url = new URL(VERSION_URL);
  url.searchParams.set("t", String(Date.now()));

  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error("版本信息获取失败");
  }

  const payload = await response.json();
  if (!payload?.version) {
    throw new Error("版本信息格式无效");
  }

  return payload;
}

async function handleUpdateCheck(_req, res) {
  const localInfo = readLocalVersionInfo();
  const remoteInfo = await fetchRemoteVersionInfo();
  const compareResult = compareVersions(localInfo.version, remoteInfo.version);
  const status = normalizeUpdateStatus();

  sendJson(res, 200, {
    currentVersion: localInfo.version,
    latestVersion: remoteInfo.version,
    changelog: remoteInfo.changelog || "",
    updateAvailable: compareResult > 0,
    status
  });
}

async function handleUpdateStatus(_req, res) {
  sendJson(res, 200, normalizeUpdateStatus());
}

async function handleUpdateApply(_req, res) {
  const status = normalizeUpdateStatus();
  if (status.status === "running" || status.status === "restarting") {
    sendJson(res, 409, {
      error: {
        message: "更新任务正在运行",
        type: "conflict"
      },
      status
    });
    return;
  }

  sendJson(res, 202, startUpdateTask());
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${currentListenPort}`}`);
  const pathname = decodeURIComponent(url.pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let filePath = resolve(PUBLIC_DIR, relativePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, {
      error: {
        message: "Forbidden",
        type: "forbidden"
      }
    });
    return;
  }

  if (!existsSync(filePath)) {
    const indexPath = resolve(PUBLIC_DIR, "index.html");
    if (req.method === "GET" && existsSync(indexPath)) {
      filePath = indexPath;
    } else {
      sendJson(res, 404, {
        error: {
          message: "Not found",
          type: "not_found"
        }
      });
      return;
    }
  }

  const contentType = MIME_TYPES[extname(filePath)] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-cache"
  });
  res.end(readFileSync(filePath));
}

let currentListenPort = readConfig().listenPort;

function schedulePortChange(nextPort) {
  setTimeout(() => {
    server.close((error) => {
      if (error) {
        console.error(`Failed to close current listener: ${error.message}`);
        return;
      }

      server.listen(nextPort, LISTEN_HOST, () => {
        currentListenPort = nextPort;
        console.log(`CT API proxy listening on http://${LISTEN_HOST}:${nextPort}`);
      });
    });
  }, 200);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `localhost:${currentListenPort}`}`);

    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true, service: "ct-api-proxy" });
        return;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      await handleLogin(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      await handleLogout(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      await handleCurrentUser(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/password") {
      await handleChangePassword(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      if (!requireAdminAuth(req, res)) return;
      await handleGetConfig(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/config") {
      if (!requireAdminAuth(req, res)) return;
      await handlePostConfig(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/update/check") {
      if (!requireAdminAuth(req, res)) return;
      await handleUpdateCheck(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/update/status") {
      if (!requireAdminAuth(req, res)) return;
      await handleUpdateStatus(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/update/apply") {
      if (!requireAdminAuth(req, res)) return;
      await handleUpdateApply(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      if (!requireAdminAuth(req, res)) return;
      await handleDashboard(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      await handleModels(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/debug/logs") {
      if (!requireApiKey(req, res)) return;
      const n = Number(url.searchParams.get("n") || 20);
      sendJson(res, 200, getRecentLogs(n));
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/conversations") {
      await handleConversations(req, res, url);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/v1/conversations/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const conversationId = decodeURIComponent(parts[2] || "");

      if (parts.length === 4 && parts[3] === "items") {
        await handleConversationItems(req, res, conversationId, url);
        return;
      }

      if (parts.length === 3) {
        await handleConversation(req, res, conversationId);
        return;
      }
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      await proxyChatCompletions(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      await proxyAnthropicMessages(req, res);
      return;
    }

    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }

    sendJson(res, 404, {
      error: {
        message: "Not found",
        type: "not_found"
      }
    });
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    sendJson(res, error.status || 500, {
      error: {
        message: error.message || "Internal server error",
        type: error.status ? "invalid_request_error" : "server_error"
      }
    });
  }
});

ensureDataFiles();
upgradeLegacyConfig();
reconcileUpdateStatusOnStartup();
currentListenPort = readConfig().listenPort;

server.listen(currentListenPort, LISTEN_HOST, () => {
  console.log(`CT API proxy listening on http://${LISTEN_HOST}:${currentListenPort}`);
});
