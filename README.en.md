# Tokens UI For Codex

Native-style token usage UI for the Codex desktop app. A compact bar sits immediately
left of the context-usage ring in the composer; left-click it to open a detailed dialog.

- Author: **Littps**
- Platform: Windows 10 / 11
- Client: Codex / ChatGPT desktop
- Dependency: Codex++ user scripts
- License: MIT

The project does not patch Codex's React bundle, register keyboard listeners, or display
message text, session paths, or thread IDs.

## UI

```text
Session  Current question  Requests
≈Speed   Hit rate          Hits      Output
```

The compact bar shows:

- Session total
- Current-question total
- Session request count
- Robust estimated generation speed as `≈XXXT/s`
- Current-question cache hit rate
- Cache-hit tokens
- Current-question output tokens

The bar freezes while the pointer is over it and catches up immediately after the pointer leaves.

Clicking the bar opens six sections:

| Section | Contents |
| --- | --- |
| Session total | tokens, requests, input/cache hits, recent effective speed, misses, output |
| Current question | tokens, requests, input/cache hits, current-turn effective speed, misses, output |
| Context usage | used tokens, context limit, ratio |
| Runtime status | status, monitor, page, freshness, model switches, cumulative resets |
| Current-question requests | latest 10; Load more adds 20; cap 500 |
| Turn summaries | latest 10; Load more adds 50; cap 500 |

Both lists are newest-first. Hidden rows are not included in the page payload.
The page, monitor protocol and receiver are all capped at **500** rows. Older structured
request and turn records are written to a local history archive and never sent over CDP.

Additional behavior:

- Close by clicking outside or the top-right `×`
- No keyboard listeners; Esc does not close the dialog
- Light/dark theme follows the Codex host and updates after a short debounce
- Frosted glass automatically degrades to a solid surface on slow devices
- Health dot: green healthy, yellow waiting/stale, red error

## Requirements

| Dependency | Requirement |
| --- | --- |
| OS | Windows 10 / 11 |
| Codex | Desktop app, MSIX or conventional installation |
| Codex++ | Installed, user scripts enabled |
| Node.js | 22+; the Codex bundled runtime is preferred when available |
| PowerShell | Windows PowerShell 5.1 or PowerShell 7 |
| Admin rights | Not required |

Node discovery collects every `node.exe` candidate from `PATH`, the Codex runtime and
common install locations, ignores `.cmd` shims and versions below 22, then chooses the
highest compatible version. Installation stops with a clear message if none qualifies.

## Project dependencies and build

There are no third-party runtime npm dependencies. The monitor uses only Node.js built-ins:

- `fs`, `path`, `os`
- `crypto` for HMAC-SHA256 and session hashes
- `child_process`
- built-in WebSocket and fetch in Node 22+

No `npm install` is required for deployment. Development verification uses Node.js 22/24,
Windows PowerShell 5.1/PowerShell 7, and Playwright only for `npm run test:live`. CI runs
unit tests on both Node 22 and Node 24.

## Install

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\install.ps1"
```

The installer:

1. Verifies Windows, Node, Codex, Codex++, the user-script switch and the `codex` CLI
2. Backs up and installs the Codex++ user script with SHA-256 verification
3. Retires older panel scripts by content so only one bar is injected
4. Registers `tokens-ui-for-codex@tokens-ui-for-codex-local`
5. Registers a per-user scheduled task and starts the monitor once
6. Rechecks the task, plugin, user script and monitor process

Source archives do not need a prebuilt `plugins/` tree. The installer generates a
temporary staging layout under `%LOCALAPPDATA%\tokens-ui-for-codex\install-stage\`.

## Startup

Scheduled task: `tokens-ui-for-codex-monitor`

- Runs once after installation and again at user logon
- No periodic watchdog
- Action chain: `wscript.exe → launch-silent.vbs → node`
- Duplicate instances are ignored
- Failed runs retry up to 3 times, one minute apart
- Per-user Limited principal; no UAC

If the monitor is stopped, use the dialog's Start Monitor command or the Start-menu
shortcut. The Unicode PowerShell confirmation window requires `Y` before starting.

## Data flow

```text
Codex rollout JSONL
  → incremental parser and statistics
  → local CDP with dynamic port discovery
  → signed schema v3 payload
  → HMAC verification in the Codex++ script
  → incremental bar/dialog rendering
```

The monitor:

- Reads only structured numeric fields
- Merges all shards of a long session
- Sorts by `(timestamp, ordinal)`
- Handles truncation, half lines, same-size replacement and cumulative resets
- Uses the same multi-shard path for watch mode and one-shot `--thread`
- Deduplicates modern and legacy formats without assuming monotonic counters
- Uses full legacy fingerprints for duplicate detection
- Updates a mixed-format current turn from the turn's thread baseline

The authoritative merge contract is [docs/F1-merge-spec.md](docs/F1-merge-spec.md).

## Speed

- The compact bar displays an estimated generation speed and marks it with `≈`
- It uses the median of up to five valid request samples plus MAD outlier filtering
- Fewer than three valid samples shows `--T/s` instead of exposing a raw spike
- Three consecutive narrow-range samples can establish a new speed regime
- Generation intervals are merged before calculating active generation time
- The dialog displays effective speed: output tokens ÷ (turn duration − tool time)
- Session effective speed is weighted over the latest 25 high/medium-confidence turns
- The speed tooltip also shows the current turn's wall-clock average using output tokens only
- `output_tokens` already includes reasoning and tool-structure tokens

## Refresh cadence

| State | Behavior |
| --- | --- |
| Data changed | Push immediately |
| Task running | 1-second heartbeat |
| Idle | 5-second heartbeat |
| Expanded long lists | No heartbeat; push only on data/health/window changes |

## Security and privacy

- Signed-only schema v3
- Random 256-bit per-monitor session key
- HMAC-SHA256 over the full payload, timestamp and nonce
- Reject missing auth, bad MAC, timestamps older than 30 seconds, nonce replay and sequence rollback
- Boot payloads use the same verification path
- Payloads are cloned before async verification and the verified snapshot is applied
- Local CDP uses `--port auto`; `--port <n>` remains available as an override
- No paths, thread IDs, message text, credentials or API keys are included in the page payload
- The local archive also excludes message text, paths and original thread identifiers; only a session hash is used

## Diagnostics

```text
%LOCALAPPDATA%\tokens-ui-for-codex\
├─ logs\watch-YYYY-MM-DD.log
├─ history\sessions\<sessionHash>\
│  ├─ requests-YYYYMM*.jsonl
│  └─ turns.json
├─ monitor-health.json
├─ autostart-state.json
└─ last-summary.json
```

The health file is rewritten every monitor cycle with a fresh `lastSuccessAt` and mtime.

Local history rules:

- Structured numeric fields, time labels and indexes only
- No message text, session paths, thread IDs, response IDs or turn IDs
- Retained for **60 days**
- Request files rotate at 32MB
- Cleanup runs every six hours
- Standard uninstall keeps history; `-Full` removes it

Common checks:

```powershell
Get-ScheduledTask -TaskName tokens-ui-for-codex-monitor | Format-List State
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'token-stats\.mjs' } |
  Select-Object ProcessId, CommandLine
Get-Content "$env:LOCALAPPDATA\tokens-ui-for-codex\monitor-health.json" -Raw
```

## Verification

```powershell
npm run check
npm test
node scripts\golden-baseline.mjs --check
node scripts\verify-live.mjs
npm run test:live
node scripts\verify-sync.mjs --deploy "<deployment root>"
```

Current baseline: 65 unit tests, zero Golden mismatch, 15 live page checks, and
12 Playwright passes with 2 real-input tests skipped for safety.

## Update and rollback

Back up the source, deployment, plugin cache, Codex++ user scripts, state directory and
configuration before an update. The installer stops all old `token-stats.mjs --watch`
processes before starting the new one. Reload the Codex page after updating the user script.

## Uninstall

```powershell
# Keep state, logs and the user script
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\plugins\tokens-ui-for-codex\uninstall-autostart.ps1"

# Full cleanup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\plugins\tokens-ui-for-codex\uninstall-autostart.ps1" -Full
```

The uninstaller prints a residual self-check. Delete the package directory manually afterward.

## Known limits

- Windows + Codex desktop + Codex++ only
- UI anchoring depends on Codex accessibility labels; major host updates may require selector changes
- Codex rollout events do not expose a per-token/chunk timeline, so compact-bar speed is an estimate
- There is no periodic watchdog; after the scheduled-task retry budget is exhausted, start the monitor manually
- Multi-window use requires one unique focused target, otherwise use `--target`
- Locked-down enterprise environments may block scheduled tasks, user scripts or local CDP

## License

MIT License · Copyright (c) 2026 **Littps**
