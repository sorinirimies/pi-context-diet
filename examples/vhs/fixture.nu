#!/usr/bin/env nu
# Builds the throw-away project and pi config the pi-context-diet demos (VHS tapes) run on, so no
# real file, path or setting ever ends up in a recording.
#
#   nu examples/vhs/fixture.nu          create /tmp/pi-context-diet-demo (five ~2.7 KB source files)
#   nu examples/vhs/fixture.nu env      print the environment the demos run with
#
# Run pi against it with:   eval "$(nu examples/vhs/fixture.nu env)"

const PORT = 8993
const MODULES = [orders inventory billing shipping reports]

# A plausible ~2.7 KB module (well over the 1.5 KB a tool result needs to be worth eliding).
export def source_module [n: int, name: string]: nothing -> string {
    let row = $"($name | str capitalize)Row"
    mut lines = [$"// ($name): demo module for the shop." $"export interface ($row) { id: string; qty: number; price: number }" ""]
    for i in 0..13 {
        let factor = 1 + (($i + $n) mod 9) / 100 | into string --decimals 2
        $lines = ($lines | append [$"export function ($name)Total($i)\(rows: ($row)[]\): number {" "  let sum = 0;" "  for (const row of rows) {" $"    sum += row.qty * row.price * ($factor);" "  }" "  return Math.round(sum * 100) / 100;" "}" ""])
    }
    $lines | str join "\n"
}

# The environment the demos run with, as `export K=V` lines for `eval`.
export def env_lines [demo: string]: nothing -> string {
    [$"export HOME=($demo)/home" $"export PI_CODING_AGENT_DIR=($demo)/agent" "export PI_OFFLINE=1" "export TZ=UTC"] | str join "\n"
}

# A local demo model served by examples/vhs/mock-llm.ts (also stops pi's "no models" banner).
export def models [port: int]: nothing -> record {
    {providers: {demo: {baseUrl: $"http://127.0.0.1:($port)/v1", api: openai-completions, apiKey: demo, models: [{id: demo-model, name: demo-model, contextWindow: 200000, maxTokens: 8192, cost: {input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75}}]}}}
}

# Resolve symlinks (/tmp is /private/tmp on macOS) so pi's footer can show `~/…` for the project.
def demo_dir [] { mkdir /tmp/pi-context-diet-demo; "/tmp/pi-context-diet-demo" | path expand }

def "main env" [] { print (env_lines (demo_dir)) }

def main [] {
    let demo = demo_dir
    rm -rf $demo
    let src = $demo | path join home projects my-app src
    let agent = $demo | path join agent
    mkdir $src $agent
    for m in ($MODULES | enumerate) { source_module $m.index $m.item | save --raw ($src | path join $"($m.item).ts") }
    models $PORT | to json | save --raw ($agent | path join models.json)
    # tiny thresholds so a five-file demo is big enough to compact
    {defaultProvider: demo, defaultModel: demo-model, theme: dark, defaultThinkingLevel: off, lastChangelogVersion: "9.9.9", quietStartup: header, compaction: {enabled: true, reserveTokens: 2000, keepRecentTokens: 1500}} | to json | save --raw ($agent | path join settings.json)
    # keep only the last 2 turns' results so a five-file survey shows the effect without a long session
    {enabled: true, mode: cold, keepTurns: 2, minChars: 1500, cacheTtlMinutes: 5} | to json | save --raw ($agent | path join context-diet.json)
    print $"fixture ready: ($demo)"
}
