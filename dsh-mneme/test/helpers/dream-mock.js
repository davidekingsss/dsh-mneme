// test/helpers/dream-mock.js
// 共享的确定性 LLM 测试桩：consolidation 决策生成器 + 最小 DSH ctx。
// 被 scripts/stress-dsh.js 与 test/stress.test.js 共用，保证压测与单测
// 走同一套"LLM 行为"，避免两边决策逻辑漂移。

export function parseEntries(listText) {
  return [...listText.matchAll(
    /id=([^\s|]+)\s*\|\s*type=(\w+)\s*\|\s*importance=(\d+)\s*\|\s*updated=([^\s|]+)\s*\|\s*title=([^|]*)/g
  )].map((m) => ({ id: m[1], type: m[2], importance: Number(m[3]), updated: m[4], title: m[5].trim() }));
}

/**
 * 长会话检索的确定性决策：title 含「变体」→ archive，其余 keep。
 */
export function sessionDecisions(listText) {
  const entries = parseEntries(listText);
  const decisions = [];
  const claimed = new Set();
  for (const e of entries) {
    if (e.title.includes("变体")) {
      decisions.push({ action: "archive", ids: [e.id], reason: "stale variant" });
      claimed.add(e.id);
    }
  }
  for (const e of entries) {
    if (!claimed.has(e.id)) decisions.push({ action: "keep", ids: [e.id] });
  }
  return JSON.stringify(decisions);
}

/**
 * 冲突裁决的确定性决策：title 以「(旧)」结尾 → conflict（胜者为同主题
 * 不带「(旧)」者），无对手 → keep。同一快照必然产出同一决策。
 */
export function arbitrationDecisions(listText) {
  const entries = parseEntries(listText);
  const byKey = new Map();
  for (const e of entries) {
    const key = e.title.replace(/\(旧\)$/, "").trim();
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }
  const decisions = [];
  const claimed = new Set();
  for (const group of byKey.values()) {
    const loser = group.find((e) => e.title.includes("(旧)"));
    const winner = group.find((e) => !e.title.includes("(旧)"));
    if (winner && loser) {
      decisions.push({ action: "conflict", winner: winner.id, loser: loser.id, reason: "新信息覆盖旧信息" });
      claimed.add(winner.id);
      claimed.add(loser.id);
      continue;
    }
    for (const e of group) {
      if (!claimed.has(e.id)) decisions.push({ action: "keep", ids: [e.id] });
      claimed.add(e.id);
    }
  }
  return JSON.stringify(decisions);
}

/**
 * 确定性 usage 数值（固定值便于断言）。已实测的宿主协议是 usage 嵌在
 * chunk.usage 里、字段名 inputTokens/outputTokens（dsh-llm-deepseek 发
 * `{ type:"usage", usage:{ inputTokens, outputTokens, totalTokens? } }`）。
 * 早期桩完全不发 usage chunk，加上断言写成 `total_tokens >= 0` 的恒真式，
 * 使得「审计 token 恒为 0」这个 bug 一路溜过测试。
 */
export const MOCK_USAGE = {
  consolidate: { inputTokens: 1200, outputTokens: 60 },
  summary: { inputTokens: 800, outputTokens: 40 }
};

/**
 * 最小 DSH ctx：consolidation 用 onConsolidation(listText) 产出决策，
 * summary 返回固定文本。每次调用都会发一个 usage chunk（协议同宿主）；
 * 传 usage: null 可关闭（用于断言「没有 usage 时留 0」的语义）。
 */
export function mockCtx({ onConsolidation, summaryText = "记忆库总览：用户偏好中文；关键决策已巩固。", usage } = {}) {
  return {
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "stress-model" }) },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        const isConsolidation = userText.startsWith("id=");
        const text = isConsolidation
          ? (onConsolidation ? onConsolidation(userText) : "[]")
          : summaryText;
        yield { type: "text-delta", index: 0, text };
        const picked = usage === undefined
          ? (isConsolidation ? MOCK_USAGE.consolidate : MOCK_USAGE.summary)
          : (typeof usage === "function" ? usage({ userText, text, isConsolidation }) : usage);
        if (picked) {
          yield {
            type: "usage",
            usage: { ...picked, totalTokens: picked.totalTokens ?? picked.inputTokens + picked.outputTokens }
          };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}
