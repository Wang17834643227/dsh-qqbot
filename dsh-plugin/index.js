/**
 * dsh-qqbot-bridge — node half.
 *
 * Gives the agent a direct connection to a QQ bot through a bridge:
 *   - backend "mock" (default): in-process simulated QQ bot, fully offline,
 *     auto-echoes sent messages so round-trips are verifiable.
 *   - backend "bridge": HTTP bridge (bridge/qqbot-bridge.mjs or a real QQ bot
 *     adapter) at `bridgeUrl`, speaking the /status /send /poll /inbound protocol.
 *
 * Registered tools:
 *   qqbot_status   → bridge status (mode, connected, seq, uptime)
 *   qqbot_send     → send a message to a QQ target (c2c:<openid> | group:<gid>)
 *   qqbot_poll     → poll for new messages received by the bot
 *   qqbot_inbound  → simulate an incoming QQ message (mock only; test hook)
 *
 * Also mirrors the bridge protocol on the DSH web server under
 *   /plugins/dsh-qqbot-bridge/bridge/{health,status,poll}   (GET)
 *   /plugins/dsh-qqbot-bridge/bridge/{send,inbound}        (POST)
 *
 * No @deepseek-ai imports: tool definitions are plain registry-ready objects
 * (JSON-schema parameters + output), so the bundle stays loadable in every
 * host where plain Node built-ins and global fetch exist.
 */

import { readFileSync } from "node:fs";

// Read the bundle version from this directory's package.json so /health and
// mock status always report the real version; fall back to a constant.
let VERSION = "1.0.4";
try {
  VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version ?? VERSION;
} catch { /* keep fallback */ }

// ---------------------------------------------------------------------------
// In-process mock backend (same protocol as bridge/qqbot-bridge.mjs)
// ---------------------------------------------------------------------------

function createMockBackend() {
  let seq = 0;
  let autoReply = true;
  const startedAt = Date.now();
  const items = [];
  const push = (dir, from, to, text, kind = "text") => {
    const item = { seq: ++seq, dir, from, to, text, kind, at: new Date().toISOString() };
    items.push(item);
    if (items.length > 500) items.splice(0, items.length - 500);
    return item;
  };
  const normalizeTarget = (to) => {
    const t = String(to ?? "").trim();
    if (!t) return null;
    return /^(c2c|group):/i.test(t) ? t : `c2c:${t}`;
  };
  return {
    name: "mock",
    status: () => ({
      mode: "mock",
      connected: true,
      backend: "in-process simulation",
      accounts: ["mock-qq-bot"],
      autoReply,
      seq,
      uptimeMs: Date.now() - startedAt,
      version: VERSION,
    }),
    send: ({ to, message, kind }) => {
      const target = normalizeTarget(to);
      if (!target) return { ok: false, error: "`to` is required (e.g. c2c:<openid> or group:<gid>)" };
      if (typeof message !== "string" || !message.trim()) return { ok: false, error: "`message` must be a non-empty string" };
      const out = push("out", "agent", target, message, kind ?? "text");
      let echoQueued = false;
      if (autoReply) {
        push("in", target, "agent", `[mock peer] received: "${message}"`, "text");
        echoQueued = true;
      }
      return { ok: true, messageId: `mock-${out.seq}`, seq: out.seq, echoQueued };
    },
    poll: (since) => {
      const s = Number.isFinite(since) ? since : 0;
      return { messages: items.filter((m) => m.seq > s), latestSeq: seq };
    },
    inbound: ({ from, message }) => {
      if (!from) return { ok: false, error: "`from` is required" };
      const item = push("in", String(from), "bot", String(message ?? ""), "text");
      return { ok: true, seq: item.seq };
    },
    setAutoReply(v) { autoReply = Boolean(v); },
  };
}

// ---------------------------------------------------------------------------
// External HTTP bridge client
// ---------------------------------------------------------------------------

function createBridgeBackend(bridgeUrl, timeoutMs) {
  const call = async (path, init = {}) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(new URL(path, bridgeUrl).toString(), { ...init, signal: controller.signal });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { raw: String(text).slice(0, 500) }; }
      if (!res.ok) {
        const err = new Error(`bridge ${path} → HTTP ${res.status}: ${body && body.error ? body.error : JSON.stringify(body).slice(0, 200)}`);
        err.bridge = true;
        throw err;
      }
      return body;
    } finally {
      clearTimeout(t);
    }
  };
  return {
    name: "bridge",
    status: () => call("/status"),
    send: (args) => call("/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) }),
    poll: (since) => call(`/poll?since=${encodeURIComponent(since ?? 0)}`),
    inbound: (args) => call("/inbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) }),
  };
}

// ---------------------------------------------------------------------------
// Tool definitions (registry-ready: plain objects, JSON-schema parameters)
// ---------------------------------------------------------------------------

const OBJECT_SCHEMA = { type: "object" };

function toolDefinitions(bridge) {
  return [
    {
      name: "qqbot_status",
      description: "Query the QQ bot bridge status: mode (mock/real), connected, message sequence and uptime. Call this before sending or polling to confirm the bridge is reachable.",
      parameters: OBJECT_SCHEMA,
      output: {
        schema: OBJECT_SCHEMA,
        render: (_args, result) => [{ type: "text", text: JSON.stringify(result, null, 2) }],
      },
      timeoutMs: 30000,
      execute: async () => bridge.status(),
    },
    {
      name: "qqbot_send",
      description: "Send a message through the QQ bot bridge to a QQ target. `to` uses the grammar `c2c:<openid>` (QQ user) or `group:<group_openid>` (group); a bare openid is treated as c2c. In mock mode the simulated peer echoes the message so the round-trip is verifiable.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Target, e.g. c2c:12345 or group:67890." },
          message: { type: "string", description: "Message text to send." },
          kind: { type: "string", enum: ["text", "markdown"], description: "Optional: text (default) or markdown." },
        },
        required: ["to", "message"],
        additionalProperties: false,
      },
      output: {
        schema: OBJECT_SCHEMA,
        render: (_args, result) => [{ type: "text", text: JSON.stringify(result, null, 2) }],
      },
      timeoutMs: 30000,
      execute: async (args) => {
        const result = bridge.send(args ?? {});
        if (result && result.ok === false) {
          const err = new Error(result.error ?? "send failed");
          err.detail = result;
          throw err;
        }
        return result;
      },
    },
    {
      name: "qqbot_poll",
      description: "Poll for new messages received by the QQ bot since a sequence number. Returns `{ messages: [...], latestSeq }`; pass `latestSeq` from a previous call as `since` to avoid duplicates.",
      parameters: {
        type: "object",
        properties: {
          since: { type: "number", description: "Optional sequence number to resume from (default 0 = all)." },
        },
        additionalProperties: false,
      },
      output: {
        schema: OBJECT_SCHEMA,
        render: (_args, result) => [{ type: "text", text: JSON.stringify(result, null, 2) }],
      },
      timeoutMs: 30000,
      execute: async (args) => bridge.poll(args?.since),
    },
    {
      name: "qqbot_inbound",
      description: "Test hook: simulate an incoming QQ message to the bot (mock backend only). Real bridges receive messages via the QQ gateway instead.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Sender identifier, e.g. c2c:12345." },
          message: { type: "string", description: "Inbound message text." },
        },
        required: ["from", "message"],
        additionalProperties: false,
      },
      output: {
        schema: OBJECT_SCHEMA,
        render: (_args, result) => [{ type: "text", text: JSON.stringify(result, null, 2) }],
      },
      timeoutMs: 30000,
      execute: async (args) => {
        const result = bridge.inbound(args ?? {});
        if (result && result.ok === false) {
          const err = new Error(result.error ?? "inbound failed");
          err.detail = result;
          throw err;
        }
        return result;
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// HTTP surface on the DSH web server (best-effort; plugin activates without it)
// ---------------------------------------------------------------------------

function httpHandlersFor(bridge) {
  const jsonOut = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(body);
  };
  const readJsonBody = async (req) => {
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) break; }
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return null; }
  };
  return {
    "/plugins/dsh-qqbot-bridge/bridge/health": async (_req, res) => {
      jsonOut(res, 200, { ok: true, version: VERSION });
    },
    "/plugins/dsh-qqbot-bridge/bridge/status": async (_req, res) => {
      try { jsonOut(res, 200, await bridge.status()); } catch (e) { jsonOut(res, 502, { ok: false, error: String(e.message) }); }
    },
    "/plugins/dsh-qqbot-bridge/bridge/poll": async (req, res) => {
      const since = Number(new URL(req?.url ?? "", "http://localhost").searchParams.get("since") ?? 0);
      try { jsonOut(res, 200, await bridge.poll(since)); } catch (e) { jsonOut(res, 502, { ok: false, error: String(e.message) }); }
    },
    "/plugins/dsh-qqbot-bridge/bridge/send": async (req, res) => {
      const parsed = await readJsonBody(req);
      if (parsed === null) return jsonOut(res, 400, { ok: false, error: "invalid JSON body" });
      try {
        const r = await bridge.send(parsed);
        jsonOut(res, r.ok ? 200 : 400, r);
      } catch (e) { jsonOut(res, 502, { ok: false, error: String(e.message) }); }
    },
    "/plugins/dsh-qqbot-bridge/bridge/inbound": async (_req, res) => {
      const parsed = await readJsonBody(_req);
      if (parsed === null) return jsonOut(res, 400, { ok: false, error: "invalid JSON body" });
      try {
        const r = bridge.inbound(parsed);
        jsonOut(res, r.ok ? 200 : 400, r);
      } catch (e) { jsonOut(res, 502, { ok: false, error: String(e.message) }); }
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export const inject = [];
export const name = "dsh-qqbot-bridge";

export function apply(ctx, config = {}) {
  const backend = config.backend === "bridge" ? "bridge" : "mock";
  const bridgeUrl = config.bridgeUrl || "http://127.0.0.1:8790";
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 15000;
  const bridge = backend === "bridge" ? createBridgeBackend(bridgeUrl, timeoutMs) : createMockBackend();

  // Tools: lazy discovery (activation-order tolerant), owned by an effect.
  ctx.effect(() => {
    let disposers = null;
    let attempts = 0;
    const registerNow = () => {
      let tools = null;
      try { tools = typeof ctx.get === "function" ? ctx.get("tools") : null; } catch { /* ignore */ }
      if (!tools) { try { tools = ctx.tools || null; } catch { /* ignore */ } }
      if (!tools || typeof tools.register !== "function") return false;
      disposers = [];
      for (const def of toolDefinitions(bridge)) {
        disposers.push(tools.register(def));
      }
      return true;
    };
    if (registerNow()) {
      return () => { for (const d of disposers ?? []) { try { d(); } catch { /* ignore */ } } };
    }
    const timer = setInterval(() => {
      attempts++;
      if (registerNow() || attempts >= 20) clearInterval(timer);
    }, 500);
    return () => {
      clearInterval(timer);
      for (const d of disposers ?? []) { try { d(); } catch { /* ignore */ } }
    };
  }, "dsh-qqbot-bridge: tools");

  // HTTP surface on the DSH web server (best-effort).
  ctx.effect(() => {
    const handlers = httpHandlersFor(bridge);
    let disposers = null;
    let attempts = 0;
    const registerNow = () => {
      let ws = null;
      try { ws = typeof ctx.get === "function" ? ctx.get("webServer") : null; } catch { /* ignore */ }
      if (!ws) { try { ws = ctx.webServer || null; } catch { /* ignore */ } }
      if (!ws || typeof ws.register !== "function") return false;
      disposers = [];
      for (const [path, handler] of Object.entries(handlers)) {
        disposers.push(ws.register({ kind: "exact", path, handler }));
      }
      return true;
    };
    if (registerNow()) {
      return () => { for (const d of disposers ?? []) { try { d(); } catch { /* ignore */ } } };
    }
    const timer = setInterval(() => {
      attempts++;
      if (registerNow() || attempts >= 20) clearInterval(timer);
    }, 500);
    return () => {
      clearInterval(timer);
      for (const d of disposers ?? []) { try { d(); } catch { /* ignore */ } }
    };
  }, "dsh-qqbot-bridge: HTTP bridge routes");
}
