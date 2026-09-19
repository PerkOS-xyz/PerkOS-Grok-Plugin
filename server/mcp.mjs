#!/usr/bin/env node
/**
 * PerkOS guest MCP server.
 *
 * A Grok Bot cannot be pushed to, and a process on its computer dies with the
 * session. So the bot pulls: a routine wakes every few minutes, asks for the
 * next task from its desk, drafts, and hands the draft back. This server holds
 * the seat on the bus in between (see relay.mjs) so the desk still sees a guest
 * that is ready and can still send it work.
 *
 * Auth is the agent's own PerkOS credential, the same one Floor hands the owner
 * in the invite:
 *
 *   Authorization: Bearer <relayApiKey>
 *   x-perkos-agent-name: <name>
 *   x-perkos-agent-id: <id>
 *
 * Shape follows JulioMCruz/obsidian-vault-mcp, which is already proven against
 * Grok Bot: streamable HTTP on /mcp, bearer auth, health endpoint, and the
 * protected-resource metadata a client asks for before it authenticates.
 */

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { LinkRegistry } from "./relay.mjs";

const VERSION = "1.2.0";
const PORT = Number(process.env.PORT || 8791);
const BIND = process.env.BIND || "0.0.0.0";
const PUBLIC_BASE = (process.env.PUBLIC_BASE || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const RELAY_URL = process.env.PERKOS_RELAY_URL || "wss://transport.perkos.xyz/a2a";
const API_URL = (process.env.PERKOS_API_URL || "https://api.perkos.xyz").replace(/\/+$/, "");

const registry = new LinkRegistry({ relayUrl: RELAY_URL, apiUrl: API_URL, version: VERSION });

const GUEST_LAW =
  "You are a guest on this desk. You draft only: never spend, swap, launch, claim, sign, size an order or issue a VERDICT. Risk owns the verdict and the person holds to approve.";

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function unauthorized(res, reason) {
  res.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": `Bearer realm="perkos-guest-mcp", error="invalid_token", error_description="${reason}"`
  });
  res.end(JSON.stringify({ error: "unauthorized", reason }));
}

/** The credential and the identity it belongs to, read off the request. */
function identity(req) {
  const raw = req.headers.authorization || "";
  const key = /^Bearer\s+/i.test(raw) ? raw.replace(/^Bearer\s+/i, "").trim() : String(req.headers["x-api-key"] || "").trim();
  if (!key) return { ok: false, reason: "no bearer token" };
  const agentName = String(req.headers["x-perkos-agent-name"] || "").trim();
  const agentId = String(req.headers["x-perkos-agent-id"] || "").trim();
  if (!agentName) return { ok: false, reason: "x-perkos-agent-name is required, it comes with the invite" };
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(agentName)) return { ok: false, reason: "agent name has characters that are not allowed" };
  return { ok: true, key, agentName, agentId };
}

function server(link) {
  const mcp = new McpServer({ name: "perkos-guest", version: VERSION });

  mcp.tool(
    "desk_status",
    "Check whether this bot's seat on its PerkOS desk is live and how many tasks are waiting. Call it first if you are unsure.",
    {},
    async () => {
      const s = link.status();
      return {
        content: [{
          type: "text",
          text: s.connected
            ? `Seat is live for ${s.agent}. The desk ${s.readyOnDesk ? "sees this guest as ready" : "has not confirmed ready yet"}. ${s.waiting} task${s.waiting === 1 ? "" : "s"} waiting.`
            : `Seat for ${s.agent} is connecting. Try again in a minute.`
        }]
      };
    }
  );

  mcp.tool(
    "next_task",
    "Take the next task the desk left for this bot. Returns the task id and what was asked, or says there is nothing to do. Answer it with submit_draft.",
    {},
    async () => {
      const task = link.take();
      if (!task) {
        return { content: [{ type: "text", text: "Nothing waiting. The desk has not asked this guest for anything since the last check." }] };
      }
      const waited = Math.round((Date.now() - task.receivedMs) / 1000);
      return {
        content: [{
          type: "text",
          text: [
            `task_id: ${task.id}`,
            `waiting_for: ${waited}s`,
            "",
            GUEST_LAW,
            "",
            "What the desk asked:",
            task.text,
            "",
            "Answer in under 90 words, addressed to @Sparky, then call submit_draft with this task_id."
          ].join("\n")
        }]
      };
    }
  );

  mcp.tool(
    "set_identity",
    "Tell the desk who you are: the name you want on your seat, and optionally the face. The desk always shows you as a Grok Bot guest; this only sets the name and the look.",
    {
      display_name: z.string().min(1).max(32),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      head: z.enum(["head-01", "head-02", "head-03", "head-04", "head-05"]).optional(),
      visor: z.enum(["visor-01", "visor-02", "visor-03", "visor-04"]).optional(),
      pattern: z.enum(["pattern-01", "pattern-02", "pattern-03", "pattern-04", "pattern-05"]).optional()
    },
    async ({ display_name, accent, head, visor, pattern }) => {
      const id = link.setIdentity({ displayName: display_name, accent, head, visor, pattern });
      return { content: [{ type: "text", text: `The desk will show you as ${id.displayName || link.agentName}, marked as a Grok Bot guest. Face: ${[id.head, id.visor, id.pattern].filter(Boolean).join(" ") || "default"}${id.accent ? `, accent ${id.accent}` : ""}.` }] };
    }
  );

  mcp.tool(
    "submit_draft",
    "Hand a draft back to the desk for a task you took with next_task. The draft reaches the desk as this guest's contribution. It is never executed.",
    { task_id: z.string().min(1), draft: z.string().min(1).max(4000) },
    async ({ task_id, draft }) => {
      const out = link.submit(task_id, draft);
      return {
        content: [{
          type: "text",
          text: out.ok
            ? "Sent. The desk has the draft. Nothing moves until the person approves it."
            : `Not sent: ${out.detail}`
        }],
        isError: !out.ok
      };
    }
  );

  return mcp;
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, X-Api-Key, x-perkos-agent-name, x-perkos-agent-id",
        "access-control-allow-methods": "GET, POST, OPTIONS, DELETE"
      });
      return res.end();
    }

    if (req.method === "GET" && (path === "/healthz" || path === "/health")) {
      return json(res, 200, {
        ok: true,
        service: "perkos-guest-mcp",
        version: VERSION,
        mcp: `${PUBLIC_BASE}/mcp`,
        relay: RELAY_URL,
        api: API_URL,
        seats: registry.size,
        auth: "bearer",
        tools: ["desk_status", "next_task", "submit_draft", "set_identity"],
        readback: `${PUBLIC_BASE}/drafts`,
        identity: `${PUBLIC_BASE}/identity`
      });
    }

    if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
      return json(res, 200, {
        resource: `${PUBLIC_BASE}/mcp`,
        authorization_servers: [],
        bearer_methods_supported: ["header"],
        resource_documentation: "https://github.com/PerkOS-xyz/PerkOS-Grok-Plugin"
      });
    }

    // Floor reads back what the guest answered after the turn had moved on.
    // Same credential as the tools, so no new surface to protect.
    // Who is sitting in this seat, for the app that draws the desk.
    if (req.method === "GET" && path === "/identity") {
      const who = identity(req);
      if (!who.ok) return unauthorized(res, who.reason);
      const link = registry.peek(who.agentName);
      return json(res, 200, {
        agent: who.agentName,
        runtime: "grok-bot",
        displayName: link ? link.displayName() : who.agentName,
        identity: link ? link.identity : null,
        status: link ? link.status() : { agent: who.agentName, connected: false, readyOnDesk: false, waiting: 0 }
      });
    }

    if (req.method === "GET" && path === "/drafts") {
      const who = identity(req);
      if (!who.ok) return unauthorized(res, who.reason);
      const link = registry.peek(who.agentName);
      const since = Number(url.searchParams.get("since") || 0);
      return json(res, 200, {
        agent: who.agentName,
        drafts: link ? link.recentDrafts(Number.isFinite(since) ? since : 0) : [],
        status: link ? link.status() : { agent: who.agentName, connected: false, readyOnDesk: false, waiting: 0 }
      });
    }

    if (path !== "/mcp" && path !== "/mcp/" && path !== "/") return json(res, 404, { error: "not_found", path });

    const who = identity(req);
    if (!who.ok) return unauthorized(res, who.reason);

    // The relay is the real authority on the credential: a wrong key fails the
    // register and the seat never goes live, which the tools report honestly.
    const link = registry.get({ agentName: who.agentName, agentId: who.agentId, relayKey: who.key });
    console.log(`[perkos-guest-mcp] mcp call from ${who.agentName}`);

    const mcp = server(link);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("[perkos-guest-mcp] request failed", err);
    if (!res.headersSent) json(res, 500, { error: "internal_error" });
  }
});

httpServer.listen(PORT, BIND, () => {
  console.log(`[perkos-guest-mcp] listening on http://${BIND}:${PORT}`);
  console.log(`[perkos-guest-mcp] mcp=${PUBLIC_BASE}/mcp relay=${RELAY_URL} api=${API_URL}`);
});
