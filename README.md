# PerkOS Grok Plugin

Grok Bot on a **PerkOS Floor** desk: a teammate in the fifth seat, not a critic
on the side.

The owner opens Floor **Settings → Desk → Grok Bot → Invite my Grok Bot → Copy**
and pastes it once into their bot. This plugin connects **outbound**. Floor never
calls the bot, and the bot never holds a key to anything that spends.

```
Floor Settings Copy
  → paste into Grok Bot
  → this plugin
  → wss://transport.perkos.xyz/a2a      (register, then the desk can reach it)
  → POST api.perkos.xyz/agents/<id>/heartbeat   (what turns invited into ready)
  → Floor POST /agents/<id>/task
  → the bot drafts on the desk
```

## The paste

```
github.com/PerkOS-xyz/PerkOS-Grok-Plugin
PERKOS_AGENT_NAME=<name>
PERKOS_AGENT_ID=<id>
PERKOS_RELAY_KEY=<key>
PERKOS_RELAY_URL=wss://transport.perkos.xyz/a2a
PERKOS_API_URL=https://api.perkos.xyz
```

`PERKOS_AGENT_ID` is the one people miss. The relay connection alone does not
make a guest ready, and Floor refuses to send a task to an agent that is not
ready. The client warns in the log when the id is absent.

## Run it

```bash
npm install
node src/connect.mjs invite.txt     # or: PERKOS_GUEST_INVITE="…" npm start
```

```
[perkos-guest] connecting fgrok-… to wss://transport.perkos.xyz/a2a
[perkos-guest] registered on the relay
[perkos-guest] the desk sees this guest as ready
```

Keep the process alive. It is the connection, not a one shot call.

## Where the answer comes from

The client never invents a reply. Pick one:

| Setting | Behavior |
|---|---|
| `PERKOS_GUEST_DIR` | Task written to `inbox/<id>.md`, answer read from `outbox/<id>.md`, 45 second budget |
| `PERKOS_GUEST_REPLY_CMD` | Prompt on stdin, reply on stdout |
| `XAI_API_KEY` | Calls the xAI API, model from `PERKOS_GUEST_MODEL` |

With none of them set it answers honestly that no runtime is wired yet, which is
better than a canned line the desk would record as thinking.

## The guest law

Draft only. No spend, swap, launch, claim, sign or size. No VERDICT: Risk owns
it. The client also refuses spend shaped prompts before the bot sees them.

## Protocol, for reviewers

Frames match the relay in `PerkOS-Transport/src/server.mjs` and the sender in
`PerkOS-API/src/services/agentProbe.ts`:

| Direction | Frame |
|---|---|
| out | `register` with `payload.agentName` and `payload.apiKey`, answered by `register_ack` |
| out | `heartbeat` every 30s, answered by `heartbeat_ack` (the relay drops a silent agent after 90s) |
| in | `task` with `payload.message.parts[].text` |
| out | `task_response` with the same `id`, `to` the sender, and the text in `payload` |

Skills: [connect-floor](skills/connect-floor/SKILL.md) ·
[desk-task](skills/desk-task/SKILL.md) ·
[sleep-floor](skills/sleep-floor/SKILL.md). Install notes:
[docs/INSTALL.md](docs/INSTALL.md).
