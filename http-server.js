#!/usr/bin/env node
/**
 * cursor-search-mcp HTTP 模式 — 让 `pi mcp login cursor-search` 原生可用。
 *
 * 在 MCP 授权层（pi 认得的 401 challenge + OAuth 发现 + PKCE）后面，
 * 垫 Cursor 自己的 PKCE 设备码流程（已逆向）:
 *
 *   GET  /                          → MCP Streamable HTTP 端点（JSON-RPC POST 到 /）
 *   GET  /.well-known/oauth-protected-resource
 *        → {authorization_servers: [自身]}          ← pi 的发现入口
 *   GET  /.well-known/oauth-authorization-server
 *        → {authorization_endpoint, token_endpoint, ...}
 *   GET  /authorize?...&code_challenge=...          ← pi 发起 PKCE
 *        → 302 到 cursor.com/loginDeepControl（透传 challenge 参数）
 *   POST /token  grant_type=authorization_code      ← pi 用 code 换 token
 *        → 我们内部: 用 code 里编码的 uuid+verifier 去 poll Cursor → 拿到
 *          accessToken 包装成 MCP OAuth token 返回
 *
 * 任何 Bearer 请求到达 MCP 端点时校验 token（本地缓存的 Cursor accessToken 对照），
 * 不匹配 → 401 重新触发 pi 的登录流程。
 *
 * 启动: node http-server.js [port]   （默认 7331）
 * pi 侧 mcp.json 配置:
 *   "cursor-search": { "type": "http", "url": "http://127.0.0.1:7331/" }
 */
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  runSearch,
  ensureToken,
  API_BASE,
  DEFAULT_MODEL,
  startOAuthLogin,
  pollOAuthLogin,
} = require("./agent-protocol.js");

const PORT = Number(process.argv[2] || process.env.CURSOR_SEARCH_HTTP_PORT || 7331);
const ISSUER = `http://127.0.0.1:${PORT}`;
const STATE_DIR = process.env.CURSOR_SEARCH_STATE_DIR || path.join(os.homedir(), ".cursor-search-mcp");
const TOKEN_FILE = path.join(STATE_DIR, "auth.json");

/* ---------------- Cursor OAuth 桥 ---------------- */

// code → {uuid, verifier, cursorChallenge}（authorize 时生成，token 时消费，单次有效）
const authCodes = new Map();

function readCachedCursorToken() {
  try {
    const d = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    return d.accessToken || null;
  } catch {
    return null;
  }
}

/* pi 的 PKCE verifier 我们不校验（授权是 Cursor 侧完成的），
 * 我们只做参数透传: pi 的 code_challenge 丢弃，换成 Cursor 的 challenge；
 * pi 最终拿到的 access_token = 我们签发的一个随机令牌，映射到 Cursor token。 */
const issuedTokens = new Map(); // mcpToken → cursorAccessToken

/* ---------------- MCP JSON-RPC（Streamable HTTP，POST /） ---------------- */

const TOOLS = [
  {
    name: "cursor_login",
    description: "校验登录/token 状态（HTTP 模式下由 pi 的 MCP OAuth 登录管理，此工具仅报告状态）",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cursor_web_search",
    description:
      "联网搜索（Cursor 服务端 web search）。返回模型归纳的答案与来源链接列表。适合查最新资料、文档、版本变更。",
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

async function handleRpcMethod(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), result });
  if (method === "initialize") {
    return reply({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "cursor-search-mcp", version: "1.2.0", mode: "http" },
    });
  }
  if (method === "tools/list") return reply({ tools: TOOLS });
  if (method === "tools/call") {
    const { name, arguments: args = {} } = params || {};
    if (name === "cursor_login") {
      const has = Boolean(readCachedCursorToken());
      return reply({
        content: [{ type: "text", text: JSON.stringify({ ok: true, cursor_token_cached: has, api_base: API_BASE }, null, 1) }],
      });
    }
    if (name === "cursor_web_search") {
      const r = await runSearch(args.searchTerm);
      const seen = new Set();
      const links = [];
      for (const ref of r.references)
        for (const u of ref.urls)
          if (!seen.has(u.url)) {
            seen.add(u.url);
            links.push(u);
          }
      const out = {
        answer: r.answer,
        links: links.slice(0, (args.maxResults || 5) * 3),
        link_count: links.length,
        mode: "http-oauth",
      };
      return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 1) }] });
    }
    return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${name}` } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
}

/* ---------------- HTTP 服务 ---------------- */

function json(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(text);
}

/** 校验请求的 Bearer 是否映射到有效 Cursor token；无效则 401 challenge。 */
function checkAuth(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return false;
  const cursorTok = issuedTokens.get(m[1]);
  if (cursorTok && cursorTok === readCachedCursorToken()) return true;
  // 也接受直接携带 Cursor accessToken（宽松模式）
  return m[1] === readCachedCursorToken();
}

function challenge401(res) {
  json(
    res,
    401,
    { error: "unauthorized", error_description: "Sign in required" },
    {
      "WWW-Authenticate": `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
    }
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);

  // ---- OAuth 发现（无需鉴权） ----
  if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    return json(res, 200, { resource: ISSUER, authorization_servers: [ISSUER] });
  }
  if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    return json(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["search"],
    });
  }
  // 动态客户端注册（pi 默认走 DCR；返回固定 client_id）
  if (req.method === "POST" && url.pathname === "/register") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () =>
      json(res, 201, {
        client_id: "cursor-search-mcp",
        client_name: "cursor-search-mcp",
        redirect_uris: ["http://127.0.0.1:*/callback", "http://localhost:*/callback"],
        token_endpoint_auth_method: "none",
      })
    );
    return;
  }

  // ---- authorize: pi 发起 → 转成 Cursor 的 OAuth ----
  if (req.method === "GET" && url.pathname === "/authorize") {
    // 生成 Cursor 侧登录（PKCE）
    const { uuid, loginUrl } = startOAuthLogin();
    let cursorChallenge = null;
    try {
      cursorChallenge = new URL(loginUrl).searchParams.get("challenge");
    } catch {}
    const code = crypto.randomUUID();
    authCodes.set(code, { uuid, cursorChallenge, created: Date.now() });
    // 单次有效 + 10 分钟过期
    setTimeout(() => authCodes.delete(code), 10 * 60_000).unref?.();
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    let back;
    try {
      back = new URL(redirectUri);
    } catch {
      return json(res, 400, { error: "invalid_request", error_description: "bad redirect_uri" });
    }
    if (state) back.searchParams.set("state", state);
    back.searchParams.set("code", code);
    // 302 去浏览器登录 Cursor（loginDeepControl 授权后 Cursor 不会回调我们，
    // 所以改成：跳到 Cursor 登录页，token 兑换在 /token 阶段用 poll 完成）
    return json(res, 200, {
      // 非标准但实用的中间页数据；pi 的浏览器会打开它
      login_url: loginUrl,
      next_url: back.toString(),
      note: "Open login_url in a browser, sign in to Cursor, then open next_url (or pi will time out and you retry).",
      // 同时提供标准 302 备用（浏览器直跳 Cursor）
      redirect: loginUrl,
    });
  }

  // ---- token: pi 用 code 换（我们内部轮询 Cursor poll） ----
  if (req.method === "POST" && url.pathname === "/token") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const p = new URLSearchParams(body);
      const grant = p.get("grant_type");
      const code = p.get("code");
      const entry = authCodes.get(code);
      if (grant !== "authorization_code" || !entry) {
        return json(res, 400, { error: "invalid_grant" });
      }
      authCodes.delete(code);
      // 轮询 Cursor（用户在浏览器完成授权后 poll 返回 token）
      try {
        await pollOAuthLogin(entry.uuid, { timeoutMs: 5 * 60_000 });
        const cursorTok = readCachedCursorToken();
        if (!cursorTok) return json(res, 500, { error: "server_error", error_description: "Cursor token missing after poll" });
        const mcpTok = crypto.randomBytes(24).toString("base64url");
        issuedTokens.set(mcpTok, cursorTok);
        return json(res, 200, {
          access_token: mcpTok,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "search",
        });
      } catch (e) {
        return json(res, 400, { error: "invalid_grant", error_description: e.message });
      }
    });
    return;
  }

  // ---- MCP 端点（POST /，需 Bearer） ----
  if (req.method === "POST" && (url.pathname === "/" || url.pathname === "/mcp")) {
    if (!checkAuth(req)) return challenge401(res);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const msg = JSON.parse(body);
        const reply = await handleRpcMethod(msg);
        return json(res, 200, reply);
      } catch (e) {
        return json(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32603, message: String(e.message || e) } });
      }
    });
    return;
  }

  // ---- 其他: 也 401（Streamable HTTP 的 GET 用于 SSE 流，这里简化为 challenge） ----
  return challenge401(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[cursor-search-mcp/http] listening on http://127.0.0.1:${PORT}/`);
  console.error(`OAuth issuer: ${ISSUER}`);
  console.error(`pi 侧配置: { "type": "http", "url": "http://127.0.0.1:${PORT}/" }`);
});

module.exports = { server };
