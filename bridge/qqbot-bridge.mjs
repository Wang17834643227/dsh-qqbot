#!/usr/bin/env node
/**
 * qqbot-bridge — a zero-dependency HTTP bridge between an AI agent and a QQ bot.
 *
 * Two modes:
 *   --mock  (default): in-memory simulated QQ bot. No credentials, no network.
 *                      Auto-replies to outbound messages so round-trips can be
 *                      verified offline.
 *   --real          : connects to the official Tencent QQ Bot platform
 *                      (appId + clientSecret) and mirrors the bridge surface
 *                      onto the real API + gateway WebSocket.
 *
 * Bridge surface (HTTP, JSON):
 *   GET  /health          → { ok: true, mode, version }
 *   GET  /status          → { mode, connected, backend, seq, uptimeMs, ... }
 *   POST /send           → { ok, messageId, seq, ... }   body: { to, message, kind? }
 *   GET  /poll?since=N   → { messages: [...], latestSeq }
 *   POST /inbound        → { ok, seq }                   body: { from, message } (mock-only)
 *
 * `to` target grammar:
 *   "c2c:<openid>"  → QQ user direct message
 *   "group:<gid>"   → QQ group message
 *   bare "<openid>" → treated as c2c:<openid>
 */

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

// Read the release version from the root package.json (script-relative) so the
// bridge always reports the real version; fall back to a constant if unreadable.
let VERSION = "1.0.3";
try {
  VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? VERSION;
} catch { /* keep fallback */ }
const now = () => Date.now();

// ---------------------------------------------------------------------------
// Argument parsing (tiny)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { port: 8790, mode: "mock", host: "127.0.0.1", appId: "", clientSecret: "", intentBits: "33554432" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--port": args.port = Number(argv[++i]); break;
      case "--host": args.host = argv[++i]; break;
      case "--mock": args.mode = "mock"; break;
      case "--real": args.mode = "real"; break;
      case "--appId": args.appId = argv[++i]; break;
      case "--clientSecret": args.clientSecret = argv[++i]; break;
      case "--intents": args.intentBits = argv[++i]; break;
      case "--help":
      case "-h":
        console.log("Usage: node qqbot-bridge.mjs [--mock|--real] [--port 8790] [--appId ID] [--clientSecret SECRET]");
        process.exit(0);
        break;
      default: console.warn(`(bridge) unknown arg: ${a}`);
    }
  }
  args.appId = args.appId || process.env.QQBOT_APP_ID || "";
  args.clientSecret = args.clientSecret || process.env.QQBOT_CLIENT_SECRET || "";
  return args;
}

// ---------------------------------------------------------------------------
// Shared in-memory message store
// ---------------------------------------------------------------------------
function createStore() {
  const store = {
    seq: 0,
    items: [], // { seq, dir, from, to, text, at, kind }
    push(dir, from, to, text, kind = "text") {
      const item = { seq: ++this.seq, dir, from, to, text, kind, at: new Date(now()).toISOString() };
      this.items.push(item);
      if (this.items.length > 500) this.items.splice(0, this.items.length - 500);
      return item;
    },
    poll(since = 0) {
      const s = Number.isFinite(since) ? since : 0;
      return { messages: this.items.filter((m) => m.seq > s), latestSeq: this.seq };
    },
  };
  return store;
}

function normalizeTarget(to) {
  const t = String(to ?? "").trim();
  if (!t) return null;
  if (/^(c2c|group):/i.test(t)) return t;
  return `c2c:${t}`;
}

// ---------------------------------------------------------------------------
// Mock backend
// ---------------------------------------------------------------------------
function createMockBackend(args, store) {
  let autoReplyOn = true;
  return {
    name: "mock",
    connected: () => true,
    status() {
      return {
        mode: "mock",
        connected: true,
        backend: "in-memory simulation",
        accounts: ["mock-qq-bot"],
        autoReply: autoReplyOn,
        seq: store.seq,
        uptimeMs: now() - STARTED_AT,
        version: VERSION,
      };
    },
    send({ to, message, kind }) {
      const target = normalizeTarget(to);
      if (!target) return { ok: false, error: "`to` is required" };
      if (typeof message !== "string" || !message.trim()) return { ok: false, error: "`message` is required" };
      const out = store.push("out", "agent", target, message, kind);
      // Simulate the QQ peer replying, proving a full round-trip.
      if (autoReplyOn) {
        store.push("in", target, "agent", `[mock peer] received: "${message}"`, "text");
      }
      return { ok: true, messageId: `mock-${out.seq}`, seq: out.seq, autoReply: autoReplyOn };
    },
    inbound({ from, message }) {
      if (!from) return { ok: false, error: "`from` is required" };
      const item = store.push("in", String(from), "bot", String(message ?? ""), "text");
      return { ok: true, seq: item.seq };
    },
    setAutoReply(v) { autoReplyOn = Boolean(v); },
    close() {},
  };
}

// ---------------------------------------------------------------------------
// Real backend (official Tencent QQ Bot platform)
// ---------------------------------------------------------------------------
const OFFICIAL = {
  tokenUrl: "https://bots.qq.com/app/getAppAccessToken",
  apiBase: "https://api.sgroup.qq.com",
};

function createRealBackend(args, store) {
  if (!args.appId || !args.clientSecret) {
    throw new Error("real mode requires --appId and --clientSecret (or QQBOT_APP_ID / QQBOT_CLIENT_SECRET env vars)");
  }
  const state = {
    token: null,
    tokenExpiresAt: 0,
    gatewayUrl: null,
    ws: null,
    connected: false,
    seqId: crypto.randomUUID(),
    lastDispatchSeq: 0,
  };

  async function getToken(force = false) {
    if (!force && state.token && state.tokenExpiresAt - 30_000 > now()) return state.token;
    const res = await fetch(OFFICIAL.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appid: String(args.appId), client_secret: args.clientSecret }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new Error(`token fetch failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    }
    state.token = body.access_token;
    state.tokenExpiresAt = now() + Number(body.expires_in || 7200) * 1000;
    return state.token;
  }

  async function gatewayUrl() {
    if (state.gatewayUrl) return state.gatewayUrl;
    const token = await getToken();
    const res = await fetch(`${OFFICIAL.apiBase}/gateway`, {
      headers: { authorization: `QQBot ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.url) throw new Error(`gateway fetch failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    state.gatewayUrl = body.url;
    state.shard = body.shard ?? 0;
    return body.url;
  }

  function wsSend(obj) {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
  }

  function handleDispatch(d) {
    if (d.op === 0 && d.d && d.d.t === "MESSAGE_CREATE") {
      const m = d.d;
      const target = m.group_id ? `group:${m.group_openid}` : `c2c:${m.author?.user_openid ?? ""}`;
      store.push("in", target, "bot", m.content ?? "", "text");
    }
    if (d.s !== undefined) state.lastDispatchSeq = d.s;
  }

  async function connect() {
    const url = await gatewayUrl();
    const ws = new WebSocket(url);
    state.ws = ws;
    ws.onopen = () => {
      wsSend({ op: 2, d: { client_id: String(args.appId), intents: Number(args.intentBits), shard: [state.shard ?? 0], v: "1", id: ++state.lastDispatchSeq + 100000 } });
      setTimeout(() => {
        if (!state.connected && ws.readyState === 1) {
          wsSend({ op: 1, d: now() });
          state.connected = true;
        }
      }, 2500);
    };
    ws.onmessage = (ev) => {
      let d;
      try { d = JSON.parse(String(ev.data)); } catch { return; }
      if (d.op === 0) handleDispatch(d);
      else if (d.op === 11 || d.op === 10) { /* ready/ack: keep heartbeat alive */ wsSend({ op: 1, d: now() }); }
    };
    ws.onclose = () => {
      state.connected = false;
      // best-effort reconnect
      setTimeout(() => { try { connect(); } catch { /* retry later */ } }, 5000);
    };
  }

  let heartbeatTimer = null;
  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => { if (state.connected) wsSend({ op: 1, d: now() }); }, 30_000);
    heartbeatTimer.unref?.();
  }

  return {
    name: "real",
    connected: () => state.connected,
    status() {
      return {
        mode: "real",
        connected: state.connected,
        backend: "official QQ Bot API",
        accounts: [String(args.appId)],
        gatewayUrl: state.gatewayUrl,
        seq: store.seq,
        uptimeMs: now() - STARTED_AT,
        version: VERSION,
      };
    },
    async send({ to, message, kind }) {
      const target = normalizeTarget(to);
      if (!target) return { ok: false, error: "`to` is required" };
      if (typeof message !== "string" || !message.trim()) return { ok: false, error: "`message` is required" };
      const token = await getToken();
      const path = target.startsWith("group:")
        ? `/v2/groups/${target.slice(6)}/messages`
        : `/v2/users/${target.slice(4)}/messages`;
      const res = await fetch(`${OFFICIAL.apiBase}${path}`, {
        method: "POST",
        headers: { authorization: `QQBot ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          msg_type: kind === "markdown" ? 0 : 2,
          content: message,
          msg_seq: store.seq + 1,
        }),
      });
      const body = await res.json().catch(() => ({}));
      const out = store.push("out", "agent", target, message, kind);
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}`, detail: body, seq: out.seq };
      }
      return { ok: true, messageId: body.id ?? `real-${out.seq}`, seq: out.seq, refIdx: body.ext_info?.ref_idx ?? null };
    },
    inbound() {
      // Real mode receives messages via the gateway, not through this endpoint.
      return { ok: false, error: "inbound is mock-only; real mode receives via gateway dispatch" };
    },
    async close() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try { state.ws?.close(); } catch { /* ignore */ }
    },
    start: async () => {
      await getToken();
      await connect();
      startHeartbeat();
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const STARTED_AT = now();
const ARGS = parseArgs(process.argv);
const STORE = createStore();
let BACKEND;
try {
  BACKEND = ARGS.mode === "real" ? createRealBackend(ARGS, STORE) : createMockBackend(ARGS, STORE);
} catch (err) {
  console.error(`(bridge) cannot start backend: ${err.message}`);
  process.exit(2);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve(data); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && (path === "/health" || path === "/")) {
      return sendJson(res, 200, { ok: true, mode: ARGS.mode, version: VERSION });
    }
    if (req.method === "GET" && path === "/status") {
      return sendJson(res, 200, BACKEND.status());
    }
    if (req.method === "POST" && path === "/send") {
      const body = await readBody(req);
      const result = await BACKEND.send(body ?? {});
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    if (req.method === "GET" && path === "/poll") {
      const since = Number(url.searchParams.get("since") ?? 0);
      return sendJson(res, 200, STORE.poll(since));
    }
    if (req.method === "POST" && path === "/inbound") {
      const body = await readBody(req);
      const result = BACKEND.inbound(body ?? {});
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    if (req.method === "POST" && path === "/mock/autoreply") {
      const body = await readBody(req);
      BACKEND.setAutoReply?.(body?.enabled);
      return sendJson(res, 200, { ok: true, enabled: BACKEND.status().autoReply ?? null });
    }
    return sendJson(res, 404, { ok: false, error: `unknown route ${req.method} ${path}` });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
});

server.listen(ARGS.port, ARGS.host, () => {
  console.log(`(bridge) ${ARGS.mode} bridge listening on http://${ARGS.host}:${ARGS.port} (v${VERSION})`);
  if (ARGS.mode === "real") {
    BACKEND.start().catch((err) => console.error(`(bridge) real backend start error: ${err.message}`));
  }
});

process.on("SIGINT", () => { console.log("\n(bridge) shutting down"); try { BACKEND.close(); } catch { /* ignore */ } server.close(); process.exit(0); });
