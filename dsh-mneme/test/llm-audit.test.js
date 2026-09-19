import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDreamScheduler } from "../src/dream.js";
import { createSummarizer } from "../src/summarize.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { mockCtx, MOCK_USAGE } from "./helpers/dream-mock.js";

// Bug8: LLM audit trail. Every background LLM call (autoDream consolidation +
// summary, autoSummarize compression) records tokens/time/status into
// llm_audit_logs. Failures are captured as status='error' and never block the
// calling feature. Read back through the API (/llm-audit + /llm-audit/stats).
// Gating: runDream treats llmAudit.enabled === false as off; summarize treats
// llmAudit.enabled !== false as on.

function dreamSetup(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return {
    store,
    service,
    config: { dreamProvider: "deepseek", dreamModel: "deepseek-chat", llmAudit: { enabled: true }, ...over }
  };
}

test("autoDream writes llm_audit_logs rows for consolidation and summary", async () => {
  const { store, service, config } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "旧1", content: "第一段内容" });
  service.saveWithDedupe({ type: "project", title: "旧2", content: "第二段内容" });
  const ctx = mockCtx({
    onConsolidation: (listText) => {
      const ids = [...listText.matchAll(/id=([^\s|]+)\s*\|\s*type=\w+\s*\|\s*importance=\d+/g)].map((m) => m[1]);
      return JSON.stringify(ids.map((id) => ({ action: "keep", ids: [id] })));
    }
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, config);
  assert.equal(result.ok, true);

  const rows = service.listLlmAudits();
  assert.equal(rows.length, 2, "one consolidation + one summary audit row");
  const consolidate = rows.find((r) => r.operation_type === "dream_consolidate");
  const summarize = rows.find((r) => r.operation_type === "dream_summarize");
  assert.ok(consolidate, "dream_consolidate row present");
  assert.ok(summarize, "dream_summarize row present");
  assert.equal(consolidate.trigger_source, "autoDream");
  assert.equal(summarize.trigger_source, "autoDream");
  assert.equal(consolidate.status, "success");
  assert.equal(summarize.status, "success");
  // config-first (Issue #25): dreamSetup sets dreamProvider/dreamModel, so it
  // wins over mockCtx's agentDefaultModel (mock:stress-model) — assert the
  // actually-used config route.
  assert.equal(consolidate.model_id, "deepseek:deepseek-chat");
  assert.equal(summarize.model_id, "deepseek:deepseek-chat");
  assert.ok(Array.isArray(consolidate.related_memory_ids) && consolidate.related_memory_ids.length === 2,
    "consolidation audit records the snapshot ids");
  // token 必须是真数字：宿主把 usage 嵌在 chunk.usage 里，早先读取端从 chunk
  // 根取字段 → 恒为 undefined → 每一行都落 0，而这里曾写 `>= 0` 的恒真断言，
  // 让「面板 LLM 消耗永远显示 0」一路溜过测试。
  assert.equal(consolidate.input_tokens, MOCK_USAGE.consolidate.inputTokens);
  assert.equal(consolidate.output_tokens, MOCK_USAGE.consolidate.outputTokens);
  assert.equal(consolidate.total_tokens, MOCK_USAGE.consolidate.inputTokens + MOCK_USAGE.consolidate.outputTokens);
  assert.equal(summarize.input_tokens, MOCK_USAGE.summary.inputTokens);
  assert.equal(summarize.output_tokens, MOCK_USAGE.summary.outputTokens);
  assert.equal(summarize.total_tokens, MOCK_USAGE.summary.inputTokens + MOCK_USAGE.summary.outputTokens);
  assert.ok(typeof consolidate.duration_ms === "number" && consolidate.duration_ms >= 0);
  store.close();
});

test("autoDream LLM failure is audited as status=error and never blocks the run", async () => {
  const { store, service, config } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "主题", content: "内容" });
  // Consolidation stream finishes with kind "error" → streamText returns
  // undefined → the run fails safe; runAuditedLlm must still leave an
  // error audit row before the failure propagates.
  const ctx = {
    logger: { warn: () => {} },
    llm: {
      async *stream() {
        yield { type: "text-delta", index: 0, text: "" };
        yield { type: "finish", reason: { kind: "error" } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, config);
  assert.equal(result.ok, false, "aborted/errored stream fails the run");
  const rows = service.listLlmAudits();
  assert.equal(rows.length, 1, "failed consolidation still audited");
  assert.equal(rows[0].operation_type, "dream_consolidate");
  assert.equal(rows[0].status, "error");
  assert.ok(rows[0].error_message, "error message recorded");
  // the audit write did not block the failure path
  assert.equal(result.error, "llm failed");
  store.close();
});

test("autoDream throwing LLM is audited as status=error", async () => {
  const { store, service, config } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "主题", content: "内容" });
  const ctx = {
    logger: { warn: () => {} },
    llm: {
      async *stream() {
        throw new Error("network down");
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, config);
  assert.equal(result.ok, false);
  const rows = service.listLlmAudits();
  assert.equal(rows.length, 1, "throwing call still audited");
  assert.equal(rows[0].status, "error");
  assert.match(rows[0].error_message, /network down/);
  store.close();
});

test("autoDream parse failure is audited as status=error, not fake success", async () => {
  const { store, service, config } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "主题", content: "内容" });
  // Stream completes fine but returns no JSON array — the run fails, and the
  // audit must NOT claim success (the old bug: llm_audit said dream_consolidate
  // success while the run recorded failed).
  const warnings = [];
  const ctx = {
    logger: { warn: (m) => warnings.push(m) },
    llm: {
      async *stream() {
        yield { type: "text-delta", index: 0, text: "抱歉，我无法解析成 JSON。" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, config);
  assert.equal(result.ok, false);
  assert.equal(result.error, "no json array in llm output");
  const rows = service.listLlmAudits();
  assert.equal(rows.length, 1, "failed consolidation still audited");
  assert.equal(rows[0].operation_type, "dream_consolidate");
  assert.equal(rows[0].status, "error", "stream succeeded but output unusable → audit error");
  assert.match(rows[0].error_message, /no json array in llm output/);
  assert.ok(warnings.some((m) => m.includes("head: 抱歉，我无法解析成")), "raw output head logged for diagnosis");
  store.close();
});

test("autoDream audit is skipped when llmAudit.enabled === false", async () => {
  const { store, service, config } = dreamSetup({ llmAudit: { enabled: false } });
  service.saveWithDedupe({ type: "project", title: "主题", content: "内容" });
  const ctx = mockCtx();
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  await dream.runDream(ctx, service, config);
  assert.equal(service.listLlmAudits().length, 0, "no audit rows when disabled");
  store.close();
});

test("autoSummarize writes an llm_audit_logs row (trigger_source autoSummarize)", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const events = [];
  const ctx = {
    on(name, fn) {
      events.push({ name, fn });
      return () => {};
    },
    logger: { warn: () => {} },
    llm: {
      async *stream() {
        yield { type: "text-delta", index: 0, text: JSON.stringify([
          { type: "decision", title: "选型", content: "确定用 node:sqlite", importance: 4 }
        ]) };
        // 宿主协议形状：token 嵌在 chunk.usage（summarize.js 读取端的回归锁）
        yield { type: "usage", usage: { inputTokens: 11, outputTokens: 4 } };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const config = {
    autoSummarize: true,
    summarizeProvider: "deepseek",
    summarizeModel: "deepseek-chat",
    llmAudit: { enabled: true }
  };
  createSummarizer(ctx, service, config);
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s1",
    requestHeader: () => ({ config: {} }),
    events: [
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "帮我选型" }] } },
      { seq: 2, type: "turn/end" }
    ]
  };
  await handler(session, { seq: 2, type: "turn/end" });
  const rows = service.listLlmAudits();
  assert.equal(rows.length, 1, "one autoSummarize audit row");
  assert.equal(rows[0].trigger_source, "autoSummarize");
  assert.equal(rows[0].operation_type, "summarize_compress");
  assert.equal(rows[0].model_id, "deepseek:deepseek-chat");
  assert.equal(rows[0].status, "success");
  // autoSummarize 走的是 summarize.js 里另一处 usage 读取端——同一 bug 的第二现场
  assert.equal(rows[0].input_tokens, 11, "usage 嵌在 chunk.usage，从 chunk 根读会恒为 0");
  assert.equal(rows[0].output_tokens, 4);
  assert.equal(rows[0].total_tokens, 15);
  store.close();
});

// --- API surface ------------------------------------------------------------

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function req(path) {
  const r = new EventEmitter();
  r.url = path;
  r.method = "GET";
  r.headers = {};
  return r;
}

function apiSetup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    }
  };
  createApi(ctx, service, settings, { add: () => {}, remove: () => false, list: () => [] });
  return { store, service, routes };
}

test("GET /api/dsh-mneme/semantic/llm-audit paginates and filters by source", async () => {
  const { store, service, routes } = apiSetup();
  for (let i = 0; i < 3; i++) {
    service.saveLlmAudit({
      trigger_source: "autoDream",
      operation_type: "dream_consolidate",
      model_id: "deepseek:deepseek-chat",
      input_tokens: 10, output_tokens: 5, status: "success"
    });
  }
  service.saveLlmAudit({
    trigger_source: "autoSummarize",
    operation_type: "summarize_compress",
    model_id: "deepseek:deepseek-chat",
    input_tokens: 3, output_tokens: 1, status: "success"
  });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/semantic/llm-audit");

  // full page
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/llm-audit?page=1&pageSize=2"), res);
  let data = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(data.total, 4);
  assert.equal(data.page, 1);
  assert.equal(data.pageSize, 2);
  assert.equal(data.items.length, 2);

  // second page
  res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/llm-audit?page=2&pageSize=2"), res);
  data = JSON.parse(res.body);
  assert.equal(data.items.length, 2, "page 2 has the remaining rows");
  assert.equal(data.total, 4);

  // source filter
  res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/llm-audit?source=autoSummarize"), res);
  data = JSON.parse(res.body);
  assert.equal(data.total, 1);
  assert.equal(data.items[0].trigger_source, "autoSummarize");
  store.close();
});

test("GET /api/dsh-mneme/semantic/llm-audit/stats aggregates by source and status", async () => {
  const { store, service, routes } = apiSetup();
  service.saveLlmAudit({
    timestamp: new Date().toISOString(),
    trigger_source: "autoDream", operation_type: "dream_consolidate",
    model_id: "m", input_tokens: 100, output_tokens: 40, duration_ms: 25, status: "success"
  });
  service.saveLlmAudit({
    timestamp: new Date().toISOString(),
    trigger_source: "autoDream", operation_type: "dream_summarize",
    model_id: "m", input_tokens: 30, output_tokens: 10, duration_ms: 8, status: "success"
  });
  service.saveLlmAudit({
    timestamp: new Date().toISOString(),
    trigger_source: "autoSummarize", operation_type: "summarize_compress",
    model_id: "m", input_tokens: 5, output_tokens: 2, duration_ms: 4, status: "error"
  });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/semantic/llm-audit/stats");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/llm-audit/stats?days=7"), res);
  const stats = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(stats.days, 7);
  assert.equal(stats.total_calls, 3);
  assert.equal(stats.input_tokens, 135);
  assert.equal(stats.output_tokens, 52);
  assert.equal(stats.total_tokens, 187);
  assert.equal(stats.total_duration_ms, 37);
  const bySource = stats.by_source.find((s) => s.source === "autoDream");
  assert.equal(bySource.c, 2);
  assert.equal(bySource.total_tokens, 180);
  const errStatus = stats.by_status.find((s) => s.status === "error");
  assert.equal(errStatus.c, 1);
  store.close();
});

// --- token 捕获的边界语义（「LLM 消耗恒为 0」的回归面）-----------------------

test("usage chunk 缺失时 token 留 0：未知不是错误，也不该崩", async () => {
  const { store, service, config } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "旧1", content: "内容一" });
  const ctx = mockCtx({ usage: null, onConsolidation: () => "[]" });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  await dream.runDream(ctx, service, config);
  const rows = service.listLlmAudits();
  assert.ok(rows.length >= 1, "至少写下巩固那一行");
  for (const row of rows) {
    assert.equal(row.input_tokens, 0);
    assert.equal(row.output_tokens, 0);
    assert.equal(row.total_tokens, 0);
  }
  store.close();
});

test("根级 usage 数字仍被兼容（协议演进回退路径）", async () => {
  const { store, service, config } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "旧1", content: "内容一" });
  // 手写 ctx：数字直接挂在 chunk 根（没有嵌套 usage 对象）——保留这条回退是为了
  // 不让测试桩或协议演进把审计打断，注意它命中的是 snake_case 那组别名。
  const ctx = {
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "stress-model" }) },
    llm: {
      async *stream() {
        yield { type: "text-delta", index: 0, text: "[]" };
        yield { type: "usage", input_tokens: 9, output_tokens: 3 };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  await dream.runDream(ctx, service, config);
  const rows = service.listLlmAudits();
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].input_tokens, 9);
  assert.equal(rows[0].output_tokens, 3);
  store.close();
});
