# Changelog

Generated from [Conventional Commits](https://www.conventionalcommits.org) by
[git-cliff](https://git-cliff.org). Do not edit by hand.

## [0.3.5](https://github.com/sorinirimies/pi-context-diet/releases/tag/v0.3.5) — 2026-10-30


### 🐛 Fixes

- Atomic config saves, warn on an invalid config file, never crash on a failed save or a throwing compaction, reset stale footer savings ([`3241a75`](https://github.com/sorinirimies/pi-context-diet/commit/3241a7506d6831b06ea9bbd2a4a3ade83636b7ca))

### 🔧 Build & CI

- Ignore commits already released via the other host's parallel nightly (no phantom patch release) ([`ceae857`](https://github.com/sorinirimies/pi-context-diet/commit/ceae857af5777ac8ec019bbb92262745bab6a240))
- **deps:** Bump taiki-e/install-action from 2.87.26 to 2.87.29 (#3) ([`f69343c`](https://github.com/sorinirimies/pi-context-diet/commit/f69343c054224b1b047780fd59e23eaccb0ef84d))
- **deps:** Bump hustcer/setup-nu from 3.28 to 3.29 (#4) ([`30b9657`](https://github.com/sorinirimies/pi-context-diet/commit/30b965743ff895263ea332d64e7a66cf814d421d))
- **deps:** Bump taiki-e/install-action from 2.87.29 to 2.87.31 (#5) ([`a944a42`](https://github.com/sorinirimies/pi-context-diet/commit/a944a42c9112ad9e14d099e3d1e1c30e55b4f9ac))
- Auto-merge uses GH_PAT for workflow-file PRs, drop unsupported approve ([`9120ca2`](https://github.com/sorinirimies/pi-context-diet/commit/9120ca220ed58c086038eebdce5b11a3e4df83f5))

### 🧹 Chores

- **justfile:** Push/pull current branch instead of hardcoded main ([`9ceecd1`](https://github.com/sorinirimies/pi-context-diet/commit/9ceecd1f3294118953575afa53a55bf0576555c9))
- Nightly dev-tooling lockfile update 2026-10-15 (not released) ([`123255c`](https://github.com/sorinirimies/pi-context-diet/commit/123255c3631be03f9514f203dedb5db489262648))
- Nightly dev-tooling lockfile update 2026-10-15 (not released) ([`294a6e8`](https://github.com/sorinirimies/pi-context-diet/commit/294a6e88fbd392c42f1e0d2311cb3a51f44cafac))
- Nightly dev-tooling lockfile update 2026-10-16 (not released) ([`8a1b108`](https://github.com/sorinirimies/pi-context-diet/commit/8a1b108042942eba4a307d80c270f78efc4aee2f))
- Nightly dev-tooling lockfile update 2026-10-20 (not released) ([`c557ffb`](https://github.com/sorinirimies/pi-context-diet/commit/c557ffb1586181b61bead539547e9cdf2ed40f9f))
- Nightly dev-tooling lockfile update 2026-10-21 (not released) ([`b2d1755`](https://github.com/sorinirimies/pi-context-diet/commit/b2d17559978f0f4b86401b82319bfb39ba18e5b0))
- Nightly dev-tooling lockfile update 2026-10-22 (not released) ([`07ac11c`](https://github.com/sorinirimies/pi-context-diet/commit/07ac11c4338a2e62ccc5cf1b9cefafdf61988a16))
- Nightly dev-tooling lockfile update 2026-10-23 (not released) ([`7d027f9`](https://github.com/sorinirimies/pi-context-diet/commit/7d027f9b963f1110703f0df442f36915c08585ae))
- Nightly dev-tooling lockfile update 2026-10-27 (not released) ([`7539a22`](https://github.com/sorinirimies/pi-context-diet/commit/7539a223cd028f5aabda6cd843687bc122f80998))
- Nightly dev-tooling lockfile update 2026-10-29 (not released) ([`21f79df`](https://github.com/sorinirimies/pi-context-diet/commit/21f79dfa8926e5ff1da5448ea261bae3aa2ca153))
- Nightly dev-tooling lockfile update 2026-10-30 (not released) ([`c3842de`](https://github.com/sorinirimies/pi-context-diet/commit/c3842deafc273e82e93827d7646d6b1a88e57df7))
- Ignore the .codegraph index ([`f11c91d`](https://github.com/sorinirimies/pi-context-diet/commit/f11c91daaaf38752bca5b9de587a5f8f7e4acdd5))
## [0.3.4](https://github.com/sorinirimies/pi-context-diet/releases/tag/v0.3.4) — 2026-10-14


### 🐛 Fixes

- Never rewrite assistant messages with thinking blocks (API 400 on signed thinking) ([`9d9c91c`](https://github.com/sorinirimies/pi-context-diet/commit/9d9c91c9cfc08ce2e3a7c3ef2c60a079a56ae448))
## [0.3.3](https://github.com/sorinirimies/pi-context-diet/releases/tag/v0.3.3) — 2026-10-14


### 📚 Docs

- Separate install commands for individual copy ([`2a6b502`](https://github.com/sorinirimies/pi-context-diet/commit/2a6b5021749fb3c76721cceabf391288103691e0))
- Separate install commands for individual copy ([`aefcad3`](https://github.com/sorinirimies/pi-context-diet/commit/aefcad3bd3ed571859899f42cb05136f5f14ce7e))

### 🔧 Build & CI

- Don't release on ci(deps) (GitHub Actions) bumps ([`f843efa`](https://github.com/sorinirimies/pi-context-diet/commit/f843efac56cdffab05961ccbcad0e8e7477310b0))
- Don't release on ci(deps) (GitHub Actions) bumps ([`9d82f89`](https://github.com/sorinirimies/pi-context-diet/commit/9d82f89942d973d6033aa8c02b7fbb1c9cfc8266))
- Publish only when a runtime dependency really upgrades (or feat/fix/perf); dev-tooling updates no longer release ([`0842ac5`](https://github.com/sorinirimies/pi-context-diet/commit/0842ac50efd2d26ccead0d2ef6d6aadf9ebe9506))
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

