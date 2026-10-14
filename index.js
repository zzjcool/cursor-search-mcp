#!/usr/bin/env node
/**
 * cursor-search-mcp v1.0 — B 路线：纯协议 MCP server。
 *
 * 不再启动 cursor-agent 进程。直接实现 Cursor AgentService 协议（见 agent-protocol.js）：
 *   - 登录: API key → exchange_user_api_key → accessToken（缓存 + 自动续期）
 *   - 搜索: RunSSE + BidiAppend 纯 HTTP 协议客户端，自动批准 web search 交互
 *
 * 工具:
 *   cursor_login      — 校验 key / 报告 token 状态
 *   cursor_web_search — 联网搜索（Cursor 服务端 web search，纯协议直连）
 *
 * 依赖: 仅 Node.js ≥ 18（零 npm 依赖）
 */
"use strict";

const path = require("node:path");
const os = require("node:os");
const { runSearch, ensureToken, API_BASE, DEFAULT_MODEL, startOAuthLogin, pollOAuthLogin } = require("./agent-protocol.js");

const STATE_DIR = path.join(os.homedir(), ".cursor-search-mcp");

/* ---------------- 工具实现 ---------------- */

async function toolLogin() {
  const { fresh } = await ensureToken();
  return {
    ok: true,
    mode: "protocol-direct（纯协议直连，无 cursor-agent 进程）",
    fresh_login: fresh,
    api_base: API_BASE,
    model: DEFAULT_MODEL,
    note: `token 缓存于 ${STATE_DIR}/auth.json，过期自动重新 exchange`,
  };
}

async function toolSearch(searchTerm, { maxResults } = {}) {
  if (!searchTerm || typeof searchTerm !== "string") throw new Error("searchTerm 不能为空");
  const r = await runSearch(searchTerm);
  const n = maxResults || 5;
  // 汇总所有引用的链接（去重）
  const seen = new Set();
  const links = [];
  for (const ref of r.references) {
    for (const u of ref.urls) {
      if (!seen.has(u.url)) {
        seen.add(u.url);
        links.push(u);
      }
    }
  }
  return {
    answer: r.answer,
    links: links.slice(0, n * 3),
    link_count: links.length,
    mode: "protocol-direct",
  };
}

/* ---------------- MCP stdio 协议 ---------------- */

const TOOLS = [
  {
    name: "cursor_login",
    description:
      "校验 Cursor API key 并报告登录/token 状态。key 经 CURSOR_API_KEY 环境变量或 ~/.cursor-search-mcp/key 配置。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cursor_oauth_login",
    description:
      "OAuth 浏览器授权登录（无需 API key）。返回 loginUrl 后需用户在浏览器完成授权；授权后自动轮询换 token 并缓存。" +
      "适用于无 API 权益的账号。步骤: 1) 调用本工具拿 loginUrl 2) 用户打开 URL 登录 3) 调 cursor_oauth_wait 等待完成。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cursor_oauth_wait",
    description:
      "等待用户完成 OAuth 浏览器授权并换取 token。在 cursor_oauth_login 返回 loginUrl 并让用户打开后调用。",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "cursor_oauth_login 返回的 uuid" },
        timeoutMs: { type: "number", description: "等待时长毫秒（默认 300000 = 5 分钟）" },
      },
      required: ["uuid"],
      additionalProperties: false,
    },
  },
  {
    name: "cursor_web_search",
    description:
      "联网搜索（Cursor 服务端 web search，纯协议直连）。返回模型归纳的答案与来源链接列表。适合查最新资料、文档、版本变更。",
    inputSchema: {
      type: "object",
      properties: {
        searchTerm: { type: "string", description: "搜索词/问题" },
        maxResults: { type: "number", description: "来源链接上限（默认 15）" },
      },
      required: ["searchTerm"],
      additionalProperties: false,
    },
  },
];

function rpcSend(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// 协议会话串行（服务端按 requestId 隔离，但避免并发轰炸）
let chain = Promise.resolve();

async function handleCall(name, args) {
  if (name === "cursor_login") return await toolLogin();
  if (name === "cursor_oauth_login") {
    const { uuid, loginUrl, expiresInMin } = startOAuthLogin();
    return {
      ok: true,
      uuid,
      login_url: loginUrl,
      instructions: `请用户在浏览器打开上面的 login_url 完成登录授权（${expiresInMin} 分钟内有效），完成后调用 cursor_oauth_wait(uuid="${uuid}") 等待 token。`,
    };
  }
  if (name === "cursor_oauth_wait") {
    const r = await pollOAuthLogin(args.uuid, { timeoutMs: args.timeoutMs });
    return { ...r, note: "OAuth 登录完成，token 已缓存；现在可以用 cursor_web_search 了" };
  }
  if (name === "cursor_web_search") return await toolSearch(args.searchTerm, { maxResults: args.maxResults });
  throw new Error(`未知工具: ${name}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handleRpc(msg).catch((e) => {
      if (msg.id !== undefined) {
        rpcSend({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e.message || e) } });
      }
    });
  }
});

async function handleRpc(msg) {
  if (msg.method === "initialize") {
    return rpcSend({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cursor-search-mcp", version: "1.0.0" },
      },
    });
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    return rpcSend({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  }
  if (msg.method === "tools/call") {
    const { name, arguments: args = {} } = msg.params || {};
    const task = chain.then(
      () => handleCall(name, args),
      () => handleCall(name, args)
    );
    chain = task.catch(() => {});
    let result;
    try {
      result = await task;
      rpcSend({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] },
      });
    } catch (e) {
      rpcSend({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `错误: ${e.message}` }], isError: true },
      });
    }
    return;
  }
  if (msg.id !== undefined) {
    return rpcSend({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `method not found: ${msg.method}` },
    });
  }
}

/* ---------------- 启动自检：无凭据时自动 OAuth ---------------- */

/**
 * 启动时检测凭据：无 API key 且无有效缓存 token 时，自动发起 OAuth。
 * 登录 URL 打到 stderr（MCP stdio 的 stdout 只能走 JSON-RPC），
 * 后台静默轮询，拿到 token 落盘后后续搜索直接可用。
 * 完全本地逻辑，复用已逆向的 /auth/poll 协议，不新增任何协议。
 */
function startupAuthCheck() {
  const fs = require("node:fs");
  const keyFile = require("node:path").join(STATE_DIR, "key");
  let hasApiKey = Boolean(process.env.CURSOR_API_KEY);
  if (!hasApiKey) {
    try {
      hasApiKey = Boolean(fs.readFileSync(keyFile, "utf8").trim());
    } catch {}
  }
  if (hasApiKey) return; // 有 API key，ensureToken 会自动 exchange，无需 OAuth

  // 无 key：看 token 是否已缓存且未过期
  try {
    const d = JSON.parse(fs.readFileSync(require("node:path").join(STATE_DIR, "auth.json"), "utf8"));
    if (d.accessToken) {
      try {
        const p = JSON.parse(Buffer.from(d.accessToken.split(".")[1], "base64url").toString("utf8"));
        if (typeof p.exp === "number" && p.exp * 1000 > Date.now() + 60_000) return; // token 还活着
      } catch {}
    }
  } catch {}

  // 需要 OAuth：发起并把 URL 打到 stderr
  const { uuid, loginUrl, expiresInMin } = startOAuthLogin();
  process.stderr.write(
    "\n[cursor-search-mcp] 未检测到登录凭据，已自动发起 OAuth 登录。\n" +
      `请在浏览器打开以下 URL 完成授权（${expiresInMin} 分钟内有效）：\n${loginUrl}\n` +
      "完成授权后 token 会自动缓存，无需其他操作。\n\n"
  );
  // 后台静默轮询（最长 15 分钟）；失败不致命——用户仍可用 cursor_oauth_login 工具手动发起
  pollOAuthLogin(uuid, { timeoutMs: 15 * 60_000 })
    .then(() => process.stderr.write("[cursor-search-mcp] OAuth 登录完成，token 已缓存。\n"))
    .catch((e) => process.stderr.write(`[cursor-search-mcp] 自动登录未完成: ${e.message}\n`));
}

startupAuthCheck();
