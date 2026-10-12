#!/usr/bin/env bash
# Builds the throw-away project and pi config the pi-context-diet demos (VHS tapes) run on, so no
# real file, path or setting ever ends up in a recording.
#
#   examples/vhs/fixture.sh            create /tmp/pi-context-diet-demo (five ~4 KB source files)
#   examples/vhs/fixture.sh env        print the environment the demos run with
#
# Run pi against it with:   eval "$(examples/vhs/fixture.sh env)"
set -euo pipefail

# Resolve symlinks (/tmp is /private/tmp on macOS) so pi's footer can show `~/…` for the project.
mkdir -p /tmp/pi-context-diet-demo
DEMO="$(cd /tmp/pi-context-diet-demo && pwd -P)"
PORT=8993

if [ "${1:-}" = "env" ]; then
    cat <<ENV
export HOME=$DEMO/home
export PI_CODING_AGENT_DIR=$DEMO/agent
export PI_OFFLINE=1
export TZ=UTC
ENV
    exit 0
fi

rm -rf "$DEMO"
mkdir -p "$DEMO/home/projects/my-app/src" "$DEMO/agent"

python3 - "$DEMO" "$PORT" <<'PY'
import json, os, sys
root, port = sys.argv[1], sys.argv[2]
app = os.path.join(root, "home", "projects", "my-app")

# five plausible modules, ~4 KB each (well over the 1.5 KB a tool result needs to be worth eliding)
for n, name in enumerate(["orders", "inventory", "billing", "shipping", "reports"]):
    lines = [f"// {name}: demo module for the shop.", f"export interface {name.title()}Row {{ id: string; qty: number; price: number }}", ""]
    for i in range(14):
        lines += [
            f"export function {name}Total{i}(rows: {name.title()}Row[]): number {{",
            "  let sum = 0;",
            "  for (const row of rows) {",
            f"    sum += row.qty * row.price * {1 + ((i + n) % 9) / 100:.2f};",
            "  }",
            "  return Math.round(sum * 100) / 100;",
            "}",
            "",
        ]
    open(os.path.join(app, "src", f"{name}.ts"), "w").write("\n".join(lines))

agent = os.path.join(root, "agent")
with open(os.path.join(agent, "models.json"), "w") as f:
    json.dump({"providers": {"demo": {"baseUrl": f"http://127.0.0.1:{port}/v1", "api": "openai-completions",
               "apiKey": "demo", "models": [{"id": "demo-model", "name": "demo-model", "contextWindow": 200000,
               "maxTokens": 8192, "cost": {"input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75}}]}}}, f, indent=2)
with open(os.path.join(agent, "settings.json"), "w") as f:
    json.dump({"defaultProvider": "demo", "defaultModel": "demo-model", "theme": "dark",
               "defaultThinkingLevel": "off", "lastChangelogVersion": "9.9.9", "quietStartup": "header",
               # tiny thresholds so a five-file demo is big enough to compact
               "compaction": {"enabled": True, "reserveTokens": 2000, "keepRecentTokens": 1500}}, f, indent=2)
# keep only the last 2 turns' results so a five-file survey shows the effect without a long session
with open(os.path.join(agent, "context-diet.json"), "w") as f:
    json.dump({"enabled": True, "mode": "cold", "keepTurns": 2, "minChars": 1500, "cacheTtlMinutes": 5}, f, indent=2)
PY
echo "fixture ready: $DEMO"
