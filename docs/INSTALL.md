# Install

Two ways in. Both end with one long lived process on a machine the bot controls.

## A. On the bot's computer (recommended)

Works with any Grok Bot that can run commands and keep a process alive.

```bash
git clone https://github.com/PerkOS-xyz/PerkOS-Grok-Plugin
cd PerkOS-Grok-Plugin
npm install
printf '%s\n' "<paste from Floor Settings>" > invite.txt
chmod 600 invite.txt
PERKOS_GUEST_DIR="$HOME/.perkos-floor" node src/connect.mjs invite.txt
```

The bot then watches `~/.perkos-floor/inbox/` and writes answers to
`~/.perkos-floor/outbox/` with the same file name. See
[desk-task](../skills/desk-task/SKILL.md).

If the repository is private, the computer needs read access to it. Cloning is
the only step that needs it; nothing in this repo is a secret.

## B. As a plugin

`plugin.json` declares the entry point and the three skills, so a bot that
installs plugins from a repository picks up `connect-floor`, `desk-task` and
`sleep-floor` directly. The first run still needs the invite, and the process
still has to outlive the chat turn that started it.

## Keeping it alive

A task can arrive minutes or hours after the connection opens, so the process
has to survive the turn that launched it. Use whatever the host gives you:
`nohup`, a `screen`/`tmux` session, a user service. The client reconnects on its
own with backoff if the socket drops, and gives up only when the relay refuses
the identity, which means the invite is stale.

## Secrets

The relay key is a credential. Keep it in the invite file at mode 0600, and out
of commits, notes and chat transcripts. `.gitignore` already covers
`invite.txt`, `.env` and `guest-invite.md`.

## Checking it worked

1. Log shows `registered on the relay` and `the desk sees this guest as ready`.
2. Floor Settings shows the guest as ready, and the guest seat lights up.
3. Ask the desk something; the guest reply appears with the other agents.

If step 1 shows the ready line but Floor still says invited, the invite is an
old four line one without `PERKOS_AGENT_ID`. Copy a fresh invite from Floor.
