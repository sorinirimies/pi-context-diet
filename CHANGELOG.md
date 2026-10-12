# Changelog

Generated from [Conventional Commits](https://www.conventionalcommits.org) by
[git-cliff](https://git-cliff.org). Do not edit by hand.

## [0.3.1](https://github.com/sorinirimies/pi-context-diet/releases/tag/v0.3.1) — 2026-10-12


### 🐛 Fixes

- The footer was blank until something was elided; always show the plugin is on, what the next pause would drop, and whether compaction is on ([`acaa27b`](https://github.com/sorinirimies/pi-context-diet/commit/acaa27bbf6ea60d529cc52bfd8190b55e34d5cea))
## [0.3.0](https://github.com/sorinirimies/pi-context-diet/releases/tag/v0.3.0) — 2026-10-12


### ✨ Features

- Calibration from real usage, show, cache-warming arbitration and opt-in compaction ([`2ff9ba2`](https://github.com/sorinirimies/pi-context-diet/commit/2ff9ba252d54bff6899593ab0615a47d2692aeb0))
## [0.2.2](https://github.com/sorinirimies/pi-context-diet/releases/tag/v0.2.2) — 2026-10-12


### 🔧 Build & CI

- **deps:** Bump actions/setup-node from 7.0.0 to 7.1.0 (#1) ([`f3933e4`](https://github.com/sorinirimies/pi-context-diet/commit/f3933e4b9894abff3662e8a90935c439aa0363a6))

### 🧹 Chores

- Just recipes to push, pull and force-push to several remotes (push-all, pull-all, push-tags-all, *-force, sync-starscream, setup-remotes; release-push goes to every remote) ([`fca0579`](https://github.com/sorinirimies/pi-context-diet/commit/fca0579fe06c45a0c88d0a150bd08f8bcca74a36))
- Justfile remotes and release recipes in the gitkraft style (gitea-microlab, gitea-starscream, gitea-nexus-lab: push, pull, release, sync, all-remotes and force variants; unconfigured remotes are skipped) ([`2a477a3`](https://github.com/sorinirimies/pi-context-diet/commit/2a477a3ff8215800346916178e47dbc05e8bc196))
## [0.2.1](https://github.com/sorinirimies/pi-context-diet/releases/tag/v0.2.1) — 2026-10-12


### 🐛 Fixes

- Never silent in the cache-breaking mode: warn at session start and mark the footer when mode is always ([`a9ba087`](https://github.com/sorinirimies/pi-context-diet/commit/a9ba087a5273167f641d303d13b8c490aa5fe289))

### 🧪 Tests

- No test may touch the real ~/.pi/agent (preload sets a temp config dir; the autocomplete test persisted mode=always into it) ([`be53ad3`](https://github.com/sorinirimies/pi-context-diet/commit/be53ad3cfb0dd58ae8a96c12a6ab81ebd9e601b4))
## [0.2.0](https://github.com/sorinirimies/pi-context-diet/releases/tag/v0.2.0) — 2026-10-12


### ✨ Features

- Stub previews, a recovery meter with auto-protection, and eliding stale write/edit arguments ([`16559e7`](https://github.com/sorinirimies/pi-context-diet/commit/16559e74278164dbfaf422e5b0ae16ca9bb514a1))

### 🧪 Tests

- Windows-safe line endings for the README checks ([`2582524`](https://github.com/sorinirimies/pi-context-diet/commit/258252431932cd28fef291d7758eeb9ad2ccb9c3))
## [0.1.0](https://github.com/sorinirimies/pi-context-diet/releases/tag/v0.1.0) — 2026-10-12


### ✨ Features

- Pi-context-diet, elide stale tool results from the context when the prompt cache is already cold ([`811d1ea`](https://github.com/sorinirimies/pi-context-diet/commit/811d1eaf8251017ddd49efd1659a92e15a60ef1f))

