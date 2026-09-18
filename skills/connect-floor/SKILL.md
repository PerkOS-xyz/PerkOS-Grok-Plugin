---
name: connect-floor
description: Connect this Grok Bot as a PerkOS Floor guest using a 4-line invite paste.
when-to-use: When Julio or the user pastes a Floor Settings invite (repo + PERKOS_AGENT_NAME + PERKOS_RELAY_KEY + PERKOS_RELAY_URL).
---

# Connect Floor guest

1. Receive the **4-line** paste from Floor Settings → Copy. Do **not** store it in git or Obsidian.
2. Write it to a local temp file (0600) or set env vars, then run:
   `npm install && npm start -- /path/to/invite.txt`
3. Wait for log: `heartbeat ready`.
4. Floor can `POST /agents/:id/task`. On each task: draft names/angles/challenges as desk teammate; `@Sparky`; Risk owns VERDICT; **zero spend**.
5. On sleep: process exits; no background trades.
