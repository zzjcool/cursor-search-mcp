#!/usr/bin/env node
/**
 * cursor-agent-protocol — B 路线：纯协议客户端，不启动 cursor-agent 进程。
 *
 * 逆向协议（cursor-agent v2026.10.01-e373342）已全部实测验证：
 *
 *   下行流  POST /agent.v1.AgentService/RunSSE
 *           请求: enveloped(5B 头 + JSON) BidiRequestId{requestId}
 *           响应: application/connect+json enveloped 帧，每帧一个 AgentServerMessage
 *   上行    POST /aiserver.v1.BidiService/BidiAppend
 *           {requestId: {requestId}, appendSeqno: "<n>", dataBinary: <b64 AgentClientMessage>}
 *
 *   消息流:
 *     → AgentClientMessage{1 run_request: AgentRunRequest{conversation_state,
 *         action{user_message_action{user_message, request_context{web_search_enabled}}},
 *         model_details{model_id}}}
 *     ← kvServerMessage{getBlobArgs{blobId}}        → KvClientMessage{id, get_blob_result{blob_data}}
 *     ← kvServerMessage{setBlobArgs}                (记录即可)
 *     ← interactionUpdate{textDelta/partialToolCall/toolCallCompleted/turnEnded}
 *     ← interactionQuery{webSearchRequestQuery}     → AgentClientMessage{6 interaction_response:
 *                                                       InteractionResponse{id, web_search_request_response:
 *                                                         WebSearchInteraction{approved}}}
 *     ← toolCallCompleted{webSearchToolCall{result{success{references}}}}  ← 搜索结果!
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const API_BASE = process.env.CURSOR_API_ENDPOINT || "https://api2.cursor.sh";
const STATE_DIR = process.env.CURSOR_SEARCH_STATE_DIR || path.join(os.homedir(), ".cursor-search-mcp");
const KEY_FILE = path.join(STATE_DIR, "key");
const TOKEN_FILE = path.join(STATE_DIR, "auth.json");
const CLIENT_VERSION = process.env.CURSOR_CLIENT_VERSION || "cli-2026.10.01-e373342";
const DEFAULT_MODEL = process.env.CURSOR_SEARCH_MODEL || "gpt-5.3-codex-low-fast";

/* ---------------- token ---------------- */

function readApiKey() {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY.trim();
  try { return fs.readFileSync(KEY_FILE, "utf8").trim() || null; } catch { return null; }
}

function tokenExpiresInMs(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (typeof p.exp === "number") return p.exp * 1000 - Date.now();
  } catch {}
  return -1;
}

async function ensureToken() {
  const apiKey = readApiKey();
  if (!apiKey) throw new Error("未配置 Cursor API key（CURSOR_API_KEY 或 ~/.cursor-search-mcp/key）");
  try {
    const d = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    if (d.accessToken && tokenExpiresInMs(d.accessToken) > 60_000) return d.accessToken;
  } catch {}
  const r = await fetch(`${API_BASE}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "x-cursor-client-type": "cli",
      "x-cursor-client-version": CLIENT_VERSION,
    },
    body: "{}",
  });
  if (r.status === 403) throw new Error("API key 无效或无 API 权益（exchange 403）");
  if (!r.ok) throw new Error(`exchange_user_api_key: HTTP ${r.status}`);
  const { accessToken, refreshToken } = await r.json();
  if (!accessToken) throw new Error("exchange 响应缺少 accessToken");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ accessToken, refreshToken, ts: Date.now() }, null, 1), { mode: 0o600 });
  } catch {}
  return accessToken;
}

/* ---------------- 极简 protobuf writer（累加式） ---------------- */

class Pb {
  constructor() { this.buf = []; }
  varint(n) {
    n = BigInt(n);
    const out = [];
    do { let b = Number(n & 0x7fn); n >>= 7n; if (n > 0n) b |= 0x80; out.push(b); } while (n > 0n);
    return out;
  }
  tag(field, wire) { return this.varint((BigInt(field) << 3n) | BigInt(wire)); }
  str(field, s) {
    const bytes = [...Buffer.from(s, "utf8")];
    this.buf.push(...this.tag(field, 2), ...this.varint(bytes.length), ...bytes);
    return this;
  }
  msg(field, sub) { // sub: number[]
    this.buf.push(...this.tag(field, 2), ...this.varint(sub.length), ...sub);
    return this;
  }
  boolF(field, v) { this.buf.push(...this.tag(field, 0), ...(v ? [1] : [0])); return this; }
  uintF(field, v) { this.buf.push(...this.tag(field, 0), ...this.varint(v)); return this; }
  bytes() { return this.buf; }
}

/* ---------------- Connect RPC ---------------- */

function streamHeaders(token) {
  // Connect streaming (RunSSE): connect+json
  return {
    "Content-Type": "application/connect+json",
    "Connect-Protocol-Version": "1",
    Accept: "application/connect+json",
    Authorization: `Bearer ${token}`,
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": CLIENT_VERSION,
    "x-ghost-mode": "false",
    "x-request-id": crypto.randomUUID(),
  };
}

function unaryHeaders(token) {
  // Connect unary (BidiAppend): application/json
  return {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
    Authorization: `Bearer ${token}`,
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": CLIENT_VERSION,
    "x-ghost-mode": "false",
    "x-request-id": crypto.randomUUID(),
  };
}

function enveloped(obj) {
  const body = JSON.stringify(obj);
  const frame = Buffer.alloc(5 + body.length);
  frame[0] = 0;
  frame.writeUInt32BE(body.length, 1);
  frame.write(body, 5);
  return frame;
}

async function bidiAppend(token, requestId, seqno, dataBinary) {
  const r = await fetch(`${API_BASE}/aiserver.v1.BidiService/BidiAppend`, {
    method: "POST",
    headers: unaryHeaders(token),
    body: JSON.stringify({
      requestId: { requestId },
      appendSeqno: String(seqno),
      dataBinary: Buffer.from(dataBinary).toString("base64"),
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`BidiAppend #${seqno} 失败: HTTP ${r.status} ${t.slice(0, 200)}`);
  }
  await r.text();
}

/* ---------------- 消息构造 ---------------- */

function buildRunRequest({ systemPrompt, userText, model }) {
  // UserMessage{1 text}
  const userMsg = new Pb().str(1, userText).bytes();
  // RequestContext{17 web_search_enabled}
  const rc = new Pb().boolF(17, true).bytes();
  // UserMessageAction{1 user_message, 2 request_context}
  const uma = new Pb().msg(1, userMsg).msg(2, rc);
  // ConversationAction{1 user_message_action}
  const ca = new Pb().msg(1, uma.bytes()).bytes();
  // ConversationState{1 root_prompt_messages_json (repeated string)}
  const cs = new Pb();
  if (systemPrompt) cs.str(1, systemPrompt);
  // ModelDetails{1 model_id}
  const md = new Pb().str(1, model || DEFAULT_MODEL).bytes();
  // AgentRunRequest{1 conversation_state, 2 action, 3 model_details}
  const arr = new Pb().msg(1, cs.bytes()).msg(2, ca).msg(3, md);
  // AgentClientMessage{1 run_request}
  return Buffer.from(new Pb().msg(1, arr.bytes()).bytes());
}

function buildWebSearchApproved(queryId) {
  // WebSearchInteraction{1 approved}（oneof result，approved 为空消息）
  const wsi = new Pb().msg(1, []).bytes();
  // InteractionResponse{1 id, 2 web_search_request_response}
  const ir = new Pb().uintF(1, queryId).msg(2, wsi);
  // AgentClientMessage{6 interaction_response}
  return Buffer.from(new Pb().msg(6, ir.bytes()).bytes());
}

function buildGetBlobResult(kvId, data) {
  // GetBlobResult{1 blob_data}
  const gbr = new Pb().msg(1, [...Buffer.from(data)]).bytes();
  // KvClientMessage{1 id, 2 get_blob_result}
  const kcm = new Pb().uintF(1, kvId).msg(2, gbr);
  // AgentClientMessage{3 kv_client_message}
  return Buffer.from(new Pb().msg(3, kcm.bytes()).bytes());
}

/* ---------------- 核心：一次完整搜索会话 ---------------- */

/**
 * 纯协议执行一次「固定上下文 + web search」。
 * 每次调用都是独立 requestId 的全新会话 —— 上下文完全由我们构造（B 路线的天然优势）。
 */
async function runSearch(searchTerm, { model, systemPrompt, timeoutMs = 120_000, onEvent } = {}) {
  const token = await ensureToken();
  const requestId = crypto.randomUUID();
  const sys = systemPrompt ||
    JSON.stringify({
      role: "assistant",
      content:
        "你是搜索代理。收到「搜索:」开头的消息后，调用 web search 工具联网搜索，" +
        "输出: 1) 事实要点列表(每条附来源URL) 2) 全部来源 URL 清单。不做任何文件或 shell 操作。",
    });

  // 1. 打开下行流
  const sse = await fetch(`${API_BASE}/agent.v1.AgentService/RunSSE`, {
    method: "POST",
    headers: streamHeaders(token),
    body: enveloped({ requestId }),
  });
  if (sse.status !== 200) {
    const t = await sse.text().catch(() => "");
    throw new Error(`RunSSE 失败: HTTP ${sse.status} ${t.slice(0, 300)}`);
  }

  // 2. 发送 run_request
  let seq = 0;
  await bidiAppend(token, requestId, seq++, buildRunRequest({ systemPrompt: sys, userText: `搜索:${searchTerm}`, model }));

  // 2.5 客户端心跳：CLI 每 5s 发一个空 ClientHeartbeat（AgentClientMessage field 7）
  // 保活 agent loop —— 不发的话服务端在工具调用后认为客户端已死，不再继续生成。
  const heartbeatTimer = setInterval(() => {
    // AgentClientMessage{7 client_heartbeat: ClientHeartbeat{}}
    const hb = Buffer.from(new Pb().msg(7, []).bytes());
    bidiAppend(token, requestId, seq++, hb).catch(() => {});
  }, 5000);

  // 3. 消费下行流
  const reader = sse.body.getReader();
  let buf = Buffer.alloc(0);
  let text = "";                 // 拼接的模型输出
  const references = [];         // web search 引用
  const blobs = new Map();       // blobId(b64) → content，应答 getBlob
  blobs.set(Buffer.from(sys).toString("base64"), sys);
  const deadline = Date.now() + timeoutMs;
  let turnEnded = false;
  let serverError = null;

  readLoop: while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: true, timeout: true }), Math.max(1000, deadline - Date.now()))),
    ]);
    if (done) break;

    buf = Buffer.concat([buf, Buffer.from(value)]);
    while (buf.length >= 5) {
      const flags = buf[0];
      const len = buf.readUInt32BE(1);
      if (buf.length < 5 + len) break;
      const payload = buf.slice(5, 5 + len).toString("utf8");
      buf = buf.slice(5 + len);
      const isEnd = (flags & 0x02) !== 0;
      if (isEnd) {
        try {
          const e = JSON.parse(payload);
          if (e.error) serverError = `${e.error.code}: ${e.error.message}`;
        } catch {}
        break readLoop;
      }
      let m;
      try { m = JSON.parse(payload); } catch { continue; }

      // KV blob 请求
      const kv = m.kvServerMessage;
      if (kv?.getBlobArgs) {
        const id = kv.id ?? 0;
        const blobId = kv.getBlobArgs.blobId;
        const content = blobs.get(blobId) ?? Buffer.from(blobId, "base64").toString("utf8");
        await bidiAppend(token, requestId, seq++, buildGetBlobResult(id, content));
        continue;
      }
      if (kv?.setBlobArgs) {
        blobs.set(kv.setBlobArgs.blobId, Buffer.from(kv.setBlobArgs.blobData ?? "", "base64").toString("utf8"));
        // ★ 关键：回 ACK（空 SetBlobResult）。逆向 CLI 抓包证实：
        // 服务端等这个应答才继续 agent loop，不回则卡在工具调用后。
        // KvClientMessage{1 id, 3 set_blob_result: SetBlobResult{}}
        const ack = new Pb().uintF(1, kv.id ?? 0).msg(3, []);
        await bidiAppend(token, requestId, seq++, Buffer.from(new Pb().msg(3, ack.bytes()).bytes()));
        continue;
      }

      // 搜索批准交互 → 自动批准
      if (m.interactionQuery) {
        const q = m.interactionQuery;
        const qid = q.id ?? 0;
        if (q.webSearchRequestQuery) {
          await bidiAppend(token, requestId, seq++, buildWebSearchApproved(qid));
          onEvent?.("web-search-approved", q.webSearchRequestQuery);
        } else if (q.webFetchRequestQuery) {
          // web fetch 也自动批准（搜索代理可能抓网页正文）
          // WebFetchInteraction 结构同 search: {1 approved}
          const wfi = new Pb().msg(1, []).bytes();
          const ir = new Pb().uintF(1, qid).msg(3, wfi); // InteractionResponse{3 web_fetch_request_response}
          await bidiAppend(token, requestId, seq++, Buffer.from(new Pb().msg(6, ir.bytes()).bytes()));
          onEvent?.("web-fetch-approved", q.webFetchRequestQuery);
        } else {
          onEvent?.("unhandled-query", Object.keys(q));
        }
        continue;
      }

      // 模型输出
      const upd = m.interactionUpdate;
      if (upd) {
        if (upd.textDelta?.text) text += upd.textDelta.text;
        if (upd.toolCallCompleted?.toolCall?.webSearchToolCall) {
          const r = upd.toolCallCompleted.toolCall.webSearchToolCall.result;
          if (r?.success?.references) {
            for (const ref of r.success.references) {
              // WebSearchReference 只有 title + chunk；链接在 chunk 文本里（Links: 1. [x](url) ...）
              const chunk = ref.chunk || "";
              const urls = [...chunk.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)].map(
                (mm) => ({ title: mm[1], url: mm[2] })
              );
              references.push({
                title: ref.title,
                urls,
                chunk: chunk.slice(0, 2000),
              });
            }
            onEvent?.("search-results", references.length);
          }
          if (r?.error) serverError = `web search error: ${r.error.error}`;
        }
        if (upd.turnEnded) { turnEnded = true; break readLoop; }
      }
    }
  }
  reader.cancel().catch(() => {});
  clearInterval(heartbeatTimer);

  if (serverError) throw new Error(serverError);
  if (!turnEnded && !text) throw new Error(`会话超时或异常结束（${timeoutMs}ms 内无输出）`);

  return {
    answer: text.trim(),
    references,
    session: { requestId, model: model || DEFAULT_MODEL },
  };
}

/* ---------------- CLI 自测 ---------------- */

if (require.main === module) {
  const q = process.argv[2] || "ripgrep 15.1 release notes";
  console.error(`[agent-protocol] 搜索: ${q}`);
  runSearch(q, {
    onEvent: (kind, detail) =>
      console.error(`[event] ${kind}${typeof detail === "number" ? ` (${detail} refs)` : ""}`),
  })
    .then((r) => {
      console.error("\n=== 答案 ===");
      console.error(r.answer);
      console.error("\n=== 引用 ===");
      for (const ref of r.references) {
        console.error(`- ${ref.title} (${ref.urls.length} links)`);
        for (const u of ref.urls) console.error(`    • ${u.title} → ${u.url}`);
      }
      process.exit(0);
    })
    .catch((e) => {
      console.error("[!]", e.message);
      process.exit(1);
    });
}

/* ---------------- OAuth 登录（PKCE 设备码流程，逆向 CLI login 命令） ---------------- */

/**
 * 发起 OAuth 登录。返回 loginUrl 供用户在浏览器完成授权；
 * 轮询状态存内存（模块级），等待窗口内 pollUntilDone 拿结果。
 */
const oauthPending = new Map(); // uuid → {verifier, startedAt}

function startOAuthLogin() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const uuid = crypto.randomUUID();
  const loginUrl =
    `https://cursor.com/loginDeepControl?challenge=${encodeURIComponent(challenge)}` +
    `&uuid=${uuid}&mode=login&redirectTarget=cli`;
  oauthPending.set(uuid, { verifier, startedAt: Date.now() });
  // 15 分钟过期
  setTimeout(() => oauthPending.delete(uuid), 15 * 60_000).unref?.();
  return { uuid, loginUrl, expiresInMin: 15 };
}

/** 轮询直到用户授权完成。timeoutMs 默认 5 分钟。 */
async function pollOAuthLogin(uuid, { timeoutMs = 300_000 } = {}) {
  const pending = oauthPending.get(uuid);
  if (!pending) throw new Error("未找到该 uuid 的登录会话（可能已过期或未发起）");
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const r = await fetch(
        `${API_BASE}/auth/poll?uuid=${uuid}&verifier=${encodeURIComponent(pending.verifier)}`,
        { headers: { "Content-Type": "application/json", "x-cursor-client-type": "cli", "x-cursor-client-version": CLIENT_VERSION } }
      );
      if (r.status === 404) {
        // 用户还没授权，退避重试（与 CLI 一致: 1s 起 ×1.2，封顶 10s）
        const delay = Math.min(1000 * 1.2 ** attempt, 10_000);
        await new Promise((res) => setTimeout(res, delay));
        continue;
      }
      if (r.status === 403) {
        const t = await r.json().catch(() => ({}));
        throw new Error(`登录被拒绝: ${t.error || r.status}`);
      }
      if (r.ok) {
        const d = await r.json();
        if (d.accessToken && d.refreshToken) {
          oauthPending.delete(uuid);
          // 持久化（与 API key 路径同一份 auth.json）
          try {
            fs.mkdirSync(STATE_DIR, { recursive: true });
            fs.writeFileSync(
              TOKEN_FILE,
              JSON.stringify({ ...d, ts: Date.now(), via: "oauth" }, null, 1),
              { mode: 0o600 }
            );
          } catch {}
          return { ok: true, via: "oauth" };
        }
      }
      // 其他非 2xx：网络抖动类，退避重试
      await new Promise((res) => setTimeout(res, Math.min(1000 * 1.2 ** attempt, 10_000)));
    } catch (e) {
      if (String(e.message).includes("登录被拒绝")) throw e;
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
  throw new Error(`等待授权超时（${Math.round(timeoutMs / 60000)} 分钟）。可重新发起登录。`);
}

module.exports = { runSearch, ensureToken, Pb, API_BASE, DEFAULT_MODEL, streamHeaders, unaryHeaders, enveloped, startOAuthLogin, pollOAuthLogin };
