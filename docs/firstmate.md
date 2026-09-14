# Firstmate

Firstmate support is opt-in. Set the home before starting OpenCode:

```sh
OES_FIRSTMATE_HOME="$HOME/path/to/firstmate-home" opencode
```

When the code root differs from the home:

```sh
OES_FIRSTMATE_HOME="$HOME/path/to/firstmate-home" \
OES_FIRSTMATE_ROOT="$HOME/path/to/firstmate-code" \
opencode
```

Home lookup uses `OES_FIRSTMATE_HOME` only, and root lookup uses `OES_FIRSTMATE_ROOT` only; otherwise the selected home must contain `bin/fm-fleet-snapshot.sh`. Firstmate's own `FM_*` variables are never read as an opt-in, so an ambient Firstmate environment cannot enable the integration. An explicit invalid path reports Firstmate as unavailable without affecting OpenCode. With no home variable, the integration is inert and starts no process or timer.

## My work

The `Firstmate` group appears after question and error groups and before `Sessions`. It shows canonical durable queued, in-flight, held, blocked, and open-decision work across OpenCode, Codex, and other harnesses. The inventory does not depend on a live OpenCode session.

Rows include the canonical task state and available project, harness, backend, worktree, hold, blocker, provenance, and freshness details. An open Secondmate decision that is not a captain hold shows as `Decision`; a captain hold still shows as `Held`. Selecting a row opens read-only details. There is currently no session navigation because `fm-fleet-snapshot.v1` has no durable OpenCode session mapping. The normalizer ignores undeclared extension fields rather than treating them as navigation data.

Remote work is kept distinct by its remote host, home, and task ID. OES does not infer whether a task is live or complete.

## Reads and failures

OES runs the fixed command `bin/fm-fleet-snapshot.sh --json` about every 30 seconds and accepts only `fm-fleet-snapshot.v1`. It does not read Firstmate backlog, status, or task files directly.

- A successful empty response clears the group.
- Freshness comes only from the producer's own observations on rendered rows, so a successful read with nothing to observe - an idle fleet, or a backlog that is queued but not yet started - is fresh and shows no notice.
- A partial response shows only its current rows and one `Inventory partial` notice. Omitted records are not synthesized.
- A command or parse failure keeps the last good rows for the same home, marked stale with their original observation time.
- Without a last good read, a failure shows one `Inventory unavailable` notice. Host snapshots continue normally.

The command has bounded output and a deadline. OES closes stdin and disables the Firstmate snapshot cache. On timeout, cancellation, or oversized output, OES asks only its direct Bun subprocess to terminate, waits a bounded grace period, and asks it to stop immediately only if it is still active. If the command has exited but a descendant keeps an output pipe open, OES cancels its readers and fails the read without discovering or signaling that descendant. The trusted command owns its descendant lifecycle. OES never starts a Firstmate watcher, takes a lock, changes Firstmate data, or runs task actions.

Configure only a trusted executable owned by the same user running OpenCode. OES also rejects an executable whose resolved ancestor chain contains a replaceable group- or world-writable directory. Safe root-owned system ancestors and sticky shared directories are allowed.
