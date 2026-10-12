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

# Push main and the newest tag — CI then publishes to npm
release-push:
    #!/usr/bin/env sh
    set -e
    tag="v$(nu scripts/version.nu)"
    nu scripts/ci/validate_tag.nu "$tag" >/dev/null
    git push origin main
    git push origin "$tag"
    echo "🚀 pushed $tag — the Release workflow publishes it"

# Dry-run the npm publish locally
publish-dry: check
    nu scripts/ci/npm_publish.nu --dry-run

# Publish locally (needs `npm login` + OTP). CI normally does this on a tag.
publish: check
    npm publish --access public

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
