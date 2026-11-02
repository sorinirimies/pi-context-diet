#!/usr/bin/env nu
# Tests for scripts/vhs.nu and the demo helpers in examples/vhs/

use std/assert
use runner.nu *
use ../vhs.nu [tape_names missing parse_env]
use ../../examples/vhs/fixture.nu [env_lines models]
use ../../examples/vhs/pi-demo.nu [pi_args]

def "test vhs: tape names are sorted and only tapes" [] {
    assert equal (tape_names [examples/vhs/status.tape examples/vhs/charts.tape examples/vhs/fixture.nu]) [charts status]
}

def "test vhs: missing tools" [] {
    assert equal (missing [vhs pi bun]) []
    assert equal (missing [bun]) [vhs pi]
}

def "test vhs: fixture env round-trips into load-env" [] {
    let e = parse_env (env_lines /tmp/demo)
    assert equal $e {HOME: /tmp/demo/home, PI_CODING_AGENT_DIR: /tmp/demo/agent, PI_OFFLINE: "1", TZ: UTC}
}

def "test vhs: the demo model is the local mock" [] {
    assert equal (models 8993).providers.demo.baseUrl "http://127.0.0.1:8993/v1"
}

def "test vhs: pi runs with only this plugin and the demo tools" [] {
    let a = pi_args /r
    assert equal ($a | take 3) [--no-extensions -e /r/extensions/context-diet.ts]
    assert ("--no-session" in $a)
    assert equal ($a | skip until {|x| $x == "--tools" } | get 1) "read,write"
}

def "test vhs: each module is over the 1.5 KB elision threshold" [] {
    use ../../examples/vhs/fixture.nu [source_module]
    let size = source_module 0 orders | str length
    assert ($size > 1500)
}

def main [] { run-tests }
