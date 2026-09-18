#!/usr/bin/env node
/**
 * PerkOS Floor Grok Guest Client
 *
 * Reads a 4-line invite paste and connects outbound to Floor transport.
 * Guest role: research/challenge only. Never spends.
 */

import { WebSocket } from 'ws'
import { readFileSync, existsSync } from 'fs'
import { createInterface } from 'readline'

const HEARTBEAT_INTERVAL_MS = 15_000

function parseInvite(raw) {
  const lines = raw.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const kv = Object.fromEntries(
    lines.filter((l) => l.includes("=")).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    })
  );
  const repoUrl = kv.PERKOS_PLUGIN || lines.find((l) => l.includes("PerkOS-Grok-Plugin")) || lines[0];
  const agentName = kv.PERKOS_AGENT_NAME || (lines.length === 4 ? lines[1] : "");
  const relayKey = kv.PERKOS_RELAY_KEY || (lines.length === 4 ? lines[2] : "");
  const transportUrl = kv.PERKOS_RELAY_URL || lines.find((l) => l.startsWith("wss://")) || "";
  if (!agentName || !relayKey || !transportUrl.startsWith("wss://")) {
    throw new Error("Invite needs AGENT_NAME, RELAY_KEY, and wss:// URL");
  }
  return { repoUrl, agentName, relayKey, transportUrl };
}

async function readInvite() {
  if (process.env.PERKOS_GUEST_INVITE) {
    return process.env.PERKOS_GUEST_INVITE
  }

  const fileArg = process.argv[2]
  if (fileArg) {
    if (!existsSync(fileArg)) {
      throw new Error(`Invite file not found: ${fileArg}`)
    }
    return readFileSync(fileArg, 'utf-8')
  }

  if (process.stdin.isTTY) {
    console.log('Paste 4-line invite (Ctrl+D when done):')
  }

  return new Promise((resolve, reject) => {
    let data = ''
    const rl = createInterface({ input: process.stdin })
    rl.on('line', line => { data += line + '\n' })
    rl.on('close', () => resolve(data))
    rl.on('error', reject)
  })
}

function buildTaskReply(taskPayload) {
  const prompt = taskPayload?.prompt || taskPayload?.message || ''

  const spendPatterns = [
    /spend/i, /swap/i, /launch/i, /claim/i, /1claw/i, /bankr/i,
    /\bsign\b/i, /executable.?size/i, /\bverdict\b/i, /transfer/i
  ];

  for (const pattern of spendPatterns) {
    if (pattern.test(prompt)) {
      return `@Sparky I cannot action that request. As a guest, I'm here for research and challenge only — no spending, no VERDICT, no executable actions. Please route this to House Risk or confirm with the human holder.`
    }
  }

  return `@Sparky Draft: I'll add a useful angle (name, research, or a challenge). House Risk owns VERDICT. You hold to spend.`;
}

function connect(invite) {
  const { agentName, relayKey, transportUrl } = invite

  console.log(`[connect] Agent: ${agentName}`)
  console.log(`[connect] Transport: ${transportUrl}`)

  const ws = new WebSocket(transportUrl, {
    headers: {
      'Authorization': `Bearer ${relayKey}`
    }
  })

  let heartbeatTimer = null
  let ready = false

  function sendHeartbeat() {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'heartbeat', status: 'ready' }))
    }
  }

  function startHeartbeats() {
    if (heartbeatTimer) return
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
    console.log('[heartbeat] Started (every 15s)')
  }

  function stopHeartbeats() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
      console.log('[heartbeat] Stopped')
    }
  }

  function shutdown(reason) {
    console.log(`[shutdown] ${reason}`)
    stopHeartbeats()
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, reason)
    }
    process.exit(0)
  }

  ws.on('open', () => {
    console.log('[ws] Connected')
    ws.send(JSON.stringify({
      type: 'hello',
      agentName,
      ready: false
    }))
  })

  ws.on('message', (data) => {
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      console.log('[ws] Non-JSON message:', data.toString().slice(0, 100))
      return
    }

    console.log('[ws] Received:', msg.type || 'unknown')

    if (msg.type === 'welcome' || msg.type === 'ack') {
      if (!ready) {
        ready = true
        startHeartbeats()
        console.log('[status] Ready for tasks')
      }
      return
    }

    if (msg.type === 'task') {
      console.log('[task] Received task, preparing reply...')
      const reply = buildTaskReply(msg.payload || msg)
      ws.send(JSON.stringify({
        type: 'task_reply',
        taskId: msg.taskId || msg.id,
        reply
      }))
      console.log('[task] Reply sent')
      return
    }

    if (msg.type === 'sleep' || msg.type === 'hibernate') {
      shutdown(`Received ${msg.type} command`)
      return
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }))
      return
    }
  })

  ws.on('close', (code, reason) => {
    console.log(`[ws] Closed: ${code} ${reason}`)
    stopHeartbeats()
    process.exit(code === 1000 ? 0 : 1)
  })

  ws.on('error', (err) => {
    console.error('[ws] Error:', err.message)
  })

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

async function main() {
  try {
    const raw = await readInvite()
    const invite = parseInvite(raw)
    connect(invite)
  } catch (err) {
    console.error('[error]', err.message)
    process.exit(1)
  }
}

main()
