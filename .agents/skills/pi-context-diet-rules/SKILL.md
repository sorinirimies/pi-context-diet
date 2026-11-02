---
name: pi-context-diet-rules
description: Rules for work in the pi-context-diet repository that the code can't show: constraints, ownership and must-keep behaviour. Use before changing, fixing, reviewing or extending code here, together with the typescript-in-projects skill.
---

# pi-context-diet: rules the code can't show

Hard constraints for this repository. The general conventions (orientation, tests,
scripting, releasing) are in the `typescript-in-projects` skill; this file holds only what is
specific to pi-context-diet.

* **Elides only when the prompt cache is already cold**; between cold starts the
  elided prefix must stay byte-identical (the 120-turn simulation test guards it).
* Compaction is opt-in and runs only when pi is idle. `mode always` must stay loud
  (session-start warning, footer marker).
* Warming arbitration only ever turns "warm" into "stop", never the reverse.
