#!/usr/bin/env nu
# Demo GIFs with VHS: a real pi with only this plugin and a scripted mock model, on the
# synthetic fixture (examples/vhs/fixture.nu). Needs vhs, ttyd, ffmpeg, pi, bun, nu.
#
#   nu scripts/vhs.nu list           the tapes
#   nu scripts/vhs.nu all            record every tape (exit 1 if one failed)
#   nu scripts/vhs.nu tape <name>    record one tape
#   nu scripts/vhs.nu demo           try the plugin yourself in pi on the fixture

const DIR = "examples/vhs"
const GENERATED = "examples/vhs/generated"
const MOCK_PORT = 8993
const NEEDS = {vhs: "brew install vhs (or: go install github.com/charmbracelet/vhs@latest)", pi: "the demos record the real pi: npm i -g @earendil-works/pi-coding-agent"}

# Tape names (without .tape) among file paths, sorted.
export def tape_names [files: list<string>]: nothing -> list<string> {
    $files | where {|f| $f | str ends-with ".tape" } | each {|f| $f | path basename | str replace --regex '\.tape$' "" } | sort
}

# The tools of NEEDS that are not installed, given the installed ones.
export def missing [installed: list<string>]: nothing -> list<string> {
    $NEEDS | columns | where {|t| $t not-in $installed }
}

# `export K=V` lines (fixture.nu env) as a record for load-env.
export def parse_env [text: string]: nothing -> record {
    $text | lines | parse --regex '^export (?<k>[A-Z_]+)=(?<v>.*)$' | transpose --header-row --as-record
}

def check [] {
    let miss = missing ($NEEDS | columns | where {|t| which $t | is-not-empty })
    for t in $miss { print -e $"❌ ($t) not found: ($NEEDS | get $t)" }
    if ($miss | is-not-empty) { exit 1 }
}

def names [] { tape_names (ls $DIR | get name) }

def "main list" [] { for n in (names) { print $"  ($n)" } }

def "main tape" [name: string] {
    if $name not-in (names) {
        print -e $"❌ Tape not found: ($name).tape"
        main list
        exit 1
    }
    check
    ^vhs $"($DIR)/($name).tape"
    print -e "✅ Done."
}

def "main all" [] {
    check
    mkdir $GENERATED
    mut failed = []
    for n in (names) {
        print -e $"▶  ($DIR)/($n).tape"
        if (do { ^vhs $"($DIR)/($n).tape" } | complete).exit_code != 0 { $failed = ($failed | append $n) }
    }
    print $"failed=($failed | str join ',')"
    if ($failed | is-not-empty) { exit 1 }
    print -e $"✅ Demos done → ($GENERATED)/  \(tracked with Git LFS: git lfs install once\)"
}

def "main demo" [] {
    check
    ^nu $"($DIR)/fixture.nu"
    load-env (parse_env (^nu $"($DIR)/fixture.nu" env))
    let mock = job spawn { ^bun $"($DIR)/mock-llm.ts" $MOCK_PORT out> /dev/null err> /dev/null }
    sleep 1sec
    try { ^nu $"($DIR)/pi-demo.nu" } catch { }
    job kill $mock
}

def main [] { print "usage: nu scripts/vhs.nu (list | all | tape <name> | demo)" }
