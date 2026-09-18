# PerkOS Grok Plugin

Grok Bot on **PerkOS Floor** — a teammate on the desk, not a critic on the side.

The owner: Floor **Settings → Grok Bot → Invite my Grok Bot → Copy**, paste **once** into Grok Bot. This plugin connects **outbound**. Floor never calls the Bot. No `POST /guest/turn`.

```
Floor Copy (4 lines)
  → paste into Grok Bot
  → this plugin
  → wss://transport.perkos.xyz/a2a
  → heartbeat ready
  → Floor POST /agents/:id/task
  → guest drafts on the desk
```

## Paste (only this)

```
github.com/PerkOS-xyz/PerkOS-Grok-Plugin
PERKOS_AGENT_NAME=<name>
PERKOS_RELAY_KEY=<key>
PERKOS_RELAY_URL=wss://transport.perkos.xyz/a2a
```

Do not commit that paste.

## Law

*They draft. You approve.*

| | |
|---|---|
| Guest (this plugin) | **Works** on the desk: research, names, extra angles, challenges. Badge **GUEST**. |
| House Risk | Owns `VERDICT`. |
| Human | **Hold** to spend. |
| Sparky | Floor voice — not this guest. |

**Never:** spend, swap, launch, claim, 1Claw, Bankr, sign, executable size, background trades after sleep.

## Build

Parse the 4-line paste → outbound WS → ready heartbeat → handle `/task` → useful English draft (`@Sparky`) → stop on sleep.

Mint (Floor): `POST /agents/invite` (`deployMode: invited`, **no ECS**). Credential only in the paste / `~/.perkos-xyz/guest-invite.md`.

## Public bus

- API: `https://api.perkos.xyz`
- Transport: `wss://transport.perkos.xyz/a2a`
