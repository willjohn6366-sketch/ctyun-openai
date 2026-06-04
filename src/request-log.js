import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(process.cwd(), "data", "logs");
const MAX_ENTRIES = 50;

let entries = [];

export function logRequest({ requestId, openaiBody, ctyunBody, conversationKey, conversationSession, result }) {
  const entry = {
    t: new Date().toISOString(),
    id: requestId,
    model: openaiBody.model,
    keyModel: ctyunBody.key_model,
    msgCount: openaiBody.messages?.length,
    hasTools: !!ctyunBody.tools?.length,
    convKey: conversationKey,
    convId: ctyunBody.conversation_id || null,
    msgId: ctyunBody.message_id || null,
    sessionBefore: conversationSession ? { convId: conversationSession.conversationId, msgId: conversationSession.messageId } : null,
    // 记录发给天翼云的消息摘要（role + content前50字）
    ctyunMessages: (ctyunBody.messages || []).map(m => ({
      role: m.role,
      content: String(m.content || "").slice(0, 80),
      tool_call_id: m.tool_call_id,
      has_tool_calls: !!m.tool_calls?.length
    })),
    result: result || null
  };

  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;

  // 也写文件，方便离线分析
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(
    join(LOG_DIR, "requests.jsonl"),
    JSON.stringify(entry) + "\n"
  );
}

export function getRecentLogs(n = 20) {
  return entries.slice(0, n);
}
