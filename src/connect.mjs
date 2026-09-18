#!/usr/bin/env node
/**
 * PerkOS Grok Plugin — guest desk worker.
 * 4-line paste or env → outbound WS → heartbeat ready → handle /task.
 * Works on the desk (names, angles, challenges). Risk owns VERDICT. Zero spend.
 * Never commit secrets.
 */
import { readFileSync, existsSync } from "node:fs";
import process from "node:process";
import WebSocket from "ws";

const HEARTBEAT_MS = 15_000;

function usage() {
  console.error(`Usage:
  node src/connect.mjs [invite.txt]
  # or: PERKOS_AGENT_NAME=… PERKOS_RELAY_KEY=… PERKOS_RELAY_URL=… npm start

Paste (4 lines):
  github.com/PerkOS-xyz/PerkOS-Grok-Plugin
  PERKOS_AGENT_NAME=<name>
  PERKOS_RELAY_KEY=<key>
  PERKOS_RELAY_URL=wss://transport.perkos.xyz/a2a
`);
}

function parseInvite(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  let agentName = process.env.PERKOS_AGENT_NAME || "";
  let relayKey = process.env.PERKOS_RELAY_KEY || "";
  let relayUrl = process.env.PERKOS_RELAY_URL || "";
  let repo = "";

  for (const line of lines) {
    if (/^PERKOS_AGENT_NAME=/i.test(line)) {
      agentName = line.split("=").slice(1).join("=").trim();
    } else if (/^PERKOS_RELAY_KEY=/i.test(line)) {
      relayKey = line.split("=").slice(1).join("=").trim();
    } else if (/^PERKOS_RELAY_URL=/i.test(line)) {
      relayUrl = line.split("=").slice(1).join("=").trim();
    } else if (/github\.com\//i.test(line) || /^https?:\/\//i.test(line)) {
      repo = line;
    } else if (!agentName && !line.includes("=") && !/^wss:/i.test(line)) {
      agentName = line;
    } else if (!relayKey && !/^wss:/i.test(line) && line.length > 16) {
      relayKey = line;
    } else if (!relayUrl && /^wss:\/\//i.test(line)) {
      relayUrl = line;
    }
  }

  if (!relayUrl) relayUrl = "wss://transport.perkos.xyz/a2a";
  if (!agentName || !relayKey || !relayUrl) {
    throw new Error(
      "Need PERKOS_AGENT_NAME, PERKOS_RELAY_KEY, PERKOS_RELAY_URL (4-line paste or env)"
    );
  }
  return { repo, agentName, relayKey, relayUrl };
}

async function readInvite() {
  const pathArg = process.argv[2];
  if (pathArg) {
    if (!existsSync(pathArg)) throw new Error(`File not found: ${pathArg}`);
    return readFileSync(pathArg, "utf8");
  }
  if (
    process.env.PERKOS_AGENT_NAME &&
    process.env.PERKOS_RELAY_KEY &&
    process.env.PERKOS_RELAY_URL
  ) {
    return [
      process.env.PERKOS_REPO || "github.com/PerkOS-xyz/PerkOS-Grok-Plugin",
      `PERKOS_AGENT_NAME=${process.env.PERKOS_AGENT_NAME}`,
      `PERKOS_RELAY_KEY=${process.env.PERKOS_RELAY_KEY}`,
      `PERKOS_RELAY_URL=${process.env.PERKOS_RELAY_URL}`,
    ].join("\n");
  }
  if (process.stdin.isTTY) {
    usage();
    console.error("Paste 4 lines, then Ctrl-D:");
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function draftReply(task) {
  const text =
    typeof task === "string"
      ? task
      : task?.text || task?.prompt || task?.message || JSON.stringify(task);
  const clipped = String(text).slice(0, 280);
  return (
    `@Sparky On the desk: concrete angle on — ${clipped || "the open ask"}. ` +
    `I will bring names and a sharper challenge; Risk keeps VERDICT; you Hold. ` +
    `Draft only — zero spend.`
  );
}

function isSpendy(s) {
  return /\b(swap|launch|claim|1claw|bankr|sign tx|executable size|buy \$\d|spend)\b/i.test(
    s
  );
}

function connect({ agentName, relayKey, relayUrl }) {
  console.log(`[perkos-grok] connecting as ${agentName} → ${relayUrl}`);

  const ws = new WebSocket(relayUrl, {
    headers: {
      Authorization: `Bearer ${relayKey}`,
      "X-PerkOS-Agent": agentName,
    },
  });

  let heartbeat = null;
  let ready = false;

  const send = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  const markReady = () => {
    ready = true;
    send({
      type: "heartbeat",
      status: "ready",
      agent: agentName,
      v: 1,
      ts: Date.now(),
    });
    console.log("[perkos-grok] heartbeat ready — Floor may POST /agents/:id/task");
  };

  const cleanup = (exit = true) => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    if (exit) process.exit(0);
  };

  ws.on("open", () => {
    send({
      type: "hello",
      agent: agentName,
      runtime: "grok-bot",
      role: "guest",
      capabilities: ["draft", "research", "names", "challenge"],
      spend: false,
      v: 1,
    });
    markReady();
    heartbeat = setInterval(markReady, HEARTBEAT_MS);
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      console.warn("[perkos-grok] non-JSON frame ignored");
      return;
    }

    const kind = msg.type || msg.event || msg.op || "";
    if (/sleep|hibernate|stop|disconnect/i.test(kind)) {
      console.log("[perkos-grok] sleep — closing");
      cleanup();
      return;
    }

    if (/task|prompt|desk/i.test(kind) || msg.task || msg.prompt) {
      const payload = msg.task || msg.prompt || msg.text || msg;
      let reply = draftReply(payload);
      if (isSpendy(reply)) {
        reply =
          "@Sparky Draft/name/challenge only. Risk owns VERDICT; human Holds. Zero spend.";
      }
      send({
        type: "task_response",
        agent: agentName,
        guest: "grok-bot",
        ok: true,
        reply,
        spend: false,
        v: 1,
        taskId: msg.taskId || msg.id || null,
        ms: 0,
      });
      console.log("[perkos-grok] drafted desk reply");
    }
  });

  ws.on("error", (err) => {
    console.error("[perkos-grok] ws error:", err.message);
  });

  ws.on("close", (code, reason) => {
    console.log(
      `[perkos-grok] closed ${code} ${reason?.toString?.() || ""} readyWas=${ready}`
    );
    cleanup(false);
  });

  process.on("SIGINT", () => cleanup());
  process.on("SIGTERM", () => cleanup());
}

const raw = await readInvite();
const cfg = parseInvite(raw);
console.log(
  `[perkos-grok] agent=${cfg.agentName} url=${cfg.relayUrl} (key redacted)`
);
connect(cfg);
