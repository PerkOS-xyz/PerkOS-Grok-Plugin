#!/usr/bin/env node
/**
 * PerkOS Floor guest client for Grok Bot.
 *
 * Reads the invite the owner copies out of Floor Settings, connects OUTBOUND to
 * the PerkOS relay and answers desk tasks. Floor never calls the Bot.
 *
 *   invite → wss://transport.perkos.xyz/a2a → register → ready → task
 *
 * Two heartbeats, and both are needed. The relay one keeps the socket in the
 * registry (it drops an agent after 90s of silence). The API one is what flips
 * the agent from `invited` to `ready`, and Floor refuses to send a task to an
 * agent that is not ready, so without it the desk stays dark no matter how
 * healthy the socket is.
 *
 * Frame names are not a guess: they are what the relay accepts
 * (PerkOS-Transport/src/server.mjs) and what the platform sends
 * (PerkOS-API/src/services/agentProbe.ts).
 */

import { WebSocket } from "ws";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync as read } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const VERSION = "1.1.0";
const RELAY_HEARTBEAT_MS = 30_000;   // relay drops an agent after 90s of silence
const API_HEARTBEAT_MS = 60_000;     // keeps the agent `ready` on the platform
const TASK_TIMEOUT_MS = 45_000;      // how long we wait for the Bot to draft
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

const GUEST_LAW = [
  "You are a guest agent on a PerkOS Floor desk that trades tokenized stocks on Base.",
  "House agents: Scout researches, Risk sizes and owns the VERDICT, Trader drafts orders, Auditor reconciles.",
  "You draft only. Never spend, swap, launch, claim, sign, size an order or issue a VERDICT.",
  "Answer @Sparky in English, under 90 words: one useful angle, challenge or piece of research.",
  "Cite any [F#] or [N] reference you were given. Say plainly when you do not know."
].join(" ");

const SPEND_SHAPED = [
  /\bspend\b/i, /\bswap\b/i, /\blaunch\b/i, /\bclaim\b/i, /1claw/i, /bankr/i,
  /\bsign\b/i, /executable.?size/i, /\bverdict\b/i, /\btransfer\b/i
];

const log = (...a) => console.log("[perkos-guest]", ...a);
const warn = (...a) => console.warn("[perkos-guest]", ...a);

/* ---------------------------------------------------------------- invite -- */

/**
 * Accepts the KEY=value block Floor copies today and the older bare 4-line
 * paste, because invites already handed out are still in people's clipboards.
 */
export function parseInvite(raw) {
  const lines = String(raw).trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const kv = Object.fromEntries(
    lines.filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).trim()];
    })
  );
  const bare = lines.filter((l) => !/^[A-Z_]+=/.test(l));
  const agentName = kv.PERKOS_AGENT_NAME || (bare.length >= 4 ? bare[1] : "");
  const relayKey = kv.PERKOS_RELAY_KEY || kv.PERKOS_RELAY_API_KEY || (bare.length >= 4 ? bare[2] : "");
  const relayUrl = kv.PERKOS_RELAY_URL || lines.find((l) => l.includes("wss://"))?.match(/wss:\/\/\S+/)?.[0] || "";
  const agentId = kv.PERKOS_AGENT_ID || "";
  const apiUrl = (kv.PERKOS_API_URL || "https://api.perkos.xyz").replace(/\/+$/, "");
  if (!agentName || !relayKey || !relayUrl.startsWith("wss://")) {
    throw new Error("Invite needs PERKOS_AGENT_NAME, PERKOS_RELAY_KEY and a wss:// PERKOS_RELAY_URL");
  }
  return { agentName, relayKey, relayUrl, agentId, apiUrl };
}

async function readInvite() {
  if (process.env.PERKOS_GUEST_INVITE) return process.env.PERKOS_GUEST_INVITE;
  const fileArg = process.argv[2] || process.env.PERKOS_GUEST_INVITE_FILE;
  if (fileArg) {
    if (!existsSync(fileArg)) throw new Error(`Invite file not found: ${fileArg}`);
    return readFileSync(fileArg, "utf8");
  }
  if (process.stdin.isTTY) console.log("Paste the invite from Floor Settings, then Ctrl+D:");
  return new Promise((resolve, reject) => {
    let data = "";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => { data += `${line}\n`; });
    rl.on("close", () => resolve(data));
    rl.on("error", reject);
  });
}

/* ----------------------------------------------------------------- brain -- */

function runCommand(cmd, prompt) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, TASK_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
    child.on("error", (err) => { clearTimeout(timer); warn(`reply command failed: ${err.message}`); resolve(""); });
    child.stdin.end(prompt);
  });
}

async function askXai(prompt) {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) return "";
  const model = process.env.PERKOS_GUEST_MODEL || "grok-4-fast";
  try {
    const res = await fetch(`${(process.env.XAI_API_URL || "https://api.x.ai/v1").replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        messages: [{ role: "system", content: GUEST_LAW }, { role: "user", content: prompt }]
      }),
      signal: AbortSignal.timeout(TASK_TIMEOUT_MS)
    });
    if (!res.ok) { warn(`xAI ${res.status} on model ${model}`); return ""; }
    const body = await res.json();
    return String(body?.choices?.[0]?.message?.content ?? "").trim();
  } catch (err) {
    warn(`xAI call failed: ${err.message}`);
    return "";
  }
}

/**
 * Folder handoff, for a Bot that would rather read and write files than have a
 * process call a model on its behalf: the task lands in inbox/<id>.md and the
 * Bot writes its answer to outbox/<id>.md.
 */
async function askFolder(dir, taskId, prompt) {
  const inbox = join(dir, "inbox");
  const outbox = join(dir, "outbox");
  mkdirSync(inbox, { recursive: true });
  mkdirSync(outbox, { recursive: true });
  writeFileSync(join(inbox, `${taskId}.md`), `${prompt}\n`, { mode: 0o600 });
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const hit = readdirSync(outbox).find((f) => f === `${taskId}.md`);
    if (hit) return read(join(outbox, hit), "utf8").trim();
    await new Promise((r) => setTimeout(r, 750));
  }
  return "";
}

async function draft(taskId, prompt) {
  if (SPEND_SHAPED.some((p) => p.test(prompt))) {
    return "@Sparky I am a guest here, so I draft and challenge only. Risk owns the VERDICT and the human holds to sign, so this one is theirs to act on. Happy to pressure test the reasoning behind it.";
  }
  if (process.env.PERKOS_GUEST_REPLY_CMD) {
    const out = await runCommand(process.env.PERKOS_GUEST_REPLY_CMD, `${GUEST_LAW}\n\n---\n\n${prompt}`);
    if (out) return out;
  }
  if (process.env.PERKOS_GUEST_DIR) {
    const out = await askFolder(process.env.PERKOS_GUEST_DIR, taskId, prompt);
    if (out) return out;
  }
  const xai = await askXai(prompt);
  if (xai) return xai;
  return "@Sparky I am connected to the desk but no runtime is wired to me yet, so I have nothing worth adding on this turn. Set a reply command, a shared folder or an xAI key and I will draft on the next one.";
}

/* ----------------------------------------------------------------- task --- */

/** The platform sends an A2A message envelope; the text lives in its parts. */
export function promptFromTask(payload) {
  const message = payload?.message;
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const text = parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (text) return text;
  for (const k of ["text", "prompt", "content"]) {
    if (typeof payload?.[k] === "string" && payload[k].trim()) return payload[k].trim();
  }
  return "";
}

/* ---------------------------------------------------------------- client -- */

function client(invite) {
  const { agentName, relayKey, relayUrl, agentId, apiUrl } = invite;
  let ws = null;
  let relayTimer = null;
  let apiTimer = null;
  let backoff = BACKOFF_MIN_MS;
  let stopping = false;
  let registered = false;
  let lastApiOk = null;

  const frame = (type, extra = {}) => JSON.stringify({
    type,
    id: extra.id || randomUUID(),
    from: agentName,
    payload: {},
    timestamp: new Date().toISOString(),
    ...extra
  });

  async function apiHeartbeat() {
    if (!agentId) return;
    try {
      const res = await fetch(`${apiUrl}/agents/${encodeURIComponent(agentId)}/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${relayKey}` },
        body: JSON.stringify({ runtimeKind: "custom", version: VERSION, ts: Date.now(), runtimeStatus: "healthy" }),
        signal: AbortSignal.timeout(10_000)
      });
      const ok = res.ok;
      if (ok !== lastApiOk) {
        lastApiOk = ok;
        if (ok) log("the desk sees this guest as ready");
        else warn(`platform heartbeat refused with ${res.status}; Floor will keep showing this guest as invited`);
      }
    } catch (err) {
      if (lastApiOk !== false) { lastApiOk = false; warn(`platform heartbeat failed: ${err.message}`); }
    }
  }

  function startHeartbeats() {
    if (!relayTimer) relayTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(frame("heartbeat"));
    }, RELAY_HEARTBEAT_MS);
    if (!apiTimer) {
      void apiHeartbeat();
      apiTimer = setInterval(() => void apiHeartbeat(), API_HEARTBEAT_MS);
    }
  }

  function stopHeartbeats() {
    if (relayTimer) clearInterval(relayTimer);
    if (apiTimer) clearInterval(apiTimer);
    relayTimer = null;
    apiTimer = null;
  }

  async function onTask(msg) {
    const prompt = promptFromTask(msg.payload);
    log(`task ${String(msg.id).slice(0, 8)} from ${msg.from}`);
    const reply = prompt
      ? await draft(msg.id, prompt)
      : "@Sparky that task arrived without any text I can read, so there is nothing for me to work on.";
    if (ws?.readyState !== WebSocket.OPEN) { warn("socket closed before the reply went out"); return; }
    ws.send(JSON.stringify({
      type: "task_response",
      id: msg.id,
      from: agentName,
      to: msg.from,
      payload: { text: reply, role: "guest", agentName },
      timestamp: new Date().toISOString()
    }));
    log(`replied to ${String(msg.id).slice(0, 8)}`);
  }

  function connect() {
    if (stopping) return;
    log(`connecting ${agentName} to ${relayUrl}`);
    ws = new WebSocket(relayUrl);

    ws.on("open", () => {
      registered = false;
      // The relay authenticates on this frame, not on an Authorization header.
      ws.send(frame("register", {
        payload: {
          agentName,
          apiKey: relayKey,
          card: { name: agentName, role: "guest", runtime: "grok-bot", version: VERSION }
        }
      }));
    });

    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      switch (msg.type) {
        case "register_ack":
          registered = true;
          backoff = BACKOFF_MIN_MS;
          log("registered on the relay");
          startHeartbeats();
          if (!agentId) warn("no PERKOS_AGENT_ID in the invite: the socket is up but the desk cannot mark this guest ready. Copy the invite again from Floor Settings.");
          return;
        case "heartbeat_ack":
        case "task_response_ack":
        case "task_ack":
          return;
        case "task":
          void onTask(msg);
          return;
        case "error":
          warn(`relay error: ${msg.payload?.code || "unknown"} ${msg.payload?.message || ""}`.trim());
          return;
        default:
          return;
      }
    });

    ws.on("close", (code) => {
      stopHeartbeats();
      if (stopping) return;
      // 1008 is the relay refusing the identity: retrying the same key will not
      // fix it, so say what to do instead of looping quietly.
      if (code === 1008) { warn("the relay did not approve this agent. Check the invite is current and still belongs to this desk."); process.exit(1); }
      const wait = Math.min(backoff, BACKOFF_MAX_MS) + Math.floor(Math.random() * 500);
      log(`${registered ? "connection lost" : "could not register"}; retrying in ${Math.round(wait / 1000)}s`);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      setTimeout(connect, wait);
    });

    ws.on("error", (err) => warn(`socket error: ${err.message}`));
  }

  function shutdown(reason) {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${reason}`);
    stopHeartbeats();
    try { ws?.close(1000, "guest stopping"); } catch { /* already gone */ }
    setTimeout(() => process.exit(0), 250);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  connect();
}

async function main() {
  try {
    client(parseInvite(await readInvite()));
  } catch (err) {
    console.error("[perkos-guest]", err.message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  void main();
}
