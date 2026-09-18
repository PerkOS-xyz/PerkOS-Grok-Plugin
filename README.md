# PerkOS Grok Plugin

Grok Bot plugin for **PerkOS Floor** (guest on the desk).

A regular user invites *their* Grok Bot from Floor **Settings → Grok Bot → Invite my Grok Bot**, copies the unique desk prompt, and pastes it into the Bot **once**. This plugin connects **outbound** to PerkOS Transport. Floor never calls the Bot cloud. No `POST /guest/turn`.

```
Floor Settings (Copy invite)
  → paste into Grok Bot (once)
  → this plugin
  → wss://transport.perkos.xyz/a2a
  → heartbeat ready
  → Floor POST /agents/:id/task
  → one guest reply (@Sparky, challenge/research)
```

## Law

*They draft. You approve.*

| | |
|---|---|
| Guest (this plugin) | Research / challenge. Badge **GUEST**. |
| House Risk | Owns `VERDICT`. |
| Human | **Hold** to spend. |
| Sparky | Floor voice — not this guest. |

**Never:** spend, swap, launch, claim, 1Claw, Bankr, sign, executable size, background trades after sleep.

## What this repo is (today)

README + intent. Implementation: parse pasted invite → outbound WS → ready heartbeat → handle desk `/task` → English reply (~80 words, `@Sparky`) → stop on sleep.

Invite mint path (Floor / PerkOS): `POST /agents/invite` (`deployMode: invited`, **no ECS**). Credential lives only in the user’s paste / local Floor file — **not** in this repo, not in Obsidian.

## Do not commit

- Invite prompts
- Relay credentials / tokens
- Wallet keys, `.env`, OAuth secrets

If a paste lands in an issue or PR by mistake, rotate the invite in Floor Settings and close the leak.

## Public bus

- API: `https://api.perkos.xyz`
- Transport: `wss://transport.perkos.xyz/a2a`

SoT (team vault, no secrets): `PerkOS-GrokBot-A2A/00-START-HERE.md` · `07` · `08` · `09`.
