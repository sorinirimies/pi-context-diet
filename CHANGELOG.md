# Changelog

Generated from [Conventional Commits](https://www.conventionalcommits.org) by
[git-cliff](https://git-cliff.org). Do not edit by hand.

## [0.4.1](https://github.com/sorinirimies/pi-context-diet/releases/tag/v0.4.1) — 2026-11-09


### 🐛 Fixes

- **ci:** Nightly commit step accepts bool arg from nu ([`6a01144`](https://github.com/sorinirimies/pi-context-diet/commit/6a0114434a48029f17439f71246b09883493f2fa))

### 🔧 Build & CI

- Align tooling with the plugin template ([`601ee7b`](https://github.com/sorinirimies/pi-context-diet/commit/601ee7bd3223a29937cb0df708b1d823dcc5e6ec))
- Scan the git history for secrets with gitleaks ([`6d64c7e`](https://github.com/sorinirimies/pi-context-diet/commit/6d64c7edce54e932bb2b8232689667d6c3a6d1f3))

### 🧹 Chores

- Nightly dev-tooling lockfile update 2026-11-03 (not released) ([`6d54968`](https://github.com/sorinirimies/pi-context-diet/commit/6d54968645d3bf64963f0eb649d69fb872dd49ca))
- Nightly dev-tooling lockfile update 2026-11-09 (not released) ([`d3ed00d`](https://github.com/sorinirimies/pi-context-diet/commit/d3ed00dade9ffc164fcbfdff9dee34c412860b63))
## [0.4.0](https://github.com/sorinirimies/pi-context-diet/releases/tag/v0.4.0) — 2026-11-02


### ✨ Features

- Log what each request saved to context-diet-savings.jsonl for usage trackers ([`6515534`](https://github.com/sorinirimies/pi-context-diet/commit/65155343e074ccd1d64c0af00cec43eeaeb5c5cc))

### 🔧 Build & CI

- **deps:** Bump Gitea workflow actions ([`367e8c5`](https://github.com/sorinirimies/pi-context-diet/commit/367e8c52b076ea4a10ff4211052fe122378f74fd))
## [0.3.8](https://github.com/sorinirimies/pi-context-diet/releases/tag/v0.3.8) — 2026-11-02


### 🐛 Fixes

- **ci:** A 409 from the other host publishing the same version first is not a failure ([`32bc677`](https://github.com/sorinirimies/pi-context-diet/commit/32bc677d6cff02337701bb384ca08d1269e2e665))

### 📚 Docs

- **readme:** Add the Audit and Fuzz badges ([`a4ec0ce`](https://github.com/sorinirimies/pi-context-diet/commit/a4ec0ced9559c001764070a9692676f56f267895))
- This repo's agent rules as a project skill in .agents/skills ([`a8a855e`](https://github.com/sorinirimies/pi-context-diet/commit/a8a855e598ced417c4fb52f0cb7a358fbc7a0de9))
- Drop the per-repo agent rules skill; the shared skills cover it ([`5a8bfe3`](https://github.com/sorinirimies/pi-context-diet/commit/5a8bfe32f3a05afbb486dc9be6b1221d48b8e0a7))

### 🔧 Build & CI

- **deps-dev:** Pin minimatch 11.0.3 via overrides ([`0eac0a5`](https://github.com/sorinirimies/pi-context-diet/commit/0eac0a5066b05c952408e3ef833b6e7e68434531))
- Cut a release from the Release workflow (bump, changelog, tag, push, publish) ([`ea96d2f`](https://github.com/sorinirimies/pi-context-diet/commit/ea96d2f293ed1ea274523b7b60816636355a3880))
- **deps:** Bump taiki-e/install-action from 2.87.31 to 2.88.1 (#6) ([`98a5b5b`](https://github.com/sorinirimies/pi-context-diet/commit/98a5b5bf8fd166cbd21165e811a6ab557c63dc18))

### 🧹 Chores

- Nightly dev-tooling lockfile update 2026-11-01 (not released) ([`1925667`](https://github.com/sorinirimies/pi-context-diet/commit/1925667a245015eadb5682eb6b3f4366dd89e163))
## [0.3.7](https://github.com/sorinirimies/pi-context-diet/releases/tag/v0.3.7) — 2026-10-31


### 🐛 Fixes

- The chars-per-token calibration ignores non-finite usage (one Infinity made it NaN for the rest of the session) ([`a2a99e3`](https://github.com/sorinirimies/pi-context-diet/commit/a2a99e3d38f4baaa0c62f13e867d514b8bb4025e))

### 🧪 Tests

- Seeded fuzz tests (FUZZ_ITERS / FUZZ_SEED; a failure prints the seed that reproduces it) ([`628ce7a`](https://github.com/sorinirimies/pi-context-diet/commit/628ce7afd1b014d349aee94c7c3ff3568e1fdf62))

### 🔧 Build & CI

- Fuzz and Security workflows on GitHub and Gitea ([`931f3da`](https://github.com/sorinirimies/pi-context-diet/commit/931f3da33902170d5a62aa7950eced7364f9308d))
## [0.3.6](https://github.com/sorinirimies/pi-context-diet/releases/tag/v0.3.6) — 2026-10-31


### 🔧 Build & CI

- **deps-dev:** Pin undici 8.12.3 via overrides ([`2ab06a9`](https://github.com/sorinirimies/pi-context-diet/commit/2ab06a960aa8c594ceaa232a9bcd597cc516564a))
- Keep .gitea workflow actions up to date; auto-merge needs GH_PAT for action bumps ([`ff74897`](https://github.com/sorinirimies/pi-context-diet/commit/ff748977c52014d7a1418a8d966a5cc8dc747fde))
- **deps:** Bump Gitea workflow actions ([`b817700`](https://github.com/sorinirimies/pi-context-diet/commit/b81770046f980089708c05cb08756ae2cbf809fe))
- One nightly (GitHub); Gitea mirrors GitHub's main and tags hourly ([`a1982a7`](https://github.com/sorinirimies/pi-context-diet/commit/a1982a7d5876f194ab10a7147f0a0d9545c7b629))

### 🧹 Chores

- Nightly dev-tooling lockfile update 2026-10-31 (not released) ([`273c0bd`](https://github.com/sorinirimies/pi-context-diet/commit/273c0bd63cedb6ec3c398ed49d3bf70bf21a9566))
- Nightly dev-tooling lockfile update 2026-10-31 (not released) ([`3bbaf76`](https://github.com/sorinirimies/pi-context-diet/commit/3bbaf768bf62f316974c3043337fe8ea35bad21a))
- Merge Gitea's main (both hosts ran their own nightly) ([`73e8e72`](https://github.com/sorinirimies/pi-context-diet/commit/73e8e72d781975dffa6216ec7592485aecb3b15c))
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

### 🔧 Build & CI

- Publish only when a runtime dependency really upgrades (or feat/fix/perf); dev-tooling updates no longer release ([`0842ac5`](https://github.com/sorinirimies/pi-context-diet/commit/0842ac50efd2d26ccead0d2ef6d6aadf9ebe9506))
## [0.3.3](https://github.com/sorinirimies/pi-context-diet/releases/tag/v0.3.3) — 2026-10-14


### 📚 Docs

- Separate install commands for individual copy ([`2a6b502`](https://github.com/sorinirimies/pi-context-diet/commit/2a6b5021749fb3c76721cceabf391288103691e0))
- Separate install commands for individual copy ([`aefcad3`](https://github.com/sorinirimies/pi-context-diet/commit/aefcad3bd3ed571859899f42cb05136f5f14ce7e))

### 🔧 Build & CI

- Don't release on ci(deps) (GitHub Actions) bumps ([`f843efa`](https://github.com/sorinirimies/pi-context-diet/commit/f843efac56cdffab05961ccbcad0e8e7477310b0))
- Don't release on ci(deps) (GitHub Actions) bumps ([`9d82f89`](https://github.com/sorinirimies/pi-context-diet/commit/9d82f89942d973d6033aa8c02b7fbb1c9cfc8266))
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

