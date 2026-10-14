#!/usr/bin/env node
/**
 * cursor-agent-protocol-poc — B 路线最小 PoC：
 * 不启动 cursor-agent 进程，直接实现 AgentService 协议客户端。
 *
 * 已逆向协议（v2026.10.01-e373342, src/client.ts 传输桥）：
 *   下行: POST /agent.v1.AgentService/RunSSE   (Connect ServerStreaming, JSON)
 *         请求 {requestId: <uuid>}
 *         响应 SSE 流: AgentServerMessage JSON（envelope: data: {...}）
 *   上行: POST /aiserver.v1.BidiService/BidiAppend  (Connect Unary, JSON)
 *         {requestId, appendSeqno: "<n>", data: "<hex of AgentClientMessage binary>"}
 *         （或 dataBinary base64 —— CLI 默认 binaryEncoding=true 用 dataBinary）
 *   消息: AgentClientMessage{runRequest: AgentRunRequest}
 *         AgentRunRequest{conversationState, action: {userMessageAction: {...}}}
 *         ConversationState{rootPromptMessagesJson: [json strings], turns: []}
 *         UserMessageAction{userMessage: {text, mode: ASK}}
 *
 * 本 PoC 目标：验证「非 CLI 客户端」能否直接建立 agent loop 并触发 web search。
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const API_BASE = process.env.CURSOR_API_ENDPOINT || "https://api2.cursor.sh";
const STATE_DIR = path.join(os.homedir(), ".cursor-search-mcp");
const KEY_FILE = path.join(STATE_DIR, "key");
const CLIENT_VERSION = "cli-2026.10.01-e373342";

function readApiKey() {
  if (process.env.CURSOR_API_KEY) return process.env.CURSOR_API_KEY.trim();
  try { return fs.readFileSync(KEY_FILE, "utf8").trim() || null; } catch { return null; }
}

function readToken() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "auth.json"), "utf8"));
    return d.accessToken;
  } catch { return null; }
}

async function ensureToken() {
  const cached = readToken();
  if (cached) {
    try {
      const p = JSON.parse(Buffer.from(cached.split(".")[1], "base64url").toString());
      if (p.exp * 1000 > Date.now() + 60_000) return cached;
    } catch {}
  }
  const key = readApiKey();
  if (!key) throw new Error("no api key");
  const r = await fetch(`${API_BASE}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: "{}",
  });
  if (!r.ok) throw new Error(`exchange failed: ${r.status}`);
  const d = await r.json();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, "auth.json"), JSON.stringify(d, null, 1));
  return d.accessToken;
}

/* ---------- 极简 protobuf writer（只写我们需要的消息） ----------
 * 累加式设计：方法把编码 push 进 this.buf 并返回 this（可链式），
 * 最后 .bytes() 取出。避免「每次调用返回新数组、赋值覆盖丢字段」的错误。
 */
class Pb {
  constructor() { this.buf = []; }
  varint(n) {
    n = BigInt(n);
    const out = [];
    do { let b = Number(n & 0x7fn); n >>= 7n; if (n > 0n) b |= 0x80; out.push(b); } while (n > 0n);
    return out;
  }
  tag(field, wire) { return this.varint(BigInt(field) << 3n | BigInt(wire)); }
  str(field, s) { // string field
    const bytes = [...Buffer.from(s, "utf8")];
    this.buf.push(...this.tag(field, 2), ...this.varint(bytes.length), ...bytes);
    return this;
  }
  msg(field, sub) { // nested message (sub: number[])
    this.buf.push(...this.tag(field, 2), ...this.varint(sub.length), ...sub);
    return this;
  }
  boolF(field, v) { this.buf.push(...this.tag(field, 0), ...(v ? [1] : [0])); return this; }
  bytes() { return this.buf; }
}

/* 手工构造: AgentClientMessage{run_request: AgentRunRequest{...}}（全部 binary） */
function buildRunRequestBinary({ systemPromptJson, userText } = {}) {
  // UserMessage{1 text}
  const userMsgBytes = new Pb().str(1, userText).bytes();

  // RequestContext{17 web_search_enabled}
  const rcBytes = new Pb().boolF(17, true).bytes();

  // UserMessageAction{1 user_message, 2 request_context}
  const uma = new Pb().msg(1, userMsgBytes).msg(2, rcBytes);

  // ConversationState{1 root_prompt_messages_json repeated string}
  const cs = new Pb();
  if (systemPromptJson) cs.str(1, systemPromptJson);

  // ConversationAction{1 user_message_action}（oneof 容器）
  const caBytes = new Pb().msg(1, uma.bytes()).bytes();

  // AgentRunRequest{1 conversation_state, 2 action}
  const arr = new Pb().msg(1, cs.bytes()).msg(2, caBytes);

  // AgentClientMessage{1 run_request}
  return Buffer.from(new Pb().msg(1, arr.bytes()).bytes());
}

/* ---------- Connect RPC 调用 ---------- */

function headers(token, extra = {}) {
  return {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
    Authorization: `Bearer ${token}`,
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": CLIENT_VERSION,
    "x-ghost-mode": "false",
    "x-request-id": crypto.randomUUID(),
    ...extra,
  };
}

async function bidiAppend(token, requestId, seqno, dataBinary) {
  // BidiAppendRequest.request_id 字段是嵌套 BidiRequestId 消息 {requestId: string}
  // （逆向 CLI: this.bidiClient.bidiAppend({requestId: new $r({requestId: m}), ...})）
  const r = await fetch(`${API_BASE}/aiserver.v1.BidiService/BidiAppend`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      requestId: { requestId },
      appendSeqno: String(seqno),
      dataBinary: Buffer.from(dataBinary).toString("base64"),
    }),
  });
  const text = await r.text();
  return { status: r.status, text };
}

/* RunSSE: ServerStreaming —— Connect streaming 用 enveloped 帧，JSON 模式: 5字节头+JSON */
async function openRunSSE(token, requestId) {
  const res = await fetch(`${API_BASE}/agent.v1.AgentService/RunSSE`, {
    method: "POST",
    headers: {
      ...headers(token),
      Accept: "application/connect+json",
      "Content-Type": "application/connect+json",
    },
    body: JSON.stringify({ requestId }),
  });
  return res; // 流式 body
}

/* 解析 connect streaming enveloped JSON 帧 */
async function* parseConnectStream(res) {
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const nb = new Uint8Array(buf.length + value.length);
    nb.set(buf); nb.set(value, buf.length);
    buf = nb;
    // 帧: 1 byte flags + 4 bytes len (BE) + payload
    while (buf.length >= 5) {
      const flags = buf[0];
      const len = (buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4];
      if (buf.length < 5 + len) break;
      const payload = Buffer.from(buf.slice(5, 5 + len)).toString("utf8");
      buf = buf.slice(5 + len);
      if (flags & 0x02) {
        // EndStreamResponse: {"error": {...}, "metadata": {...}}
        yield { type: "end", payload };
      } else {
        yield { type: "message", payload };
      }
    }
  }
}

/* ---------- PoC 主流程 ---------- */

async function main() {
  const token = await ensureToken();
  const requestId = crypto.randomUUID();
  console.error(`[*] requestId = ${requestId}`);

  // 1. 打开下行流（先挂起，不消费）
  const sse = await openRunSSE(token, requestId);
  console.error(`[*] RunSSE HTTP ${sse.status}`);
  if (sse.status !== 200) {
    console.error("[!] RunSSE 失败:", (await sse.text()).slice(0, 400));
    process.exit(1);
  }

  // 2. 上行第一条 AgentClientMessage（run_request）
  // root_prompt_messages_json: 参考 CLI——序列化的 root 消息数组，每个元素是一条 JSON 字符串。
  const rootMessages = [
    JSON.stringify({ role: "assistant", content: "你是搜索代理，收到「搜索:」开头的消息就调用 web search 并输出要点与来源 URL。" }),
  ];
  const runReq = buildRunRequestBinary({
    systemPromptJson: rootMessages[0],
    userText: "搜索:ripgrep 15.1 release notes",
  });
  console.error(`[*] run_request binary: ${runReq.length} bytes`);

  const appendRes = await bidiAppend(token, requestId, 0, runReq);
  console.error(`[*] BidiAppend #0: HTTP ${appendRes.status} ${appendRes.text.slice(0, 200)}`);
  if (appendRes.status !== 200) process.exit(1);

  // 3. 消费下行流（限时 120s）
  const deadline = Date.now() + 120_000;
  let msgCount = 0;
  for await (const frame of parseConnectStream(sse)) {
    if (Date.now() > deadline) { console.error("[!] 超时"); break; }
    msgCount++;
    const p = frame.payload;
    const preview = p.length > 300 ? p.slice(0, 300) + "..." : p;
    console.error(`[frame ${msgCount}] ${frame.type}: ${preview}\n`);
    if (frame.type === "end") break;
    // 解析 AgentServerMessage: interaction_update/interaction_query/...
    try {
      const m = JSON.parse(p);
      if (m.interactionQuery) {
        console.error("[*] ⚡ 收到 InteractionQuery:", JSON.stringify(m.interactionQuery).slice(0, 400));
        // PoC: 不应答，观察服务端行为（生产实现需回 interaction_response approve）
      }
    } catch {}
  }
  console.error(`[*] 共 ${msgCount} 帧`);
}

if (require.main === module) {
  main().catch((e) => { console.error("[!]", e); process.exit(1); });
}

module.exports = { buildRunRequestBinary, Pb, bidiAppend, openRunSSE, parseConnectStream, ensureToken };
