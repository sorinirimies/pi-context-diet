# pi-context-diet

[![npm](https://img.shields.io/npm/v/pi-context-diet.svg)](https://www.npmjs.com/package/pi-context-diet)
[![npm downloads](https://img.shields.io/npm/dm/pi-context-diet.svg)](https://www.npmjs.com/package/pi-context-diet)
[![CI](https://github.com/sorinirimies/pi-context-diet/actions/workflows/ci.yml/badge.svg)](https://github.com/sorinirimies/pi-context-diet/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that cuts token spend on long sessions by **eliding stale tool results (and stale `write`/`edit` content) from the context, but only when the prompt cache has already gone cold**, so it costs nothing and never fights the cache.

Zero prompt tokens: it rewrites the messages of a request, never the system prompt, and the transcript on disk is untouched. Optionally (opt-in) it also compacts a big idle session with pi's own summariser.

<img src="examples/vhs/generated/overview.gif" alt="Five tool results pile up; after a pause pi-context-diet drops the stale ones and the model reports that 3 of its 5 tool results now arrive as one-line stubs" width="900">

## Why

Pi re-sends the whole conversation on every turn, and almost all of it is served from the prompt cache. In a long session an old `bash` log or file dump is re-read hundreds of times. In one real set of 221 pi sessions (about 35,000 turns):

- **95.6% of all tokens were cache reads**: history length, not any single result, is what costs.
- Tool results were **29% of those reads**, and sessions almost never compacted, so stale output stayed for the whole session.

Dropping old results saves a lot, but editing old history normally **invalidates the prompt cache**, and a cache rewrite costs far more than the reads it saves.

## How it works

1. After a pause longer than the cache lifetime (default 5 minutes) the cache is **already cold**: the whole prefix has to be rewritten anyway, so a shorter prefix is free.
2. At that moment it picks the tool results that are old (more than `keepTurns` assistant turns back), big (at least `minChars`), plain text, and not errors, and replaces each with a one-line stub that says what it was and how to get it back.
3. That set is remembered (in the session) and applied **unchanged on every later request**, so the prompt prefix stays byte-stable and cacheable until the next cold start.

Three things keep it safe:

- **Stubs keep a preview.** Each stub says what was elided and how big it was, and keeps the **last lines** and any **error lines** of the output, so an exit status or a failure survives.
- **A recovery meter checks it didn't hurt.** When the agent re-issues an elided call (the identical tool and arguments) it is counted as a *re-fetch*, with its real cost. `/context-diet` shows `recovery: 3 of 40 elided results re-fetched (8%, ~9k tokens to re-fetch, once)`. If one tool's results keep being needed (more than 25% re-fetched, with at least 5 elided), that tool is **protected for the rest of the session** and you are told.
- **Token estimates are calibrated, not guessed.** From pi's real usage numbers it learns how many characters make a token in *your* sessions (`/context-diet` shows `2.61 chars/token measured from 6 requests`). On one real set of sessions it came out at ~2, not the usual 4, which roughly doubles what stale output is worth.
- **Stale `write` / `edit` arguments are elided too.** Once a file has been written, the file on disk is the source of truth, so the old content in the tool call is dead weight. Failed calls are kept (they may be retried).

On the 221 sessions above, doing exactly this at the ~1,050 cold starts would have removed about 2.2 billion cache-read tokens, an estimated **~11% of total cost**, with no cache penalty. (An estimate: 4 characters per token and Anthropic-style cache prices from the model's own cost config.)

## Beyond eliding

- **Warming arbitration.** Pi can keep an idle prompt cache warm (`cacheWarming: "idle"`), which would remove the cold starts this plugin uses. The plugin hooks pi's `cache_warming_decision`: when warming is not worth it because enough of the context is stale, it tells pi to **stop** warming, so the cache expires and the next request is a free moment to elide. It weighs pi's own cost estimates against the stale tokens, the model's cache prices and the turns you are expected to still run. It only ever turns a "warm" into a "stop", never the reverse.
- **Compaction (opt-in).** Once a session is idle and above `compactAboveTokens` (default 150k), the plugin asks pi to compact it with pi's own summariser, with instructions to keep file paths, decisions, open tasks and errors and to drop raw output. It only ever runs when pi is idle (compacting aborts a running agent), waits a moment after a run ends, and has a cooldown. It is **off by default**: a summary is lossy, so turn it on with `/context-diet compact on` once you trust the stubs and the recovery meter.

## Install

```bash
pi install npm:pi-context-diet
# or
pi install git:github.com/sorinirimies/pi-context-diet
```

## Previews

Recorded from a real pi with only this plugin loaded; a small scripted mock model plays the agent and reports what context it **received**.

**Five tool results pile up. After a pause, stale ones arrive as stubs** (here `now` stands in for a long pause): 13.7 KB of tool output becomes 5.9 KB, and the footer shows `🥗 −1.9k /req`:

![Survey five files, force a pass, and the model reports 3 of 5 results as elided stubs](examples/vhs/generated/overview.gif)

**Stubs keep a preview, and the recovery meter tells you if eliding hurt:** the stub keeps the last lines. When the agent re-reads an elided file the footer shows `↺1` and `/context-diet` reports the cost:

![A stub with its preview, then a re-read counted as a recovery](examples/vhs/generated/recovery.gif)

**Stale `write` content is elided too** (the file on disk already holds it): the 60-line write from earlier arrives as a one-line placeholder:

![An old write call whose content is elided from the context](examples/vhs/generated/arguments.gif)

**Calibration, `show` and compaction (opt-in):** measured chars-per-token, what is elided and what is next, then pi's own compaction (here `compact now` stands in for the automatic trigger):

![Calibration, show, and compaction in real pi](examples/vhs/generated/compaction.gif)

**Commands:** settings and savings, `keep`, `ttl`, `mode`, `on` / `off`:

![/context-diet status, keep, ttl, mode, off and on](examples/vhs/generated/commands.gif)

**Tab-completion** uses pi's own menu, with a description for every option:

![Autocomplete for /context-diet and its mode sub-menu](examples/vhs/generated/completion.gif)

## Commands

| Command | What it does |
|---|---|
| `/context-diet` | Settings, savings (results elided, tokens kept out of every request, tokens saved so far, cold starts) and the recovery meter |
| `/context-diet on` · `/context-diet off` | Turn it on or off (remembered). Off means the next request sends the full history again |
| `/context-diet now` | Elide stale results on the next request, even if the cache is warm (accepts one cache rewrite) |
| `/context-diet keep <turns>` | Always keep the results of the last N assistant turns (default 20) |
| `/context-diet ttl <minutes>` | Prompt-cache lifetime: 5 for Anthropic's default, 60 for extended retention |
| `/context-diet mode <cold\|always>` | `cold` (default, free) or `always` (for providers without prompt caching) |
| `/context-diet args <on\|off>` | Also elide stale `write` / `edit` arguments (default on) |
| `/context-diet show` | List what is elided right now (biggest first) and what the next cold start would take |
| `/context-diet compact <on\|off>` | Turn automatic compaction of idle, big sessions on or off (default off) |
| `/context-diet compact now` | Compact the session right now (needs an idle session) |

Tab-completion works for all of these. Unknown input prints usage instead of failing.

## Config

`~/.pi/agent/context-diet.json` (written by the commands, editable by hand; invalid values fall back to defaults):

```json
{
  "enabled": true,
  "mode": "cold",
  "keepTurns": 20,
  "minChars": 1500,
  "cacheTtlMinutes": 5,
  "keepErrors": true,
  "neverElide": [],
  "showStatus": true,
  "stubTailLines": 3,
  "stubErrorLines": 3,
  "elideArgs": true,
  "autoProtect": true,
  "recoveryThreshold": 0.25,
  "warmArbitration": true,
  "expectedTurns": 30,
  "stopWarmingShare": 0.2,
  "compact": false,
  "compactAboveTokens": 150000
}
```

- `minChars`: results smaller than this are not worth a stub.
- `keepErrors`: error results are kept (they are short and usually matter).
- `neverElide`: tool names whose results are never elided, e.g. `["read"]`.
- `stubTailLines` / `stubErrorLines`: how many last lines and error lines a stub keeps (0 for a bare stub).
- `elideArgs`: also elide stale `write` / `edit` arguments.
- `autoProtect` / `recoveryThreshold`: protect a tool for the session when more than this share of its elided results was re-fetched.
- `warmArbitration`: let the plugin stop pi's idle cache warming when eliding is cheaper. `expectedTurns` is how many more turns a session is assumed to run (the longer, the more eliding is worth); `stopWarmingShare` is the stale share of the context at which warming stops when model prices are unknown.
- `compact` / `compactAboveTokens`: opt-in compaction of an idle session above this many tokens.
- Images and any result that is not plain text are never touched.

## What it will and will not do

- **A stub, not a loss:** the model is told what was elided and to re-run it if needed. The saved transcript on disk is unchanged.
- **Cache-safe by construction:** between cold starts the elided prefix is byte-identical (a simulated 120-turn session with two pauses is a test), so it never causes a cache miss on its own.
- **Compaction is lossy.** A summary replaces the history, so it is opt-in, runs only when idle, and keeps pi\'s own recent turns verbatim. Judge it with `/context-diet show` and the recovery meter before leaving it on.
- **`mode always` is for providers without prompt caching only:** with caching, every pass rewrites the cache. It is never silent: pi shows a warning at session start and the footer carries a `⚠ mode always` marker for as long as it is active.
- **Pi's own cache warmer** may keep the cache warm through a pause. Then there is no cold start, nothing is elided, and you lose nothing.
- **Estimates:** the figures above are estimates from one set of sessions; your mileage depends on how long your sessions run and how often you pause.

## Security notes

- **Fails open.** pi misbehaves when a `context` handler throws, so any unexpected error here means the conversation is sent unchanged. A UI that throws never changes what is sent either.
- **Read-only apart from its own config.** No network, no shell commands, no file reads outside `context-diet.json`, **zero runtime dependencies**.
- **Hand-edited config is sanitised:** wrong types and out-of-range numbers fall back to defaults.

## Development

```bash
bun install
just check          # typecheck + tests + pack check + nushell tests (what CI runs)
just test           # bun test only (with coverage)
just coverage       # tests + a coverage table
just push-all       # push main to every configured remote (origin + the Gitea instances); `just --list` has pull-all, push-tags-all, release-all, the *-force and sync-gitea-* variants
```

**Coverage:** every `bun test` collects coverage (`bunfig.toml`) and **fails below 95% lines / 95% functions**. CI shows the table on the run page and uploads `lcov.info`.

CI scripts are [nushell](https://www.nushell.sh) (`scripts/`), the same ones locally and in GitHub / Gitea Actions.
`just --list` shows every task.


## Demo recordings

The GIFs above live in [`examples/vhs/generated/`](examples/vhs/generated) and are stored with **Git LFS** (`git lfs install` once). They are recorded with [VHS](https://github.com/charmbracelet/vhs) from a **real pi** that loads only this extension, on **synthetic** data (`examples/vhs/fixture.sh`), never from real files, sessions or credentials. The agent is a scripted mock model (`examples/vhs/mock-llm.ts`) that reports what context it received.

```sh
just vhs-all          # every tape (examples/vhs/*.tape): needs vhs, ttyd, ffmpeg, pi, bun, python3
just vhs-tape overview  # one tape
just vhs-list         # list the tapes
just demo             # try it yourself in a real pi: ask it to "Survey the project"
```

## Releases (automatic)

| Workflow | When | What |
|---|---|---|
| **CI** | push / PR | quality gate on Linux; tests on macOS and Windows |
| **Auto-merge library updates** | CI finished on a Dependabot PR | **patch and minor** updates (GitHub Actions) are merged automatically, but only **after CI is green** on that exact commit; a **major** update waits for you. Then it starts the nightly workflow so the update ships |
| **Nightly Dependency Update** | every night (GitHub 02:00 UTC, Gitea 02:30) and after each auto-merge | `bun update` within ranges, verify on all platforms, commit `chore(deps)`; then **build, tag and publish a new patch** whenever a library was upgraded or merged, or `feat`/`fix`/`perf` commits are waiting since the last tag |
| **Release** | tag `vX.Y.Z` | validates the tag against `package.json`, runs the gate, `npm publish` (idempotent, with provenance), creates the release |

So library updates need no human: they are merged once CI passes, built, versioned and published as a patch. A downgrade, a failing check, or a major update stops the chain and waits for review.

Manual release: `just release patch` (or `minor` / `major` / `X.Y.Z`) bumps, tags and pushes to GitHub; `just release-all patch` pushes to every configured remote; `just push-release-all` pushes an existing bump.

**Secrets** (repo settings): `NPM_TOKEN` is an npm *granular access token* with publish rights and "bypass 2FA" (required for CI publishing). Optional: `GH_PAT` (lets a tag push trigger the release itself), `GITEA_TOKEN` (Gitea).

Commits follow [Conventional Commits](https://www.conventionalcommits.org); the changelog is generated by git-cliff.


## Related plugins

Four small [pi](https://github.com/earendil-works/pi-coding-agent) extensions that save tokens without adding anything to the system prompt:

| Plugin | What it does |
|---|---|
| [**pi-edit-first**](https://github.com/sorinirimies/pi-edit-first) | Blocks whole-file `write` rewrites and hand-written project manifests, steering the agent to targeted `edit` calls and scaffolders |
| [**pi-read-guard**](https://github.com/sorinirimies/pi-read-guard) | Blocks full reads of large files, steering the agent to `offset`/`limit` or search |
| [**pi-tokenburn**](https://github.com/sorinirimies/pi-tokenburn) | Live token and cost counter in pi's footer, with charts and budgets |
| [**pi-context-diet**](https://github.com/sorinirimies/pi-context-diet) | Drops stale tool results from the context when the prompt cache is already cold, so long sessions cost less |

```bash
pi install npm:pi-edit-first
pi install npm:pi-read-guard
pi install npm:pi-tokenburn
pi install npm:pi-context-diet
```

MIT
