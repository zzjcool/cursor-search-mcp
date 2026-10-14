#!/usr/bin/env node
/**
 * cursor-search-mcp — Cursor web search as an MCP tool. Pure protocol client,
 * no cursor-agent binary required. Zero npm dependencies (Node.js >= 18).
 *
 * MCP server (default, no args):
 *   stdio JSON-RPC 2024-11-05. Login-aware initialize instructions.
 *
 * CLI:
 *   cursor-search-mcp login     OAuth browser login (prints URL, waits, caches token)
 *   cursor-search-mcp status    Report login/token state
 *   cursor-search-mcp search    One-shot web search from the terminal
 *   cursor-search-mcp help     Show usage
 *
 * Login sources (first match wins):
 *   CURSOR_API_KEY env or ~/.cursor-search-mcp/key  → auto token exchange
 *   ~/.cursor-search-mcp/auth.json                   → cached token (auto-refresh)
 *   OAuth browser login                              → `login` command or MCP tools
 */
"use strict";

const path = require("node:path");
const os = require("node:os");
const {
  runSearch,
  ensureToken,
  API_BASE,
  DEFAULT_MODEL,
  startOAuthLogin,
  pollOAuthLogin,
} = require("./agent-protocol.js");

const STATE_DIR = process.env.CURSOR_SEARCH_STATE_DIR || path.join(os.homedir(), ".cursor-search-mcp");

/* ================================ CLI ================================ */

async function cliLogin() {
  try {
    await ensureToken();
    console.error("✓ Already logged in (valid credentials present). Re-login: delete " + path.join(STATE_DIR, "auth.json"));
    process.exit(0);
  } catch {
    /* not logged in — proceed */
  }
  const { uuid, loginUrl, expiresInMin } = startOAuthLogin();
  console.error(`\nOpen this URL in a browser to sign in to Cursor (valid for ${expiresInMin} min):\n`);
  console.error(`  ${loginUrl}\n`);
  console.error("Waiting for authorization… (Ctrl+C to cancel)\n");
  try {
    await pollOAuthLogin(uuid, { timeoutMs: 15 * 60_000 });
    console.error(`\n✓ Logged in. Token cached at ${path.join(STATE_DIR, "auth.json")}`);
    process.exit(0);
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exit(1);
  }
}

async function cliStatus() {
  try {
    const { fresh } = await ensureToken();
    console.log(`logged in (${fresh ? "token freshly exchanged" : "cached token valid"})`);
    process.exit(0);
  } catch (e) {
    console.log(`not logged in: ${e.message}`);
    process.exit(1);
  }
}

async function cliSearch(query) {
  if (!query) {
    console.error("usage: cursor-search-mcp search <query>");
    process.exit(1);
  }
  try {
    const r = await runSearch(query);
    console.log(r.answer);
    const seen = new Set();
    const lines = [];
    for (const ref of r.references) {
      for (const u of ref.urls) {
        if (!seen.has(u.url)) {
          seen.add(u.url);
          lines.push(`- ${u.title} | ${u.url}`);
        }
      }
    }
    if (lines.length > 0) {
      console.log("\nSources:");
      console.log(lines.join("\n"));
    }
    process.exit(0);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

function cliHelp() {
  console.log(`cursor-search-mcp — Cursor web search as an MCP tool

Usage:
  cursor-search-mcp               Start the MCP stdio server
  cursor-search-mcp login         OAuth browser login (prints URL, waits for token)
  cursor-search-mcp status        Show login state
  cursor-search-mcp search <q>   One-shot web search
  cursor-search-mcp help          Show this help

Config:
  CURSOR_API_KEY                  API key (or file at ${path.join(STATE_DIR, "key")})
  CURSOR_SEARCH_STATE_DIR        State directory (default ~/.cursor-search-mcp)
  CURSOR_SEARCH_MODEL             Model for search synthesis (default ${DEFAULT_MODEL})`);
  process.exit(0);
}

async function runCli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "login") return cliLogin();
  if (cmd === "status") return cliStatus();
  if (cmd === "search") return cliSearch(rest.join(" "));
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return cliHelp();
  return undefined; // unknown → fall through to MCP stdio
}

/* ============================ MCP stdio ============================ */

const TOOLS = [
  {
    name: "cursor_login",
    description:
      "Report Cursor login/token status. Credentials come from CURSOR_API_KEY, ~/.cursor-search-mcp/key, or a cached OAuth token.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cursor_oauth_login",
    description:
      "Start OAuth browser login (no API key needed). Returns login_url for the user to open in a browser; " +
      "then call cursor_oauth_wait with the returned uuid to complete the token exchange.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cursor_oauth_wait",
    description:
      "Wait for the user to finish OAuth browser authorization and exchange the token. Call after cursor_oauth_login's URL was opened.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "uuid returned by cursor_oauth_login" },
        timeoutMs: { type: "number", description: "Wait timeout in ms (default 300000 = 5 min)" },
      },
      required: ["uuid"],
      additionalProperties: false,
    },
  },
  {
    name: "cursor_web_search",
    description:
      "Web search (Cursor server-side, pure protocol). Returns a synthesized answer with source links. Good for latest docs, releases, facts.",
    inputSchema: {
      type: "object",
      properties: {
        searchTerm: { type: "string", description: "Search query / question" },
        maxResults: { type: "number", description: "Max source links (default 15)" },
      },
      required: ["searchTerm"],
      additionalProperties: false,
    },
  },
];

function rpcSend(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// Serialize tool calls (each search is a fresh server-side session; avoid hammering)
let chain = Promise.resolve();

async function toolLogin() {
  const { fresh } = await ensureToken();
  return {
    ok: true,
    mode: "protocol-direct",
    fresh_login: fresh,
    api_base: API_BASE,
    model: DEFAULT_MODEL,
    note: `Token cached at ${path.join(STATE_DIR, "auth.json")}; auto-refreshed on expiry.`,
  };
}

async function toolSearch(searchTerm, { maxResults } = {}) {
  if (!searchTerm || typeof searchTerm !== "string") throw new Error("searchTerm required");
  const r = await runSearch(searchTerm);
  const n = maxResults || 5;
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

async function handleCall(name, args) {
  if (name === "cursor_login") return await toolLogin();
  if (name === "cursor_oauth_login") {
    const { uuid, loginUrl, expiresInMin } = startOAuthLogin();
    pendingLogin = { loginUrl, expiresAt: Date.now() + expiresInMin * 60_000 };
    return {
      ok: true,
      uuid,
      login_url: loginUrl,
      instructions: `Ask the user to open login_url in a browser (valid ${expiresInMin} min), then call cursor_oauth_wait(uuid="${uuid}").`,
    };
  }
  if (name === "cursor_oauth_wait") {
    const r = await pollOAuthLogin(args.uuid, { timeoutMs: args.timeoutMs });
    pendingLogin = null;
    return { ...r, note: "Login complete; cursor_web_search is ready." };
  }
  if (name === "cursor_web_search") return await toolSearch(args.searchTerm, { maxResults: args.maxResults });
  throw new Error(`unknown tool: ${name}`);
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
    const loginState = getLoginState();
    let instructions;
    if (loginState.status === "logged-in") {
      instructions =
        "Cursor web search ready. Tools: cursor_web_search (search), cursor_login (status). " +
        "Each search runs a fresh agent-loop session server-side.";
    } else if (loginState.status === "pending-oauth") {
      instructions =
        "⚠️ cursor-search: not logged in. OAuth started in the background — ask the user to open this URL in a browser (valid 15 min):\n" +
        `${loginState.loginUrl}\n` +
        "After authorization the token is cached automatically; no restart needed, cursor_web_search works right away. " +
        "If the link expires, call cursor_oauth_login for a new one.";
    } else {
      instructions =
        "cursor-search: not logged in. Call cursor_oauth_login for a login URL (or set CURSOR_API_KEY).";
    }
    return rpcSend({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cursor-search-mcp", version: "1.3.0" },
        instructions,
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
        result: { content: [{ type: "text", text: `error: ${e.message}` }], isError: true },
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

/* ==================== Login state (for initialize instructions) ==================== */

/** OAuth login pending info, shared between startupAuthCheck and initialize. */
let pendingLogin = null; // {loginUrl, expiresAt}

function getLoginState() {
  const fs = require("node:fs");
  const pathMod = require("node:path");
  let hasApiKey = Boolean(process.env.CURSOR_API_KEY);
  if (!hasApiKey) {
    try {
      hasApiKey = Boolean(fs.readFileSync(pathMod.join(STATE_DIR, "key"), "utf8").trim());
    } catch {}
  }
  if (hasApiKey) return { status: "logged-in" };
  try {
    const d = JSON.parse(fs.readFileSync(pathMod.join(STATE_DIR, "auth.json"), "utf8"));
    if (d.accessToken) {
      try {
        const p = JSON.parse(Buffer.from(d.accessToken.split(".")[1], "base64url").toString("utf8"));
        if (typeof p.exp === "number" && p.exp * 1000 > Date.now() + 60_000) return { status: "logged-in" };
      } catch {}
    }
  } catch {}
  if (pendingLogin && pendingLogin.expiresAt > Date.now()) {
    return { status: "pending-oauth", loginUrl: pendingLogin.loginUrl };
  }
  return { status: "not-logged-in" };
}

/* ==================== Startup auth check (auto OAuth) ==================== */

/**
 * On startup without credentials, start OAuth automatically, print the login URL to
 * stderr (stdout is reserved for JSON-RPC), and poll in the background.
 */
function startupAuthCheck() {
  const fs = require("node:fs");
  const pathMod = require("node:path");
  let hasApiKey = Boolean(process.env.CURSOR_API_KEY);
  if (!hasApiKey) {
    try {
      hasApiKey = Boolean(fs.readFileSync(pathMod.join(STATE_DIR, "key"), "utf8").trim());
    } catch {}
  }
  if (hasApiKey) return;
  try {
    const d = JSON.parse(fs.readFileSync(pathMod.join(STATE_DIR, "auth.json"), "utf8"));
    if (d.accessToken) {
      try {
        const p = JSON.parse(Buffer.from(d.accessToken.split(".")[1], "base64url").toString("utf8"));
        if (typeof p.exp === "number" && p.exp * 1000 > Date.now() + 60_000) return;
      } catch {}
    }
  } catch {}

  const { uuid, loginUrl, expiresInMin } = startOAuthLogin();
  pendingLogin = { loginUrl, expiresAt: Date.now() + expiresInMin * 60_000 };
  process.stderr.write(
    "\n[cursor-search-mcp] No credentials found; started OAuth login automatically.\n" +
      `Open this URL in a browser to authorize (valid ${expiresInMin} min):\n${loginUrl}\n` +
      "The token is cached automatically once authorized.\n\n"
  );
  pollOAuthLogin(uuid, { timeoutMs: 15 * 60_000 })
    .then(() => {
      pendingLogin = null;
      process.stderr.write("[cursor-search-mcp] OAuth login complete; token cached.\n");
    })
    .catch((e) => process.stderr.write(`[cursor-search-mcp] auto login unfinished: ${e.message}\n`));
}

/* ==================== Entry point ==================== */

const argv = process.argv.slice(2);
const CLI_COMMANDS = new Set(["login", "status", "search", "help", "--help", "-h"]);
if (argv.length > 0 && CLI_COMMANDS.has(argv[0])) {
  runCli(argv).catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
} else {
  startupAuthCheck(); // MCP stdio mode
}
