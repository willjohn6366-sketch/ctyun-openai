import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const DEFAULT_PORT = 3000;
const LISTEN_HOST = "0.0.0.0";
const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_PASSWORD = "admin";
const SESSION_COOKIE = "ct_api_session";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const CTYUN_CONVERSATION_TTL_MS = Number.POSITIVE_INFINITY;
const CTYUN_CHAT_URL = "https://eaichat.ctyun.cn/ai/portal/v3/openai/chat/completions";
const CTYUN_UPLOAD_URL = "https://eaichat.ctyun.cn/ai/portal/v2/vector/upload";
const CTYUN_MODELS_URL =
  "https://eaichat.ctyun.cn/ai/portal/v2/openai/chat/queryModels?type=all";
const CTYUN_USER_INFO_URL = "https://eaichat.ctyun.cn/ai/portal/v1/user/queryUserInfo";
const CTYUN_HISTORY_URL = "https://eaichat.ctyun.cn/ai/portal/v2/openai/chat/history";
const CTYUN_OFFSET_URL = "https://eaichat.ctyun.cn/ai/portal/v2/openai/chat/offset";
const VERSION_URL = "https://cdn.jsdelivr.net/gh/willjohn6366-sketch/ctyun-openai@main/version.json";
const SOURCE_TARBALL_URL = "https://codeload.github.com/willjohn6366-sketch/ctyun-openai/tar.gz/main";


const BASE_CTYUN_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 IOS/WKWebView WEB/CloudDesktop platform/CloudDesktop mainVersion/1040000011",
  "x-user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 IOS/WKWebView WEB/CloudDesktop platform/CloudDesktop mainVersion/1040000011",
  "x-eai-env": "pubH5",
  "accept-language": "zh-CN,zh-Hans;q=0.9",
  "content-type": "application/json",
  "accept-encoding": "gzip, deflate, br",
  "sec-fetch-mode": "cors"
};

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

const ctyunConversationCache = new Map();

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureDataFiles() {
  ensureDataDir();

  if (!existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, JSON.stringify({}, null, 2));
  }

  if (!existsSync(USAGE_FILE)) {
    writeFileSync(USAGE_FILE, JSON.stringify([], null, 2));
  }

  if (!existsSync(USERS_FILE)) {
    safeWriteJson(USERS_FILE, createDefaultUserConfig());
  }

  if (!existsSync(UPDATE_STATUS_FILE)) {
    safeWriteJson(UPDATE_STATUS_FILE, createIdleUpdateStatus());
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

function createDefaultUserConfig() {
  const now = new Date().toISOString();
  return {
    username: DEFAULT_ADMIN_USERNAME,
    ...createPasswordRecord(DEFAULT_ADMIN_PASSWORD),
    createdAt: now,
    updatedAt: now
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

function readConfig() {
  const config = safeReadJson(CONFIG_FILE, {});
  return {
    cookie: typeof config.cookie === "string" ? config.cookie : "",
    apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
    listenPort: normalizePort(config.listenPort, DEFAULT_PORT),
    serviceEnabled: typeof config.serviceEnabled === "boolean" ? config.serviceEnabled : true,
    autoStart: true,
    updatedAt: config.updatedAt || null
  };
}

function writeConfig(nextConfig) {
  const current = readConfig();
  const config = {
    ...current,
    ...nextConfig,
    cookie:
      typeof nextConfig.cookie === "string" ? normalizeCookie(nextConfig.cookie) : current.cookie,
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

function normalizePort(value, fallback) {
  const port = Number(value);
  if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
  return fallback;
}

function getPreferredLanIp() {
  const interfaces = networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  return "127.0.0.1";
}

function buildProxyUrls(port) {
  const host = getPreferredLanIp();

  return {
    baseUrl: `http://${host}:${port}`,
    chatCompletionsUrl: `http://${host}:${port}/v1/chat/completions`
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

function normalizeCookie(cookie) {
  const value = String(cookie || "").trim();
  if (!value) return "";
  const token = getTokenFromCookie(value) || value;
  return token ? `YL-Token=${token}` : "";
}

function getTokenFromCookie(cookie) {
  return String(cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("YL-Token="))
    ?.slice("YL-Token=".length);
}

function createApiKey() {
  return `sk-ctyun-${randomBytes(24).toString("base64url")}`;
}

function getMaskedTokenPreview(cookie, prefix = 10, suffix = 10) {
  const token = getTokenFromCookie(cookie) || String(cookie || "").trim();
  return maskText(token, prefix, suffix);
}

function maskText(value, prefix = 6, suffix = 4) {
  const text = String(value || "");
  if (text.length <= prefix + suffix) return text ? "***" : "";
  return `${text.slice(0, prefix)}...${text.slice(-suffix)}`;
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

function getAccountInfo(cookie) {
  const token = getTokenFromCookie(cookie);
  const payload = parseJwtPayload(token);

  if (!payload) {
    return {
      name: "未登录",
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

function estimateTokens(content) {
  const text = extractTextContent(content);
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const nonCjk = text.length - cjk;
  return Math.max(1, Math.ceil(cjk * 1.2 + nonCjk / 4));
}

function estimateImageTokens(fileList) {
  return (Array.isArray(fileList) ? fileList.length : 0) * 512;
}

function estimatePromptTokens(message) {
  if (!message) return 0;
  return estimateTokens(message.content) + estimateImageTokens(message.ref?.file) + 12;
}

function extractDeltaTextFromSseChunk(chunkText) {
  const pieces = [];

  for (const line of String(chunkText || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;

    const payloadText = trimmed.slice(5).trim();
    if (!payloadText || payloadText === "[DONE]") continue;

    try {
      const payload = JSON.parse(payloadText);
      const content = payload?.choices?.[0]?.delta?.content;
      if (typeof content === "string" && content) {
        pieces.push(content);
      }
    } catch {
      // Ignore partial or non-JSON SSE lines.
    }
  }

  return pieces.join("");
}

function scanConversationFields(value, result = {}) {
  if (!value || typeof value !== "object") return result;

  if (Array.isArray(value)) {
    for (const item of value) {
      scanConversationFields(item, result);
    }
    return result;
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    if ((key === "conversation_id" || key === "conversationId") && fieldValue) {
      result.conversationId = String(fieldValue);
    }

    if ((key === "message_id" || key === "messageId") && fieldValue) {
      result.messageId = fieldValue;
    }

    if (fieldValue && typeof fieldValue === "object") {
      scanConversationFields(fieldValue, result);
    }
  }

  return result;
}

function extractCtyunConversationFromSseChunk(chunkText) {
  const result = {};

  for (const line of String(chunkText || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;

    const payloadText = trimmed.slice(5).trim();
    if (!payloadText || payloadText === "[DONE]") continue;

    try {
      scanConversationFields(JSON.parse(payloadText), result);
    } catch {
      // Ignore partial or non-JSON SSE lines.
    }
  }

  return result;
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
    note: "当前用量统计为代理本地估算值；如果需要官方用量，需要接入对应接口。"
  };
}

function getRequestCookie(req) {
  const auth = req.headers.authorization || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const config = readConfig();

  if (bearer && bearer === config.apiKey) return config.cookie;

  return config.cookie;
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

function buildCtyunHeaders(cookie) {
  return {
    cookie: normalizeCookie(cookie),
    ...BASE_CTYUN_HEADERS
  };
}

function buildCtyunUploadHeaders(cookie) {
  const headers = {
    ...BASE_CTYUN_HEADERS,
    cookie: normalizeCookie(cookie)
  };

  delete headers["content-type"];
  return headers;
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
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

function pruneCtyunConversationCache(now = Date.now()) {
  for (const [key, session] of ctyunConversationCache.entries()) {
    if (now - Number(session.updatedAt || 0) > CTYUN_CONVERSATION_TTL_MS) {
      ctyunConversationCache.delete(key);
    }
  }
}

function getClientConversationKey(req, openaiBody, keyModel) {
  const explicitConversationId = openaiBody.conversation_id || openaiBody.conversationId;
  if (explicitConversationId) return `conversation:${String(explicitConversationId)}`;

  if (openaiBody.user) return `user:${String(openaiBody.user)}:${keyModel}`;

  const bearer = getRequestBearer(req) || "anonymous";
  const fingerprint = getOpenAIConversationFingerprint(openaiBody);
  if (fingerprint) return `thread:${bearer}:${keyModel}:${fingerprint}`;

  return `auth:${bearer}:${keyModel}`;
}

function hasExplicitClientConversationKey(openaiBody) {
  return Boolean(openaiBody.conversation_id || openaiBody.conversationId || openaiBody.user);
}

function isFreshOpenAIConversationStart(openaiBody) {
  if (hasExplicitClientConversationKey(openaiBody)) return false;
  if (openaiBody.reset_conversation || openaiBody.resetConversation) return true;

  const messages = getOpenAIMessages(openaiBody);
  if (messages.length === 0) return false;

  const assistantMessages = messages.filter((message) => normalizeCtyunRole(message?.role) === "assistant");
  const userMessages = messages.filter((message) => normalizeCtyunRole(message?.role) === "user");

  return assistantMessages.length === 0 && userMessages.length <= 1;
}

function readCtyunConversation(sessionKey) {
  pruneCtyunConversationCache();

  const session = ctyunConversationCache.get(sessionKey);
  if (!session) return null;

  if (Date.now() - Number(session.updatedAt || 0) > CTYUN_CONVERSATION_TTL_MS) {
    ctyunConversationCache.delete(sessionKey);
    return null;
  }

  return session;
}

function clearCtyunConversation(sessionKey) {
  ctyunConversationCache.delete(sessionKey);
}

function writeCtyunConversation(sessionKey, patch) {
  const current = ctyunConversationCache.get(sessionKey) || {};
  const cleanPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
  const next = {
    ...current,
    ...cleanPatch,
    updatedAt: Date.now()
  };

  if (next.conversationId || next.messageId) {
    ctyunConversationCache.set(sessionKey, next);
  }

  pruneCtyunConversationCache(next.updatedAt);
  return next;
}

function pickFirstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function getOpenAIConversationFingerprint(openaiBody) {
  const messages = getOpenAIMessages(openaiBody);
  const anchors = [];

  for (const message of messages) {
    const role = normalizeCtyunRole(message?.role);
    const text = getMessageText(message);
    if (!text) continue;

    if (role === "system" || role === "user") {
      anchors.push(`${role}:${text}`);
    }

    if (anchors.some((item) => item.startsWith("user:"))) break;
  }

  if (anchors.length === 0) return "";

  return createHash("sha1").update(anchors.join("\n")).digest("hex").slice(0, 16);
}

function normalizeMessageContent(content) {
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return {
            type: "text",
            text: item
          };
        }

        if (!item || typeof item !== "object") return null;

        if (item.type === "text") {
          return {
            type: "text",
            text: String(item.text || "")
          };
        }

        if (item.type === "image_url") {
          const imageUrl =
            typeof item.image_url === "string"
              ? { url: item.image_url }
              : {
                  ...item.image_url,
                  url: String(item.image_url?.url || "")
                };

          if (!imageUrl.url) return null;

          return {
            type: "image_url",
            image_url: imageUrl
          };
        }

        return item;
      })
      .filter(Boolean);
  }

  return String(content ?? "");
}

function splitMessageContent(content) {
  const normalized = normalizeMessageContent(content);

  if (!Array.isArray(normalized)) {
    return {
      text: String(normalized || ""),
      images: []
    };
  }

  const text = normalized
    .map((item) => (item?.type === "text" ? String(item.text || "") : ""))
    .join("");

  const images = normalized
    .filter((item) => item?.type === "image_url")
    .map((item) => item.image_url)
    .filter(Boolean);

  return { text, images };
}

function extractTextContent(content) {
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text") return String(item.text || "");
        return "";
      })
      .join("");
  }

  return String(content ?? "");
}

function hasUsableContent(content) {
  if (Array.isArray(content)) {
    return content.some((item) => {
      if (typeof item === "string") return Boolean(item.trim());
      if (!item || typeof item !== "object") return false;
      if (item.type === "text") return Boolean(String(item.text || "").trim());
      if (item.type === "image_url") {
        const url = typeof item.image_url === "string" ? item.image_url : item.image_url?.url;
        return Boolean(String(url || "").trim());
      }
      return true;
    });
  }

  return Boolean(String(content ?? "").trim());
}

function extractContent(openaiBody) {
  if (typeof openaiBody.content !== "undefined") {
    return normalizeMessageContent(openaiBody.content);
  }

  if (Array.isArray(openaiBody.messages) && openaiBody.messages.length > 0) {
    const lastUserMessage =
      [...openaiBody.messages].reverse().find((message) => message.role === "user") ||
      openaiBody.messages.at(-1);

    return normalizeMessageContent(lastUserMessage?.content);
  }

  return "";
}

function normalizeCtyunRole(role) {
  const value = String(role || "").toLowerCase();
  if (value === "assistant" || value === "system" || value === "user") return value;
  return "user";
}

function getOpenAIMessages(openaiBody) {
  if (Array.isArray(openaiBody.messages) && openaiBody.messages.length > 0) {
    return openaiBody.messages;
  }

  if (typeof openaiBody.content !== "undefined") {
    return [
      {
        role: "user",
        content: openaiBody.content
      }
    ];
  }

  return [];
}

function getMessageText(message) {
  return extractTextContent(normalizeMessageContent(message?.content)).trim();
}

function isLastUserMessage(messages, index) {
  for (let current = messages.length - 1; current >= 0; current -= 1) {
    if (normalizeCtyunRole(messages[current]?.role) === "user") {
      return current === index;
    }
  }

  return index === messages.length - 1;
}

async function toCtyunMessage(message, { cookie, includeImages = false }) {
  const normalizedContent = normalizeMessageContent(message?.content);
  const { text, images } = splitMessageContent(normalizedContent);
  const uploadedFiles = [];

  if (includeImages) {
    for (let index = 0; index < images.length; index += 1) {
      uploadedFiles.push(await uploadImageReference(cookie, images[index], index));
    }
  }

  return {
    role: normalizeCtyunRole(message?.role),
    content: text.trim() || (uploadedFiles.length > 0 ? "请分析图片内容" : ""),
    verify_id: message?.verify_id || message?.verifyId || randomUUID(),
    ref: {
      type: "file",
      file: uploadedFiles
    }
  };
}

async function toCtyunMessages(openaiBody, cookie) {
  const openaiMessages = getOpenAIMessages(openaiBody);
  const messages = [];

  for (let index = 0; index < openaiMessages.length; index += 1) {
    const ctyunMessage = await toCtyunMessage(openaiMessages[index], {
      cookie,
      includeImages: isLastUserMessage(openaiMessages, index)
    });

    if (hasUsableContent(ctyunMessage.content) || ctyunMessage.ref.file.length > 0) {
      messages.push(ctyunMessage);
    }
  }

  return messages;
}

function guessExtensionFromMime(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("bmp")) return "bmp";
  return "png";
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) {
    throw new Error("Unsupported image data URL");
  }

  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  const bytes = isBase64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");

  return { mimeType, bytes };
}

async function resolveImageAsset(imageUrl, index) {
  const url = String(typeof imageUrl === "string" ? imageUrl : imageUrl?.url || "").trim();
  if (!url) {
    throw new Error("Image URL is required");
  }

  if (url.startsWith("data:")) {
    const { mimeType, bytes } = parseDataUrl(url);
    const extension = guessExtensionFromMime(mimeType);
    return {
      bytes,
      mimeType,
      fileName: `image-${index + 1}.${extension}`
    };
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }

  const mimeType = response.headers.get("content-type") || "application/octet-stream";
  const bytes = Buffer.from(await response.arrayBuffer());
  const pathname = new URL(url).pathname;
  const nameFromUrl = pathname.split("/").pop() || "";
  const fallbackExt = guessExtensionFromMime(mimeType);
  const fileName = nameFromUrl && nameFromUrl.includes(".") ? nameFromUrl : `image-${index + 1}.${fallbackExt}`;

  return { bytes, mimeType, fileName };
}

async function uploadImageReference(cookie, imageUrl, index) {
  const asset = await resolveImageAsset(imageUrl, index);
  const form = new FormData();
  form.append("file", new Blob([asset.bytes], { type: asset.mimeType }), asset.fileName);

  const response = await fetch(CTYUN_UPLOAD_URL, {
    method: "POST",
    headers: buildCtyunUploadHeaders(cookie),
    body: form
  });

  const payload = await response.json();
  const file = Array.isArray(payload?.data) ? payload.data[0] : null;

  if (!response.ok || payload?.resultCode !== 0 || !file?.success || !file?.file_id) {
    throw new Error(payload?.resultMsg || file?.msg || "Image upload failed");
  }

  return {
    file_id: file.file_id,
    file_type: file.file_type || asset.fileName.split(".").pop() || "",
    file_name: file.file_name || asset.fileName,
    word_count: Number(file.word_count || 0),
    file_size: Number(file.file_size || asset.bytes.length),
    raw: {}
  };
}

function extractModelIds(modelValue) {
  if (typeof modelValue !== "string") return [];

  const [modelPart] = modelValue.split(";");

  return modelPart
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

function toOpenAIModels(ctyunModels) {
  const seen = new Set();
  const models = [];

  for (const item of ctyunModels) {
    for (const id of extractModelIds(item.model)) {
      if (seen.has(id)) continue;
      seen.add(id);

      models.push({
        id,
        object: "model",
        created: 0,
        owned_by: "ctyun",
        display_name: item.modelName || id,
        key_model: item.keyModel || "",
        status: item.status || "",
        type: item.type || ""
      });
    }
  }

  return {
    object: "list",
    data: models
  };
}

function toUnixSeconds(value) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : Math.floor(timestamp / 1000);
}

function getCtyunConversationId(item) {
  return String(
    item?.conversationId ||
      item?.conversation_id ||
      item?.id ||
      item?.uuid ||
      item?.conversation?.conversationId ||
      ""
  );
}

function getCtyunConversationTitle(item) {
  return String(
    item?.title ||
      item?.conversationTitle ||
      item?.conversationName ||
      item?.name ||
      item?.messageContent ||
      item?.firstMessage ||
      "Untitled"
  );
}

function toOpenAIConversation(item) {
  const id = getCtyunConversationId(item);

  return {
    id,
    object: "conversation",
    created_at: toUnixSeconds(item?.createTime || item?.createdAt || item?.created_time),
    metadata: {
      title: getCtyunConversationTitle(item),
      updated_at: item?.updateTime || item?.updatedAt || item?.update_time || "",
      conversation_type: item?.conversationType || item?.conversation_type || "",
      model: item?.model || "",
      key_model: item?.keyModel || item?.key_model || "",
      raw: item
    }
  };
}

function toOpenAIConversationList(ctyunBody) {
  const content = Array.isArray(ctyunBody?.content)
    ? ctyunBody.content
    : Array.isArray(ctyunBody?.data)
      ? ctyunBody.data
      : [];
  const data = content.map(toOpenAIConversation).filter((item) => item.id);

  return {
    object: "list",
    data,
    first_id: data[0]?.id || null,
    last_id: data.at(-1)?.id || null,
    has_more: Boolean(ctyunBody && ctyunBody.last === false),
    metadata: {
      total: Number(ctyunBody?.totalElements || ctyunBody?.total || data.length),
      page: Number(ctyunBody?.number || ctyunBody?.pageable?.pageNumber || 0),
      size: Number(ctyunBody?.size || ctyunBody?.pageable?.pageSize || data.length)
    }
  };
}

function toOpenAIConversationItem(item) {
  const role = String(item?.messageRole || item?.role || "user").toLowerCase();
  const contentText = String(item?.messageContent || item?.content || "");
  const createdAt = toUnixSeconds(item?.createTime || item?.createdAt || item?.created_time);
  const messageId = item?.messageId || item?.message_id || randomUUID();
  const contentType = role === "assistant" ? "output_text" : "input_text";

  return {
    id: `msg_${messageId}`,
    type: "message",
    status: "completed",
    role: role === "assistant" ? "assistant" : "user",
    content: [
      {
        type: contentType,
        text: contentText
      }
    ],
    created_at: createdAt,
    metadata: {
      conversation_id: item?.conversationId || item?.conversation_id || "",
      message_type: item?.messageType || item?.message_type || "",
      model: item?.model || "",
      key_model: item?.keyModel || item?.key_model || "",
      token_count: Number(item?.tokenCount || item?.token_count || 0),
      verify_id: item?.verifyId || item?.verify_id || "",
      raw: item
    }
  };
}

function toOpenAIConversationItems(ctyunBody) {
  const content = Array.isArray(ctyunBody?.content)
    ? ctyunBody.content
    : Array.isArray(ctyunBody?.data)
      ? ctyunBody.data
      : [];
  const data = content.map(toOpenAIConversationItem);

  return {
    object: "list",
    data,
    first_id: data[0]?.id || null,
    last_id: data.at(-1)?.id || null,
    has_more: Boolean(ctyunBody && ctyunBody.last === false),
    metadata: {
      total: Number(ctyunBody?.totalElements || ctyunBody?.total || data.length),
      page: Number(ctyunBody?.number || ctyunBody?.pageable?.pageNumber || 0),
      size: Number(ctyunBody?.size || ctyunBody?.pageable?.pageSize || data.length)
    }
  };
}

async function queryCtyunModels(cookie = readConfig().cookie) {
  const upstream = await fetch(CTYUN_MODELS_URL, {
    method: "GET",
    headers: buildCtyunHeaders(cookie)
  });

  const ctyunBody = await upstream.json();

  if (ctyunBody.resultCode !== 0 || !Array.isArray(ctyunBody.data)) {
    throw new Error(ctyunBody.resultMsg || "Failed to query upstream models");
  }

  return ctyunBody.data;
}

async function queryCtyunUserInfo(cookie = readConfig().cookie) {
  const upstream = await fetch(CTYUN_USER_INFO_URL, {
    method: "GET",
    headers: buildCtyunHeaders(cookie)
  });

  const ctyunBody = await upstream.json();

  if (ctyunBody.resultCode !== 0 || !ctyunBody.data) {
    throw new Error(ctyunBody.resultMsg || "Failed to query upstream user info");
  }

  return {
    nickName: ctyunBody.data.nickName || "",
    vipType: ctyunBody.data.vipType || "",
    mobile: ctyunBody.data.mobile || "",
    vipExpireDate: ctyunBody.data.vipExpireDate || ""
  };
}

async function queryCtyunHistory(cookie, { conversationType = "all", page = 0, size = 10 } = {}) {
  const url = new URL(CTYUN_HISTORY_URL);
  url.searchParams.set("conversation_type", conversationType);
  url.searchParams.set("page", String(Math.max(0, Number(page) || 0)));
  url.searchParams.set("size", String(Math.max(1, Math.min(100, Number(size) || 10))));

  const upstream = await fetch(url, {
    method: "GET",
    headers: buildCtyunHeaders(cookie)
  });
  const ctyunBody = await upstream.json();

  if (!upstream.ok) {
    throw new Error(ctyunBody?.resultMsg || ctyunBody?.message || "Failed to query upstream conversations");
  }

  return ctyunBody;
}

async function queryCtyunConversationItems(cookie, { conversationId, count = 20 } = {}) {
  const url = new URL(CTYUN_OFFSET_URL);
  url.searchParams.set("conversation_id", String(conversationId || ""));
  url.searchParams.set("count", String(Math.max(1, Math.min(100, Number(count) || 20))));

  const upstream = await fetch(url, {
    method: "GET",
    headers: buildCtyunHeaders(cookie)
  });
  const ctyunBody = await upstream.json();

  if (!upstream.ok) {
    throw new Error(ctyunBody?.resultMsg || ctyunBody?.message || "Failed to query upstream conversation items");
  }

  return ctyunBody;
}

function getCtyunHistoryContent(ctyunBody) {
  return Array.isArray(ctyunBody?.content)
    ? ctyunBody.content
    : Array.isArray(ctyunBody?.data)
      ? ctyunBody.data
      : [];
}

function getKnownConversationTexts(openaiBody) {
  const messages = getOpenAIMessages(openaiBody);
  const lastUserIndex = messages.findLastIndex((message) => normalizeCtyunRole(message?.role) === "user");

  return messages
    .map((message, index) => ({ index, text: getMessageText(message) }))
    .filter((item) => item.text && item.index !== lastUserIndex)
    .map((item) => item.text)
    .slice(-4);
}

async function hydrateCtyunConversationFromHistory(cookie, openaiBody, keyModel) {
  const historyBody = await queryCtyunHistory(cookie, {
    conversationType: "all",
    page: 0,
    size: 10
  });
  const candidates = getCtyunHistoryContent(historyBody)
    .map((item) => ({
      id: getCtyunConversationId(item),
      raw: item
    }))
    .filter((item) => item.id);

  if (candidates.length === 0) return null;

  const knownTexts = getKnownConversationTexts(openaiBody);
  if (knownTexts.length > 0) {
    for (const candidate of candidates) {
      try {
        const itemsBody = await queryCtyunConversationItems(cookie, {
          conversationId: candidate.id,
          count: 20
        });
        const upstreamTexts = getCtyunHistoryContent(itemsBody)
          .map((item) => String(item?.messageContent || item?.content || "").trim())
          .filter(Boolean);

        if (knownTexts.some((text) => upstreamTexts.includes(text))) {
          return {
            conversationId: candidate.id,
            keyModel,
            source: "history_match"
          };
        }
      } catch {
        // Keep trying newer history entries if one conversation cannot be inspected.
      }
    }
  }

  return {
    conversationId: candidates[0].id,
    keyModel,
    source: "history_latest"
  };
}

function resolveKeyModel(requestedModel, ctyunModels) {
  if (!requestedModel) return "TEXT_DEEPSEEK_V4";

  for (const item of ctyunModels) {
    const modelIds = extractModelIds(item.model);

    if (
      item.keyModel === requestedModel ||
      item.modelName === requestedModel ||
      modelIds.includes(requestedModel)
    ) {
      return item.keyModel;
    }
  }

  return requestedModel.startsWith("TEXT_") ? requestedModel : "TEXT_DEEPSEEK_V4";
}

async function toCtyunRequest(openaiBody, keyModel, cookie, conversationSession = null) {
  const messages = await toCtyunMessages(openaiBody, cookie);
  const conversationId = pickFirstDefined(
    conversationSession?.conversationId,
    openaiBody.ctyun_conversation_id,
    openaiBody.ctyunConversationId,
    openaiBody.conversation_id,
    openaiBody.conversationId
  );
  const messageId = pickFirstDefined(
    openaiBody.ctyun_message_id,
    openaiBody.ctyunMessageId,
    openaiBody.message_id,
    openaiBody.messageId
  );
  const ctyunBody = {
    key_model: keyModel,
    messages,
    stream: true,
    client_retry: true,
    web_search: typeof openaiBody.web_search === "boolean" ? openaiBody.web_search : false,
    tenantId: 15,
    enable_thinking: typeof openaiBody.enable_thinking === "boolean" ? openaiBody.enable_thinking : false,
    action: {},
    tools: []
  };

  if (conversationId) ctyunBody.conversation_id = String(conversationId);
  if (messageId) ctyunBody.message_id = Number.isFinite(Number(messageId)) ? Number(messageId) : messageId;

  return ctyunBody;
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

  const openaiBody = await readJsonBody(req);
  const cookie = getRequestCookie(req);
  const ctyunModels = await queryCtyunModels(cookie);
  const keyModel = resolveKeyModel(openaiBody.model, ctyunModels);
  const conversationKey = getClientConversationKey(req, openaiBody, keyModel);
  const shouldResetConversation =
    openaiBody.reset_conversation || openaiBody.resetConversation || isFreshOpenAIConversationStart(openaiBody);

  if (shouldResetConversation) {
    clearCtyunConversation(conversationKey);
  }

  let conversationSession = readCtyunConversation(conversationKey);
  if (
    !conversationSession &&
    !shouldResetConversation &&
    !openaiBody.conversation_id &&
    !openaiBody.conversationId &&
    !openaiBody.ctyun_conversation_id &&
    !openaiBody.ctyunConversationId
  ) {
    conversationSession = await hydrateCtyunConversationFromHistory(cookie, openaiBody, keyModel);
    if (conversationSession) {
      writeCtyunConversation(conversationKey, conversationSession);
    }
  }
  const ctyunBody = await toCtyunRequest(openaiBody, keyModel, cookie, conversationSession);

  if (!ctyunBody.messages.some((message) => hasUsableContent(message.content) || message.ref?.file?.length > 0)) {
    sendJson(res, 400, {
      error: {
        message: "content is required",
        type: "invalid_request_error"
      }
    });
    return;
  }

  if (ctyunBody.conversation_id || ctyunBody.message_id) {
    writeCtyunConversation(conversationKey, {
      keyModel,
      conversationId: ctyunBody.conversation_id,
      messageId: ctyunBody.message_id
    });
  }

  const requestId = createHash("sha1")
    .update(`${Date.now()}-${JSON.stringify(ctyunBody.messages.map((message) => message.content))}`)
    .digest("hex")
    .slice(0, 16);
  const promptTokens = ctyunBody.messages.reduce((total, message) => total + estimatePromptTokens(message), 0);

  const upstream = await fetch(CTYUN_CHAT_URL, {
    method: "POST",
    headers: buildCtyunHeaders(cookie),
    body: JSON.stringify(ctyunBody)
  });

  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*"
  });

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  let completionText = "";
  let upstreamConversation = {};

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkBuffer = Buffer.from(value);
      const chunkText = chunkBuffer.toString("utf8");
      completionText += extractDeltaTextFromSseChunk(chunkText);
      upstreamConversation = {
        ...upstreamConversation,
        ...extractCtyunConversationFromSseChunk(chunkText)
      };
      res.write(chunkBuffer);
    }
  } finally {
    if (upstreamConversation.conversationId || upstreamConversation.messageId) {
      writeCtyunConversation(conversationKey, {
        keyModel,
        ...upstreamConversation
      });
    }

    if (upstream.ok) {
      const completionTokens = estimateTokens(completionText);
      appendUsage({
        id: requestId,
        createdAt: new Date().toISOString(),
        model: openaiBody.model || keyModel,
        keyModel,
        promptTokens,
        completionTokens,
        tokens: promptTokens + completionTokens
      });
    }
    res.end();
  }
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

  const ctyunModels = await queryCtyunModels(getRequestCookie(req));

  sendJson(res, 200, toOpenAIModels(ctyunModels));
}

async function handleConversations(req, res, url) {
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

  const ctyunBody = await queryCtyunHistory(getRequestCookie(req), {
    conversationType: url.searchParams.get("conversation_type") || "all",
    page: url.searchParams.get("page") || 0,
    size: url.searchParams.get("limit") || url.searchParams.get("size") || 10
  });

  sendJson(res, 200, toOpenAIConversationList(ctyunBody));
}

async function handleConversationItems(req, res, conversationId, url) {
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

  if (!conversationId) {
    sendJson(res, 400, {
      error: {
        message: "conversation_id is required",
        type: "invalid_request_error"
      }
    });
    return;
  }

  const ctyunBody = await queryCtyunConversationItems(getRequestCookie(req), {
    conversationId,
    count: url.searchParams.get("limit") || url.searchParams.get("count") || 20
  });

  sendJson(res, 200, toOpenAIConversationItems(ctyunBody));
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
    { ok: true },
    {
      "set-cookie": clearSessionCookie()
    }
  );
}

async function handleCurrentUser(req, res) {
  const user = requireAdminAuth(req, res);
  if (!user) return;

  sendJson(res, 200, {
    user
  });
}

async function handleChangePassword(req, res) {
  const sessionUser = requireAdminAuth(req, res);
  if (!sessionUser) return;

  const body = await readJsonBody(req);
  const currentPassword = String(body.currentPassword || "");
  const nextPassword = String(body.nextPassword || "");
  const user = readUserConfig();

  if (!currentPassword || !nextPassword) {
    sendJson(res, 400, {
      error: {
        message: "当前密码和新密码不能为空",
        type: "invalid_request_error"
      }
    });
    return;
  }

  if (!verifyPassword(user, currentPassword)) {
    sendJson(res, 400, {
      error: {
        message: "当前密码错误",
        type: "invalid_request_error"
      }
    });
    return;
  }

  const nextUser = writeUserConfig({
    ...user,
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

async function handleDashboard(req, res) {
  const cookie = getRequestCookie(req);
  const config = readConfig();
  let account = getAccountInfo(cookie);
  let models = [];
  let modelsError = "";
  let accountError = "";

  const [userInfoResult, modelsResult] = await Promise.allSettled([
    queryCtyunUserInfo(cookie),
    queryCtyunModels(cookie)
  ]);

  if (userInfoResult.status === "fulfilled") {
    account = {
      ...account,
      ...userInfoResult.value
    };
  } else {
    accountError = userInfoResult.reason?.message || "账号信息获取失败";
  }

  if (modelsResult.status === "fulfilled") {
    models = toOpenAIModels(modelsResult.value).data;
  } else {
    modelsError = modelsResult.reason?.message || "模型列表获取失败";
  }

  sendJson(res, 200, {
    account: {
      ...account,
      accountError
    },
    service: {
      enabled: config.serviceEnabled,
      autoStart: config.autoStart,
      listenPort: config.listenPort
    },
    models,
    modelsError,
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
    hasCookie: Boolean(config.cookie),
    cookiePreview: getMaskedTokenPreview(config.cookie),
    updatedAt: config.updatedAt,
    serviceEnabled: config.serviceEnabled,
    autoStart: config.autoStart,
    listenPort: config.listenPort,
    token,
    baseUrl: urls.baseUrl,
    chatCompletionsUrl: urls.chatCompletionsUrl
  });
}

async function handlePostConfig(req, res) {
  const body = await readJsonBody(req);
  const current = readConfig();
  const cookie = typeof body.cookie === "string" ? normalizeCookie(body.cookie) : current.cookie;

  if (typeof body.cookie === "string" && !cookie) {
    sendJson(res, 400, {
      error: {
        message: "cookie is required",
        type: "invalid_request_error"
      }
    });
    return;
  }

  const config = writeConfig({
    cookie,
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
    hasCookie: Boolean(config.cookie),
    cookiePreview: getMaskedTokenPreview(config.cookie),
    updatedAt: config.updatedAt,
    serviceEnabled: config.serviceEnabled,
    autoStart: config.autoStart,
    listenPort: config.listenPort,
    portChanged,
    token: config.apiKey,
    baseUrl: urls.baseUrl,
    chatCompletionsUrl: urls.chatCompletionsUrl
  });
}

async function fetchRemoteVersionInfo() {
  const response = await fetch(VERSION_URL, {
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

  sendJson(res, 200, {
    currentVersion: localInfo.version,
    latestVersion: remoteInfo.version,
    changelog: remoteInfo.changelog || "",
    updateAvailable: compareResult < 0,
    status: readUpdateStatus()
  });
}

async function handleUpdateStatus(_req, res) {
  sendJson(res, 200, readUpdateStatus());
}

async function handleUpdateApply(_req, res) {
  const status = readUpdateStatus();
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

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
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

    sendJson(res, 500, {
      error: {
        message: error.message || "Internal server error",
        type: "server_error"
      }
    });
  }
});

ensureDataFiles();
currentListenPort = readConfig().listenPort;

server.listen(currentListenPort, LISTEN_HOST, () => {
  console.log(`CT API proxy listening on http://${LISTEN_HOST}:${currentListenPort}`);
});
