#!/usr/bin/env node
/**
 * Verification harness for the QQ bot bridge + DSH plugin.
 *
 * Runs 12 rounds of checks (>= 10 required), each round exercising:
 *   - /health (liveness)
 *   - /status (connected + seq)
 *   - /send   (unique per-round marker, expect ok + echoQueued)
 *   - /poll   (expect the echo reply to appear)
 *   - /inbound(simulate inbound, expect ok)
 *   - /poll   (expect the inbound to appear)
 *   - error case: /send with empty message (expect ok:false)
 *
 * Also, if the DSH web server is reachable, exercises the plugin's HTTP routes
 * (the same protocol served in-process by the installed bundle).
 *
 * Results: test/verification_results.json + test/verification.log
 * Exit 0 only when all 12 rounds pass.
 *
 * Usage: node test/verify.mjs [--rounds 12] [--port 8790] [--plugin-base http://127.0.0.1:63900]
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

function parseArgs(argv) {
  const out = { rounds: 12, port: 8790, pluginBase: "http://127.0.0.1:63900", usePlugin: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rounds") out.rounds = Number(argv[++i]);
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--plugin-base") out.pluginBase = argv[++i];
    else if (a === "--no-plugin") out.usePlugin = false;
  }
  return out;
}

const ARGS = parseArgs(process.argv);
const LOG_PATH = join(here, "verification.log");
const RES_PATH = join(here, "verification_results.json");
mkdirSync(here, { recursive: true });
try { writeFileSync(LOG_PATH, ""); } catch { /* ignore */ }
const log = (line) => {
  const stamp = new Date().toISOString();
  const text = `[${stamp}] ${line}`;
  console.log(text);
  try { appendFileSync(LOG_PATH, text + "\n"); } catch { /* ignore */ }
};

async function httpJson(base, path, init) {
  const res = await fetch(new URL(path, base).toString(), init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: res.status, body };
}

function startBridge(port) {
  const child = spawn(process.execPath, [join(ROOT, "bridge", "qqbot-bridge.mjs"), "--mock", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  child.stdout.on("data", (d) => { buf += d; });
  child.stderr.on("data", (d) => { buf += d; });
  const handle = {
    pid: child.pid,
    base: `http://127.0.0.1:${port}`,
    async ready(timeoutMs = 8000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const { body } = await httpJson(handle.base, "/health", {});
          if (body && body.ok) return true;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    },
    stop() { try { child.kill("SIGTERM"); } catch { /* ignore */ } },
    dump() { return buf.slice(-4000); },
  };
  return handle;
}

async function runRound(round, base) {
  const checks = [];
  const marker = `round${round}-marker-${Date.now() % 100000}`;

  // 1. health
  try {
    const { status, body } = await httpJson(base, "/health", {});
    checks.push({ step: "health", pass: status === 200 && body.ok === true, status, body });
  } catch (e) { checks.push({ step: "health", pass: false, error: String(e.message) }); }

  // 2. status
  let latestSeq = 0;
  try {
    const { status, body } = await httpJson(base, "/status", {});
    const pass = status === 200 && body.connected === true;
    latestSeq = Number(body.seq ?? 0);
    checks.push({ step: "status", pass, status, connected: body.connected, seq: body.seq, mode: body.mode });
  } catch (e) { checks.push({ step: "status", pass: false, error: String(e.message) }); }

  // 3. send
  let sendSeq = null;
  try {
    const { status, body } = await httpJson(base, "/send", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "c2c:test-user", message: marker, kind: "text" }),
    });
    const pass = status === 200 && body.ok === true;
    sendSeq = body.seq ?? null;
    checks.push({ step: "send", pass, status, ok: body.ok, seq: body.seq, echoQueued: body.echoQueued });
  } catch (e) { checks.push({ step: "send", pass: false, error: String(e.message) }); }

  // 4. poll -> expect echo of our sent message
  try {
    const { status, body } = await httpJson(base, `/poll?since=${latestSeq}`, {});
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const echo = msgs.find((m) => m.dir === "in" && m.text.includes(`received: "${marker}"`));
    const pass = status === 200 && Boolean(echo);
    latestSeq = Number(body.latestSeq ?? latestSeq);
    checks.push({ step: "poll-echo", pass, status, messageCount: msgs.length, sawEcho: Boolean(echo) });
  } catch (e) { checks.push({ step: "poll-echo", pass: false, error: String(e.message) }); }

  // 5. inbound
  try {
    const { status, body } = await httpJson(base, "/inbound", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "c2c:qq-friend", message: `inbound-${marker}` }),
    });
    const pass = status === 200 && body.ok === true;
    checks.push({ step: "inbound", pass, status, ok: body.ok, seq: body.seq });
  } catch (e) { checks.push({ step: "inbound", pass: false, error: String(e.message) }); }

  // 6. poll -> expect inbound
  try {
    const { status, body } = await httpJson(base, `/poll?since=${latestSeq}`, {});
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const found = msgs.find((m) => m.dir === "in" && m.text === `inbound-${marker}`);
    const pass = status === 200 && Boolean(found);
    latestSeq = Number(body.latestSeq ?? latestSeq);
    checks.push({ step: "poll-inbound", pass, status, sawInbound: Boolean(found) });
  } catch (e) { checks.push({ step: "poll-inbound", pass: false, error: String(e.message) }); }

  // 7. error case: send with empty message must fail
  try {
    const { status, body } = await httpJson(base, "/send", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "c2c:x", message: "   " }),
    });
    const pass = status === 400 && body.ok === false;
    checks.push({ step: "send-error", pass, status, ok: body.ok, error: body.error });
  } catch (e) { checks.push({ step: "send-error", pass: false, error: String(e.message) }); }

  const roundPass = checks.every((c) => c.pass);
  return { round, marker, pass: roundPass, checks };
}

async function probePlugin(base) {
  // Exercise the DSH-installed plugin's in-process HTTP routes (same protocol).
  const out = { reachable: false, checks: [] };
  try {
    const h = await httpJson(base, "/plugins/dsh-qqbot-bridge/bridge/health", {});
    out.reachable = h.status === 200 && h.body.ok === true;
    out.checks.push({ step: "plugin-health", pass: out.reachable, status: h.status });
  } catch (e) { out.checks.push({ step: "plugin-health", pass: false, error: String(e.message) }); }
  if (out.reachable) {
    let latest = 0;
    try {
      const s = await httpJson(base, "/plugins/dsh-qqbot-bridge/bridge/status", {});
      latest = Number(s.body.seq ?? 0);
      out.checks.push({ step: "plugin-status", pass: s.status === 200 && s.body.connected === true, connected: s.body.connected });
    } catch (e) { out.checks.push({ step: "plugin-status", pass: false, error: String(e.message) }); }
    try {
      const m = `plugin-probe-${Date.now() % 100000}`;
      const s = await httpJson(base, "/plugins/dsh-qqbot-bridge/bridge/send", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "c2c:plugin-user", message: m }),
      });
      out.checks.push({ step: "plugin-send", pass: s.status === 200 && s.body.ok === true, ok: s.body.ok });
      const p = await httpJson(base, `/plugins/dsh-qqbot-bridge/bridge/poll?since=${latest}`, {});
      const msgs = Array.isArray(p.body.messages) ? p.body.messages : [];
      const saw = msgs.find((x) => x.text.includes(`received: "${m}"`));
      out.checks.push({ step: "plugin-poll-echo", pass: p.status === 200 && Boolean(saw), sawEcho: Boolean(saw) });
    } catch (e) { out.checks.push({ step: "plugin-send/poll", pass: false, error: String(e.message) }); }
  }
  out.pass = out.checks.every((c) => c.pass);
  return out;
}

async function main() {
  const bridge = startBridge(ARGS.port);
  const up = await bridge.ready();
  if (!up) {
    log(`FATAL: bridge did not become ready on port ${ARGS.port}\n${bridge.dump()}`);
    bridge.stop();
    process.exit(3);
  }
  log(`bridge ready on ${bridge.base}`);

  const results = { startedAt: new Date().toISOString(), rounds: [], plugin: null, bridgeLog: "" };
  let allPass = true;

  for (let r = 1; r <= ARGS.rounds; r++) {
    const res = await runRound(r, bridge.base);
    results.rounds.push({ round: res.round, pass: res.pass, marker: res.marker, summary: res.checks.map((c) => `${c.step}:${c.pass ? "ok" : "FAIL"}`).join(", ") });
    allPass = allPass && res.pass;
    log(`round ${r}: ${res.pass ? "PASS" : "FAIL"} — ${results.rounds.at(-1).summary}`);
  }

  if (ARGS.usePlugin) {
    results.plugin = await probePlugin(ARGS.pluginBase);
    log(`plugin routes: ${results.plugin.reachable ? "reachable" : "NOT reachable"} — ${results.plugin.checks.map((c) => `${c.step}:${c.pass ? "ok" : "FAIL"}`).join(", ")}`);
    // Plugin reachability is a bonus; the core gate is the 12 bridge rounds.
  }

  results.finishedAt = new Date().toISOString();
  results.bridgeRoundsPassed = results.rounds.filter((r) => r.pass).length;
  results.bridgeRoundsTotal = results.rounds.length;
  results.allBridgePass = allPass;
  results.verdict = allPass ? "PASS" : "FAIL";
  results.bridgeLog = bridge.dump();

  try { writeFileSync(RES_PATH, JSON.stringify(results, null, 2) + "\n"); } catch (e) { log("WARN could not write results: " + e.message); }
  bridge.stop();

  log(`verdict: ${results.verdict} (${results.bridgeRoundsPassed}/${results.bridgeRoundsTotal} bridge rounds passed)`);
  process.exit(results.verdict === "PASS" ? 0 : 1);
}

main().catch((e) => { log("FATAL " + (e.stack || e)); process.exit(2); });
