/**
 * One live seat on the PerkOS bus per guest agent.
 *
 * The bot cannot hold a socket open: its computer session ends and the process
 * dies with it. So this server holds the seat instead. It registers on the
 * relay with the agent's own credential, keeps the platform heartbeat alive so
 * the desk sees the guest as ready, parks incoming tasks in a queue, and sends
 * the draft back when the bot comes around to answer.
 *
 * The bot pulls. The desk pushes. This is the place where those two meet.
 */

import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";

const RELAY_HEARTBEAT_MS = 30_000;   // the relay drops a silent agent after 90s
// Every platform heartbeat is a write on the desk's database, so a seat nobody
// is using has to go. 60s matches the house bridges and the 90s freshness the
// app expects; the saving comes from releasing the seat quickly, not from
// beating slower and looking offline.
const API_HEARTBEAT_MS = Number(process.env.PERKOS_HEARTBEAT_MS || 60_000);
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const QUEUE_MAX = 20;
const TASK_TTL_MS = 60 * 60_000;     // an hour old is stale; the desk moved on
const IDLE_EVICT_MS = Number(process.env.PERKOS_IDLE_EVICT_MS || 15 * 60_000); // three missed pulls and the seat goes
const DRAFT_KEEP = 20;               // recent drafts kept for the app to read back

const log = (...a) => console.log("[perkos-guest-mcp]", ...a);
const warn = (...a) => console.warn("[perkos-guest-mcp]", ...a);

/** Pull the prompt out of the A2A message envelope the platform sends. */
function promptFrom(payload) {
  const parts = Array.isArray(payload?.message?.parts) ? payload.message.parts : [];
  const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n").trim();
  if (text) return text;
  for (const k of ["text", "prompt", "content"]) {
    if (typeof payload?.[k] === "string" && payload[k].trim()) return payload[k].trim();
  }
  return "";
}

export class AgentLink {
  constructor({ agentName, agentId, relayKey, relayUrl, apiUrl, version }) {
    this.agentName = agentName;
    this.agentId = agentId;
    this.relayKey = relayKey;
    this.relayUrl = relayUrl;
    this.apiUrl = apiUrl;
    this.version = version;
    this.ws = null;
    this.registered = false;
    this.ready = null;          // last platform heartbeat outcome
    this.queue = [];            // tasks waiting for the bot
    this.drafts = [];           // what the bot answered, so Floor can read it back
    this.identity = null;       // how the bot wants to be seen on the desk
    this.answered = new Map();  // taskId -> when, so a late double submit is caught
    this.backoff = BACKOFF_MIN_MS;
    this.closed = false;
    this.lastPullMs = Date.now();
    this.relayTimer = null;
    this.apiTimer = null;
    this.connect();
  }

  frame(type, extra = {}) {
    return JSON.stringify({
      type,
      id: extra.id || randomUUID(),
      from: this.agentName,
      payload: {},
      timestamp: new Date().toISOString(),
      ...extra
    });
  }

  async apiHeartbeat() {
    if (!this.agentId) return;
    try {
      const res = await fetch(`${this.apiUrl}/agents/${encodeURIComponent(this.agentId)}/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.relayKey}` },
        body: JSON.stringify({ runtimeKind: "custom", version: this.version, ts: Date.now(), runtimeStatus: "healthy" }),
        signal: AbortSignal.timeout(10_000)
      });
      if (res.ok !== this.ready) {
        this.ready = res.ok;
        log(res.ok ? `${this.agentName}: the desk sees this guest as ready` : `${this.agentName}: platform heartbeat refused with ${res.status}`);
      }
    } catch (err) {
      if (this.ready !== false) { this.ready = false; warn(`${this.agentName}: platform heartbeat failed: ${err.message}`); }
    }
  }

  startTimers() {
    if (!this.relayTimer) {
      this.relayTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(this.frame("heartbeat"));
      }, RELAY_HEARTBEAT_MS);
    }
    if (!this.apiTimer) {
      void this.apiHeartbeat();
      this.apiTimer = setInterval(() => void this.apiHeartbeat(), API_HEARTBEAT_MS);
    }
  }

  stopTimers() {
    if (this.relayTimer) clearInterval(this.relayTimer);
    if (this.apiTimer) clearInterval(this.apiTimer);
    this.relayTimer = null;
    this.apiTimer = null;
  }

  connect() {
    if (this.closed) return;
    this.ws = new WebSocket(this.relayUrl);

    this.ws.on("open", () => {
      this.registered = false;
      this.ws.send(this.frame("register", {
        payload: {
          agentName: this.agentName,
          apiKey: this.relayKey,
          // The card is how the desk learns who showed up: the name the bot
          // chose and the face it picked, not just an agent id.
          card: { name: this.displayName(), role: "guest", runtime: "grok-bot", version: this.version, ...(this.identity ? { identity: this.identity } : {}) }
        }
      }));
    });

    this.ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "register_ack") {
        this.registered = true;
        this.backoff = BACKOFF_MIN_MS;
        log(`${this.agentName}: registered on the relay`);
        this.startTimers();
        return;
      }
      if (msg.type === "task") {
        this.enqueue(msg);
        return;
      }
      if (msg.type === "error") {
        warn(`${this.agentName}: relay error ${msg.payload?.code || "unknown"} ${msg.payload?.message || ""}`.trim());
      }
    });

    this.ws.on("close", (code) => {
      this.stopTimers();
      this.registered = false;
      if (this.closed) return;
      if (code === 1008) { warn(`${this.agentName}: the relay did not approve this agent; the invite is stale`); this.closed = true; return; }
      const wait = Math.min(this.backoff, BACKOFF_MAX_MS) + Math.floor(Math.random() * 500);
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
      setTimeout(() => this.connect(), wait);
    });

    this.ws.on("error", (err) => warn(`${this.agentName}: socket error ${err.message}`));
  }

  /** Trabajo que no viene de la mesa: lo pide la persona desde Settings para
   *  que el bot se presente. Se responde aqui mismo, no al relay. */
  nudge(text) {
    const id = `sync_${randomUUID()}`;
    this.queue.push({ id, from: "__local__", text, receivedMs: Date.now(), local: true });
    while (this.queue.length > QUEUE_MAX) this.queue.shift();
    log(`${this.agentName}: sync asked (${this.queue.length} waiting)`);
    return id;
  }

  enqueue(msg) {
    const text = promptFrom(msg.payload);
    if (!text) return;
    this.queue.push({ id: msg.id, from: msg.from, text, receivedMs: Date.now() });
    // A guest that has been away for hours should answer the last thing asked,
    // not work through a backlog nobody is waiting for any more.
    while (this.queue.length > QUEUE_MAX) this.queue.shift();
    log(`${this.agentName}: task ${String(msg.id).slice(0, 8)} queued (${this.queue.length} waiting)`);
  }

  /** Oldest task still worth answering, or null. */
  take() {
    this.lastPullMs = Date.now();
    const now = Date.now();
    while (this.queue.length) {
      const task = this.queue.shift();
      if (now - task.receivedMs > TASK_TTL_MS) continue;
      this.pending = task;
      return task;
    }
    return null;
  }

  peekCount() {
    const now = Date.now();
    return this.queue.filter((t) => now - t.receivedMs <= TASK_TTL_MS).length;
  }

  submit(taskId, text, targetHint) {
    if (this.answered.has(taskId)) return { ok: false, detail: "that task was already answered" };
    if (this.ws?.readyState !== WebSocket.OPEN) return { ok: false, detail: "not connected to the relay right now, try again in a minute" };
    const to = targetHint || this.pending?.from;
    if (to === "__local__") {
      // Era una petición de la persona, no de la mesa: no hay a quien devolverla.
      this.answered.set(taskId, Date.now());
      this.drafts.unshift({ taskId, text, askedAt: this.pending?.receivedMs ?? null, answeredAt: Date.now(), late: false, local: true });
      this.drafts = this.drafts.slice(0, DRAFT_KEEP);
      return { ok: true };
    }
    if (!to) return { ok: false, detail: "unknown task, ask for the next task first" };
    this.ws.send(JSON.stringify({
      type: "task_response",
      id: taskId,
      from: this.agentName,
      to,
      payload: { text, role: "guest", agentName: this.agentName },
      timestamp: new Date().toISOString()
    }));
    this.answered.set(taskId, Date.now());
    // The desk only waits about forty seconds for a live reply, and a bot on a
    // five minute routine answers long after that, so the draft is kept here
    // too. Floor reads it back and shows it as what it is: a late addition.
    this.drafts.unshift({ taskId, text, askedAt: this.pending?.receivedMs ?? null, answeredAt: Date.now(), late: Date.now() - (this.pending?.receivedMs ?? Date.now()) > 40_000 });
    this.drafts = this.drafts.slice(0, DRAFT_KEEP);
    log(`${this.agentName}: draft sent for ${String(taskId).slice(0, 8)}`);
    return { ok: true };
  }

  displayName() { return this.identity?.displayName || this.agentName; }

  /** The bot says who it is. Kept small on purpose: a name and a face. */
  setIdentity(input) {
    const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const name = clean(input.displayName, 32);
    const accent = /^#[0-9a-fA-F]{6}$/.test(String(input.accent || "")) ? String(input.accent) : "";
    const pick = (v, list) => (list.includes(String(v)) ? String(v) : "");
    // La forma la elige el bot: cuatro siluetas distintas para que dos
    // invitados no se confundan de un vistazo. La del kit de casa no esta
    // aqui a proposito: un invitado no debe parecer plantilla.
    const style = pick(input.style, ["blob", "pebble", "drop", "chip"]);
    const head = pick(input.head, ["head-01", "head-02", "head-03", "head-04", "head-05"]);
    const visor = pick(input.visor, ["visor-01", "visor-02", "visor-03", "visor-04"]);
    const pattern = pick(input.pattern, ["pattern-01", "pattern-02", "pattern-03", "pattern-04", "pattern-05"]);
    this.identity = {
      ...(name ? { displayName: name } : {}),
      ...(accent ? { accent } : {}),
      ...(style ? { style } : {}),
      ...(head ? { head } : {}),
      ...(visor ? { visor } : {}),
      ...(pattern ? { pattern } : {}),
      setAt: Date.now()
    };
    // Re-register so the relay and the desk pick the new card up now, not on
    // the next reconnect.
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(this.frame("register", {
        payload: { agentName: this.agentName, apiKey: this.relayKey, card: { name: this.displayName(), role: "guest", runtime: "grok-bot", version: this.version, identity: this.identity } }
      }));
    }
    return this.identity;
  }

  status() {
    return {
      agent: this.agentName,
      connected: this.registered,
      readyOnDesk: this.ready === true,
      waiting: this.peekCount(),
      displayName: this.displayName(),
      identity: this.identity
    };
  }

  recentDrafts(sinceMs = 0) {
    return this.drafts.filter((d) => d.answeredAt > sinceMs);
  }

  close() {
    this.closed = true;
    this.stopTimers();
    try { this.ws?.close(1000, "seat released"); } catch { /* already gone */ }
  }
}

/** One link per agent name, kept warm between pulls and evicted when idle. */
export class LinkRegistry {
  constructor(defaults) {
    this.defaults = defaults;
    this.links = new Map();
    setInterval(() => this.evictIdle(), 5 * 60_000).unref?.();
  }

  /** Read-only: never brings a seat to life. A status page asking who is there
   *  must not be what makes the desk believe a bot arrived. */
  peek(agentName) {
    const link = this.links.get(agentName);
    return link && !link.closed ? link : null;
  }

  get({ agentName, agentId, relayKey }) {
    const existing = this.links.get(agentName);
    if (existing && existing.relayKey === relayKey && !existing.closed) {
      existing.lastPullMs = Date.now();
      return existing;
    }
    if (existing) existing.close();
    const link = new AgentLink({ agentName, agentId, relayKey, ...this.defaults });
    this.links.set(agentName, link);
    return link;
  }

  /** Que siluetas ya ocupan otros invitados, para no repetir. */
  stylesInUse(exceptAgent) {
    const out = [];
    for (const [name, link] of this.links) {
      if (name === exceptAgent) continue;
      const st = link.identity?.style;
      if (st && !out.includes(st)) out.push(st);
    }
    return out;
  }

  evictIdle() {
    const now = Date.now();
    for (const [name, link] of this.links) {
      if (now - link.lastPullMs > IDLE_EVICT_MS) {
        log(`${name}: no pull in ${Math.round(IDLE_EVICT_MS / 60_000)} minutes, releasing the seat`);
        link.close();
        this.links.delete(name);
      }
    }
  }

  get size() { return this.links.size; }
}
