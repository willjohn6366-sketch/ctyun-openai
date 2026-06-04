// 真流式代理：直接转发 SSE，不等完整响应
export async function streamCtyunToOpenAI(upstream, res, { requestId, model }) {
  if (!upstream.body) {
    throw new Error("No upstream body");
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const created = Math.floor(Date.now() / 1000);
  let conversation = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });

    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const payload = JSON.parse(data);

        // 提取 conversation 字段
        if (payload.conversation_id || payload.conversationId) {
          conversation.conversationId = payload.conversation_id || payload.conversationId;
        }
        if (payload.message_id || payload.messageId) {
          conversation.messageId = payload.message_id || payload.messageId;
        }

        // 转换为 OpenAI 格式并立即发送
        const openaiChunk = {
          id: `chatcmpl_${requestId}`,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: null
          }]
        };

        const choice = payload?.choices?.[0];
        if (choice?.delta) {
          if (choice.delta.role) openaiChunk.choices[0].delta.role = choice.delta.role;
          if (choice.delta.content) openaiChunk.choices[0].delta.content = choice.delta.content;
          if (choice.delta.tool_calls) {
            openaiChunk.choices[0].delta.tool_calls = choice.delta.tool_calls.map((tc, i) => ({
              index: tc.index ?? i,
              id: tc.id,
              type: "function",
              function: {
                name: tc.function?.name || tc.tool_code || tc.display_name || "",
                arguments: typeof tc.function?.arguments === "object"
                  ? JSON.stringify(tc.function.arguments)
                  : (tc.function?.arguments ?? "")
              }
            }));
          }
        }
        if (choice?.finish_reason) openaiChunk.choices[0].finish_reason = choice.finish_reason;

        res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
      } catch {
        // 忽略非 JSON 行
      }
    }
  }

  res.write("data: [DONE]\n\n");
  return conversation;
}
