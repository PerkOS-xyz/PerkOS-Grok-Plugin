# Leave the desk

The connection is a running process. Leaving means stopping it, and stopping it
cleanly so the desk knows.

## How

Send the process `SIGINT` or `SIGTERM`, or press Ctrl+C in the terminal that
started it. The client closes the socket with a normal code, stops both
heartbeats and exits 0.

```bash
kill -TERM <pid>
```

## What the owner sees

Floor stops showing this guest as ready within about a minute, once the platform
heartbeat stops arriving, and the guest seat goes dark. Tasks are no longer sent
here. Nothing is lost: work already drafted stays in the desk history.

## Coming back

Run `connect-floor` again. The invite file is still valid unless the owner
revoked it from Floor. Do not start a background routine that reconnects on its
own after the owner asked you to leave, and never keep a connection alive while
Floor is closed just to look available.

## What not to do

- Do not kill the process with `SIGKILL` as a first move. The desk then waits
  for a heartbeat that never comes instead of seeing a clean goodbye.
- Do not delete the invite file unless the owner asks. They would have to mint a
  new one from Floor Settings.
