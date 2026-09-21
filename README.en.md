# Tokens UI For Codex

Token usage for the **Codex desktop app**, shown where you already look: a compact
native-style bar next to the context-usage ring, plus a click-through details dialog.
It never modifies Codex itself, never registers keyboard listeners, and never shows your
conversation text.

- Author: **Littps**
- Platform: Windows 10 / 11 (Codex **desktop** only)
- License: MIT

## What it looks like

The bar sits **at the bottom-right of the composer, immediately left of the context ring**,
with two rows:

```
Session   Current turn   Requests
Speed     Hit rate       Hits        Output
```

Left-click the bar to open the **details dialog** with six sections:

| Section | Contents |
| --- | --- |
| Session total | tokens / requests / input·cache-hits / average speed / cache misses / output |
| Current turn | tokens / requests / input·cache-hits / **this turn's average speed** / cache misses / output |
| Context usage | used tokens, context limit and ratio |
| Runtime status | status / monitor / page / data / window selection / model switches / cumulative resets / recovery |
| Current-turn request details | **latest 10 by default**, "Load more" adds 20 each click |
| Turn summaries | **latest 25 turns by default**, "Load more" adds 50 each click |

Both lists are newest-first. Data that is not displayed **is not pushed to the page**; it is
fetched only when you click, capped at 500 entries each.

Close the dialog by clicking outside it, or the `×` in the top-right corner. **The plugin
registers no keyboard listeners** — Esc does not close the dialog.

While the pointer rests on the bar, the bar **freezes** (numbers and tooltips stop changing);
it catches up the moment the pointer leaves — handy for reading or copying values.

## Requirements

| Dependency | Requirement | Notes |
| --- | --- | --- |
| OS | Windows 10 / 11 | Windows only |
| Codex | Desktop app | The panel is injected into the desktop renderer page |
| Codex++ | Installed, user scripts enabled | The bar itself is a Codex++ user script |
| Node.js | **22 or newer** | Usually already available: the Codex desktop app ships its own runtime (v24 as tested) |

The installer locates Node in this order: `PATH` → the runtime bundled with Codex → common
install locations. If none is found it **fails loudly and tells you to install Node** —
it never fails silently.

## Installation

### One click (recommended)

Double-click `install.bat` in the package (it prefers PowerShell 7, then falls back to 5.1):

1. Environment check (OS / Node / Codex++ / Codex desktop / `codex` CLI)
2. Install the Codex++ user script (copy with SHA-256 verification; older panel scripts in the
   folder are identified **by script content** and disabled as `.superseded-*.bak`)
3. Register the local Codex plugin (provides the skill that explains and troubleshoots the tool)
4. Install logon autostart (scheduled task, **no admin rights needed**)
5. Self-check and report

### Manual (three steps)

```powershell
# 1) User script (the bar itself)
Copy-Item ".\plugins\tokens-ui-for-codex\tokens-ui-for-codex-panel.js" "$env:APPDATA\Codex++\user_scripts\" -Force

# 2) Register the local plugin (skill for explanations and troubleshooting)
codex plugin marketplace add .\
codex plugin add tokens-ui-for-codex@tokens-ui-for-codex-local

# 3) Logon autostart (scheduled task; no admin rights)
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugins\tokens-ui-for-codex\install-autostart.ps1
```

## Autostart and supervision

The scheduled task `tokens-ui-for-codex-monitor` starts the monitor process:

- **Triggers**: once right after installation + at logon + a 5-minute watchdog pass
- **Action**: `wscript.exe → launch-silent.vbs → node` (no console window, no PowerShell,
  unaffected by the PowerShell execution policy)
- **Duplicate instances**: never starts a second one (idle pass if already running);
  on failure restarts 3 times, 1 minute apart; no run-time limit
- **Privilege**: per-user, RunLevel Limited — no admin rights, no UAC prompt

If Codex is not running the monitor simply waits; it exits nothing and starts reporting as
soon as Codex comes up.

## Refresh cadence and data reliability

- **Pushes immediately on change**; otherwise heartbeat by state: **1 second while a task is
  running**, 5 seconds when idle
- **Expanded state does not heartbeat**: once you loaded a long list (window above the default
  tier) that payload is sent only when it actually changes
- **Session sharding**: when the host splits a huge session file, the monitor groups, merges and
  time-sorts the shards before computing statistics
- **Incremental parsing**: file offset and half-line buffer are remembered; truncation, rebuild
  or same-length replacement triggers a fresh baseline instead of reusing stale totals
- **Two-level stall warning**: 5 minutes without new records logs a warning; 15 minutes degrades
  to `stale-data` on the panel, returning to `healthy` automatically
- **Replay / echo**: the same request appearing in both log formats is claimed one-to-one and
  never counted twice; echoes lagging more than 60 seconds are reported separately with the
  top-3 timestamps in the log

## Uninstall

```powershell
# Standard: removes the scheduled task, stops the process, keeps logs and state
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugins\tokens-ui-for-codex\uninstall-autostart.ps1

# Full: also removes logs/state, the user script (and its backups), the plugin and its cache
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugins\tokens-ui-for-codex\uninstall-autostart.ps1 -Full
```

The uninstaller identifies this plugin's scheduled task and startup entries **by what their
actions point to**, and its user script **by script content**, so it never depends on legacy
file names.

## Data and privacy

- The page payload contains **only** numeric statistics, time labels, per-turn summaries and a
  limited request list for the current turn
- It contains **no** session file paths, thread IDs, user message excerpts, tokens, keys or
  credentials
- The monitor reads local session logs but extracts **structured numbers only** — it never
  copies, displays or transmits conversation text
- Page and monitor talk over local CDP (default `127.0.0.1:9229`); nothing goes over the network
- The panel registers no keyboard listeners, does not patch Codex's React bundle, and writes no
  Codex configuration files

## Troubleshooting

| Symptom | Check first |
| --- | --- |
| No bar at all | Is Codex++ running with user scripts enabled? Does `%APPDATA%\Codex++\user_scripts\tokens-ui-for-codex-panel.js` exist? Then reload the page |
| Bar shows "waiting for data" | Is the monitor process alive? Health snapshot `%LOCALAPPDATA%\tokens-ui-for-codex\monitor-health.json`; logs `...\logs\watch-YYYY-MM-DD.log` |
| Numbers stop moving | Look for "data stall / locate failed / locate warning" entries; a very long session may be getting sharded by the host |
| Speed looks slow to update | **The data source decides this**: values change only when Codex writes a usage record (measured arrival gap: median ≈ 2.9 s, p90 ≈ 14.7 s). Heartbeats only make the UI look alive; they cannot invent data |
| Stuck on "window selection required" | Specify the target page with `--target <ID>` |

```powershell
# Is the monitor alive?
Get-ScheduledTask -TaskName tokens-ui-for-codex-monitor | Get-ScheduledTaskInfo
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'token-stats.mjs' }
```

## How it works (short version)

Two cooperating parts:

1. **Panel (Codex++ user script)** — mounts the bar left of the native context ring. No React
   patching: DOM mounting plus incremental updates. The dialog skeleton is built once and then
   refreshed field by field.
2. **Monitor process (Node)** — reads local session logs → computes statistics → pushes a schema
   v2 payload over CDP → the page dispatches a `tokens-ui-for-codex` event that drives redraws.

**Speed figures** (both come from official data, never estimated):

- "This turn's average speed" = Σ output of this turn ÷ Σ generation time of this turn
- "Average speed" (session) = Σ session output ÷ Σ session generation time

> A live "tokens/s while generating" indicator is **not reliably possible** with the current
> Codex renderer: logs contain no per-chunk events, and the page replaces nodes instead of
> appending characters (measured over a 25-second window: 352 child nodes added while character
> changes were only 28 events / +13 net characters; turn blocks oscillate between 145 and 10586
> characters). The project therefore shows only reconcilable official figures.

## Package layout

```
Tokens UI For Codex/
├─ install.bat                       one-click entry point
├─ DEPLOYMENT.md                     deployment & install guide
├─ .agents/plugins/marketplace.json  local marketplace manifest
└─ plugins/tokens-ui-for-codex/
   ├─ .codex-plugin/plugin.json      plugin manifest (author: Littps)
   ├─ tokens-ui-for-codex-panel.js   Codex++ user script (bar + details dialog)
   ├─ token-stats.mjs                monitor process (read logs, compute, push over CDP)
   ├─ protocol.mjs / schemas/        payload contract and JSON schema
   ├─ install.ps1 / install-autostart.ps1 / uninstall-autostart.ps1
   ├─ find-codex.ps1                 locate codex / Node / Codex++ dynamically
   ├─ skills/tokens-ui-for-codex/    plugin skill
   └─ scripts/ test/ docs/           tooling, tests and specifications
```

## License

MIT License · Copyright (c) 2026 **Littps**
