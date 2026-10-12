# Changelog

Generated from [Conventional Commits](https://www.conventionalcommits.org) by
[git-cliff](https://git-cliff.org). Do not edit by hand.

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

