# pi-context-diet — task runner (scripts are nushell; CI runs the same ones)
# Install just: brew install just · nushell: cargo install nu --locked · bun: https://bun.sh
# Usage: just <task>

default:
    @just --list

# ── Tool checks ───────────────────────────────────────────────────────────────

_check-nu:
    @command -v nu >/dev/null 2>&1 || { echo "❌ nu (nushell) not found. Install: https://www.nushell.sh"; exit 1; }

_check-bun:
    @command -v bun >/dev/null 2>&1 || { echo "❌ bun not found. Install: https://bun.sh"; exit 1; }

_check-git-cliff:
    @command -v git-cliff >/dev/null 2>&1 || { echo "❌ git-cliff not found. Install with: cargo install git-cliff --locked"; exit 1; }

_check-vhs:
    @command -v vhs >/dev/null 2>&1 || { \
        echo "❌ vhs not found."; \
        echo "   macOS:      brew install vhs"; \
        echo "   Any:        go install github.com/charmbracelet/vhs@latest"; \
        exit 1; \
    }
    @command -v pi >/dev/null 2>&1 || { echo "❌ pi not found (the demos record the real pi)."; exit 1; }

_check-pi:
    @command -v pi >/dev/null 2>&1 || { echo "❌ pi not found."; exit 1; }

# Install dependencies
install: _check-bun
    bun install

# ── Develop ───────────────────────────────────────────────────────────────────

# Run the test suite
test: _check-bun
    bun test

# Type-check against pi's real types
typecheck: _check-bun
    bunx tsc --noEmit

# Tests with coverage (thresholds from bunfig.toml) and a summary table
coverage: _check-bun _check-nu
    bun test
    nu scripts/ci/coverage_summary.nu

# Run the Nushell script tests
test-nu: _check-nu
    nu scripts/tests/run_all.nu

# The full quality gate (typecheck + tests + pack check + nu tests) — what CI runs
check: _check-nu _check-bun
    nu scripts/ci/quality_gate.nu

# What would be published
pack: _check-nu
    npm pack --dry-run

# ── Dependencies ──────────────────────────────────────────────────────────────

# Update dependencies within their ranges, then verify (local version of the nightly job)
deps-update: _check-nu _check-bun
    #!/usr/bin/env sh
    set -e
    nu scripts/ci/snapshot_deps.nu /tmp/pi-before.txt
    bun update
    bun install
    nu scripts/ci/snapshot_deps.nu /tmp/pi-after.txt
    nu scripts/ci/dep_changes.nu /tmp/pi-before.txt /tmp/pi-after.txt
    nu scripts/ci/quality_gate.nu

# Are there feat/fix/perf commits since the last tag?
unreleased: _check-nu
    nu scripts/ci/unreleased.nu

# ── Changelog ─────────────────────────────────────────────────────────────────

changelog: _check-git-cliff
    git-cliff --output CHANGELOG.md

changelog-preview: _check-git-cliff
    @git-cliff --unreleased

# ── Release ───────────────────────────────────────────────────────────────────

# Print the current version
version: _check-nu
    @nu scripts/version.nu

# Bump (patch | minor | major | X.Y.Z): gate, edit package.json + CHANGELOG, commit, tag. Does not push.
bump kind: _check-nu _check-git-cliff
    nu scripts/bump_version.nu --yes {{ kind }}



# Dry-run the npm publish locally
publish-dry: check
    nu scripts/ci/npm_publish.nu --dry-run

# Publish locally (needs `npm login` + OTP). CI normally does this on a tag.
publish: check
    npm publish --access public

# ── Git remotes & pushing ─────────────────────────────────────────────────────
# pi-context-diet lives on GitHub (origin) and the Gitea instances: Microlab, Starscream and
# nexus-lab. Every *-all recipe loops over REMOTES, skips remotes this checkout does not have,
# and keeps going when one fails. Recipes that move history by force say so: be sure!

REMOTES := "origin gitea-microlab gitea-starscream gitea-nexus-lab"

# Show all configured remotes
remotes:
    @git remote -v

# Add the remotes this repo is expected to have (nexus-lab: `git remote add gitea-nexus-lab <url>`)
setup-remotes:
    #!/usr/bin/env sh
    git remote get-url origin >/dev/null 2>&1 || git remote add origin git@github.com:sorinirimies/pi-context-diet.git
    git remote get-url gitea-microlab >/dev/null 2>&1 || git remote add gitea-microlab ssh://git@192.168.1.204:30009/sorin/pi-context-diet.git
    git remote get-url gitea-starscream >/dev/null 2>&1 || git remote add gitea-starscream gitea@192.168.1.44:sorin/pi-context-diet.git
    git remote -v

# ── push ──

# Push the current branch to GitHub (origin)
push:
    git push origin "$(git branch --show-current)"

# Force-push the current branch to GitHub (origin). No lease!
push-force:
    git push --force origin "$(git branch --show-current)"

# Push the current branch to Gitea Microlab
push-gitea-microlab:
    git push gitea-microlab "$(git branch --show-current)"

# Force-push the current branch to Gitea Microlab. No lease!
push-gitea-microlab-force:
    git push --force gitea-microlab "$(git branch --show-current)"

# Push the current branch to Gitea Starscream
push-gitea-starscream:
    git push gitea-starscream "$(git branch --show-current)"

# Force-push the current branch to Gitea Starscream. No lease!
push-gitea-starscream-force:
    git push --force gitea-starscream "$(git branch --show-current)"

# Push the current branch to Gitea (nexus-lab instance)
push-gitea-nexus-lab:
    git push gitea-nexus-lab "$(git branch --show-current)"

# Force-push the current branch to Gitea (nexus-lab instance). No lease!
push-gitea-nexus-lab-force:
    git push --force gitea-nexus-lab "$(git branch --show-current)"

# Push the current branch to every remote (continues on failure)
push-all:
    #!/usr/bin/env sh
    failed=""
    for r in {{ REMOTES }}; do
        git remote get-url "$r" >/dev/null 2>&1 || { echo "↷ skipping $r (not configured)"; continue; }
        git push "$r" "$(git branch --show-current)" || failed="$failed $r"
    done
    if [ -n "$failed" ]; then echo "⚠️  Failed to push to:$failed"; exit 1; fi
    echo "✅ Pushed to every configured remote"

# Force-push the current branch to every remote (continues on failure). No lease!
push-all-force:
    #!/usr/bin/env sh
    failed=""
    for r in {{ REMOTES }}; do
        git remote get-url "$r" >/dev/null 2>&1 || { echo "↷ skipping $r (not configured)"; continue; }
        git push --force "$r" "$(git branch --show-current)" || failed="$failed $r"
    done
    if [ -n "$failed" ]; then echo "⚠️  Failed to force-push to:$failed"; exit 1; fi
    echo "✅ Force-pushed to every configured remote"

# ── pull ──

# Pull the current branch from GitHub (origin)
pull:
    git pull origin "$(git branch --show-current)"

# Pull the current branch from Gitea Microlab
pull-gitea-microlab:
    git pull gitea-microlab "$(git branch --show-current)"

# Pull the current branch from Gitea Starscream
pull-gitea-starscream:
    git pull gitea-starscream "$(git branch --show-current)"

# Pull the current branch from Gitea (nexus-lab instance)
pull-gitea-nexus-lab:
    git pull gitea-nexus-lab "$(git branch --show-current)"

# Pull the current branch from every remote (continues on failure)
pull-all:
    #!/usr/bin/env sh
    failed=""
    for r in {{ REMOTES }}; do
        git remote get-url "$r" >/dev/null 2>&1 || { echo "↷ skipping $r (not configured)"; continue; }
        git pull "$r" "$(git branch --show-current)" || failed="$failed $r"
    done
    if [ -n "$failed" ]; then echo "⚠️  Failed to pull from:$failed"; exit 1; fi
    echo "✅ Pulled from every configured remote"

# ── tags ──

# Push all tags to GitHub
push-tags:
    git push origin --tags

# Force-push all tags to GitHub (moves existing tags). Be sure!
push-tags-force:
    git push --force origin --tags

# Push all tags to every remote (continues on failure)
push-tags-all:
    #!/usr/bin/env sh
    failed=""
    for r in {{ REMOTES }}; do
        git remote get-url "$r" >/dev/null 2>&1 || { echo "↷ skipping $r (not configured)"; continue; }
        git push "$r" --tags || failed="$failed $r"
    done
    if [ -n "$failed" ]; then echo "⚠️  Failed to push tags to:$failed"; exit 1; fi
    echo "✅ Tags pushed to every configured remote"

# Force-push all tags to every remote (continues on failure; moves existing tags). Be sure!
push-tags-all-force:
    #!/usr/bin/env sh
    failed=""
    for r in {{ REMOTES }}; do
        git remote get-url "$r" >/dev/null 2>&1 || { echo "↷ skipping $r (not configured)"; continue; }
        git push --force "$r" --tags || failed="$failed $r"
    done
    if [ -n "$failed" ]; then echo "⚠️  Failed to force-push tags to:$failed"; exit 1; fi
    echo "✅ Tags force-pushed to every configured remote"

# ── release ──
# Pushing a vX.Y.Z tag starts the Release workflow on whichever host receives it
# (GitHub: .github/workflows/release.yml, Gitea: .gitea/workflows/release.yml).

# Bump (patch | minor | major | X.Y.Z), commit, tag, then push to GitHub: triggers the Release workflow
release kind: (bump kind)
    @echo "Pushing release v$(nu scripts/version.nu) to GitHub…"
    git push --follow-tags origin "$(git branch --show-current)"
    @echo "✅ Release v$(nu scripts/version.nu) pushed: the Release workflow will trigger automatically."

# Bump, commit, tag, then push to Gitea Microlab only
release-gitea-microlab kind: (bump kind)
    @echo "Pushing release v$(nu scripts/version.nu) to Gitea Microlab…"
    git push --follow-tags gitea-microlab "$(git branch --show-current)"
    @echo "✅ Release v$(nu scripts/version.nu) live on Gitea Microlab."

# Bump, commit, tag, then push to Gitea Starscream only
release-gitea-starscream kind: (bump kind)
    @echo "Pushing release v$(nu scripts/version.nu) to Gitea Starscream…"
    git push --follow-tags gitea-starscream "$(git branch --show-current)"
    @echo "✅ Release v$(nu scripts/version.nu) live on Gitea Starscream."

# Bump, commit, tag, then push to Gitea (nexus-lab instance) only
release-gitea-nexus-lab kind: (bump kind)
    @echo "Pushing release v$(nu scripts/version.nu) to Gitea (nexus-lab instance)…"
    git push --follow-tags gitea-nexus-lab "$(git branch --show-current)"
    @echo "✅ Release v$(nu scripts/version.nu) live on Gitea (nexus-lab instance)."

# Bump, commit, tag, then push to every remote (continues on failure)
release-all kind: (bump kind)
    #!/usr/bin/env sh
    failed=""
    for r in {{ REMOTES }}; do
        git remote get-url "$r" >/dev/null 2>&1 || { echo "↷ skipping $r (not configured)"; continue; }
        git push --follow-tags "$r" "$(git branch --show-current)" || failed="$failed $r"
    done
    if [ -n "$failed" ]; then echo "⚠️  Release failed to push to:$failed"; exit 1; fi
    echo "✅ Release v$(nu scripts/version.nu) pushed to every configured remote"

# Push the latest commit and its tags to every remote, no bump (continues on failure)
push-release-all: check
    #!/usr/bin/env sh
    failed=""
    for r in {{ REMOTES }}; do
        git remote get-url "$r" >/dev/null 2>&1 || { echo "↷ skipping $r (not configured)"; continue; }
        git push --follow-tags "$r" "$(git branch --show-current)" || failed="$failed $r"
    done
    if [ -n "$failed" ]; then echo "⚠️  Failed to push to:$failed"; exit 1; fi
    echo "✅ Latest commit and tags pushed to every configured remote"

# Force-push the latest commit and its tags to every remote, no bump. Be sure!
push-release-all-force: check
    #!/usr/bin/env sh
    failed=""
    for r in {{ REMOTES }}; do
        git remote get-url "$r" >/dev/null 2>&1 || { echo "↷ skipping $r (not configured)"; continue; }
        git push --force --follow-tags "$r" "$(git branch --show-current)" || failed="$failed $r"
    done
    if [ -n "$failed" ]; then echo "⚠️  Failed to force-push to:$failed"; exit 1; fi
    echo "✅ Latest commit and tags force-pushed to every configured remote"

# Short name for push-release-all
alias release-push := push-release-all

# Manually re-trigger the Release workflow for an existing tag via the gh CLI
release-retrigger version:
    @command -v gh >/dev/null 2>&1 || { echo "❌ GitHub CLI (gh) not found. Install from https://cli.github.com"; exit 1; }
    @echo "Manually dispatching the Release workflow for tag v{{ version }}…"
    gh workflow run release.yml -f tag=v{{ version }}
    @echo "✅ Dispatched. Progress: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/actions"

# ── force-sync Gitea with GitHub (main + tags) ──

# Force-sync Gitea Microlab with GitHub
sync-gitea-microlab:
    git push gitea-microlab "$(git branch --show-current)" --force
    git push gitea-microlab --tags --force
    @echo "✅ Gitea Microlab force-synced with GitHub."

# Force-sync Gitea Starscream with GitHub
sync-gitea-starscream:
    git push gitea-starscream "$(git branch --show-current)" --force
    git push gitea-starscream --tags --force
    @echo "✅ Gitea Starscream force-synced with GitHub."

# Force-sync Gitea (nexus-lab instance) with GitHub
sync-gitea-nexus-lab:
    git push gitea-nexus-lab "$(git branch --show-current)" --force
    git push gitea-nexus-lab --tags --force
    @echo "✅ Gitea (nexus-lab instance) force-synced with GitHub."

# Force-sync every configured Gitea instance with GitHub (continues on failure)
sync-all-gitea:
    #!/usr/bin/env sh
    failed=""
    for r in gitea-microlab gitea-starscream gitea-nexus-lab; do
        git remote get-url "$r" >/dev/null 2>&1 || { echo "↷ skipping $r (not configured)"; continue; }
        git push "$r" "$(git branch --show-current)" --force && git push "$r" --tags --force || failed="$failed $r"
    done
    if [ -n "$failed" ]; then echo "⚠️  Failed to sync:$failed"; exit 1; fi
    echo "✅ Every configured Gitea instance force-synced with GitHub."

# ── VHS demo GIFs ─────────────────────────────────────────────────────────────

VHS := "examples/vhs"
VHS_GENERATED := "examples/vhs/generated"

# Record every demo GIF (a real pi with only this plugin, on synthetic data; needs vhs, ttyd, ffmpeg, pi, bun, python3)
vhs-all: _check-vhs _check-bun
    #!/usr/bin/env sh
    set -e
    mkdir -p {{ VHS_GENERATED }}
    echo "╔════════════════════════════════════════════╗"
    echo "║   Tapes (pi-context-diet, VHS)               ║"
    echo "╚════════════════════════════════════════════╝"
    for tape in {{ VHS }}/*.tape; do
        [ -f "$tape" ] || continue
        echo "▶  $tape"
        vhs "$tape" || echo "❌ Failed: $tape"
    done
    echo "✅ Demos done → {{ VHS_GENERATED }}/  (tracked with Git LFS: git lfs install once)"

# Render a single tape by name (e.g. just vhs-tape overview)
vhs-tape name: _check-vhs _check-bun
    #!/usr/bin/env sh
    if [ -f "{{ VHS }}/{{ name }}.tape" ]; then
        vhs "{{ VHS }}/{{ name }}.tape" && echo "✅ Done."
    else
        echo "❌ Tape not found: {{ name }}.tape"
        just vhs-list
        exit 1
    fi

# List all VHS tapes
vhs-list:
    @ls {{ VHS }}/*.tape | sed 's|.*/||; s|\.tape||' | sed 's/^/  /'

# Try it in a real pi on the synthetic demo project with a scripted mock model (try: "Survey the project", then /context-diet now, then "What do you still know?")
demo: _check-pi _check-bun
    #!/usr/bin/env sh
    set -e
    bash {{ VHS }}/fixture.sh
    eval "$(bash {{ VHS }}/fixture.sh env)"
    bun {{ VHS }}/mock-llm.ts 8993 &
    mock=$!
    trap 'kill $mock 2>/dev/null' EXIT
    sleep 1
    bash {{ VHS }}/pi-demo.sh
