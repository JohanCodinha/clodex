# clodex patch canary

Scripts that automate monitoring `clodex patch` against new Claude Code releases: every hour they
download the newest release for **every** published platform into a throwaway sandbox, run
`clodex patch` against it, and raise a Slack alert plus a background investigation session when a
release does not patch cleanly.

They live here so they are versioned like everything else. They run from `~/.local/bin`, which
symlinks to this folder.

| File | What it is |
| --- | --- |
| `clodex-patch-canary.sh` | the canary itself; `--help` documents every flag |
| `clodex-patch-canary-platforms.sh` | the platform matrix — sourced by the canary, not run directly |
| `clodex-patch-canary-cron.sh` | launchd entry point (forces `HOME`/`PATH`) |
| `clodex-patch-canary-selftest.sh` | assertions over report parsing, verdict logic and launch argv; no downloads |
| `com.experoinc.brandon.clodex-patch-canary.plist` | the hourly launchd schedule |

State lives outside the repo: `~/.local/state/clodex-patch-canary/` (triage record `state.json` and
one log per run) and `~/.cache/clodex-patch-canary/` (a private clone hard-reset to `origin/main`
each run, plus sandboxes — removed on success, kept on failure for the investigation).

## Install

```bash
ln -sfn "$PWD/canary/clodex-patch-canary.sh"           ~/.local/bin/clodex-patch-canary.sh
ln -sfn "$PWD/canary/clodex-patch-canary-platforms.sh" ~/.local/bin/clodex-patch-canary-platforms.sh
ln -sfn "$PWD/canary/clodex-patch-canary-selftest.sh"  ~/.local/bin/clodex-patch-canary-selftest.sh
ln -sfn "$PWD/canary/clodex-patch-canary-cron.sh"      ~/.local/bin/clodex-patch-canary-cron.sh

cp canary/com.experoinc.brandon.clodex-patch-canary.plist ~/Library/LaunchAgents/
launchctl load  ~/Library/LaunchAgents/com.experoinc.brandon.clodex-patch-canary.plist
launchctl start com.experoinc.brandon.clodex-patch-canary   # run once now
```

The canary resolves its sibling scripts through `${BASH_SOURCE[0]}`, which does **not** follow the
symlink — so all four must be symlinked together, not just the entry point.

Uninstall: `launchctl unload ~/Library/LaunchAgents/com.experoinc.brandon.clodex-patch-canary.plist`.
Pause without unloading: uncomment the `exit 0` near the top of `clodex-patch-canary-cron.sh`.

## Before changing anything here

```bash
./canary/clodex-patch-canary-selftest.sh     # must be green
./canary/clodex-patch-canary.sh --status     # triage state
```

The selftest drives the real functions against fixtures and stand-ins, so it needs no network and
touches no real install. It mocks the `claude` binary, which means it cannot see bugs in how the
canary invokes the *real* CLI — the argv tests exist because one such bug (a prompt silently
swallowed by the variadic `--add-dir`) shipped and cost a day of coverage.
