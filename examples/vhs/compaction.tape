# VHS tape: compaction
# Beyond eliding: the plugin measures chars-per-token from pi's real usage, `show` lists what is elided
# and what is next, and compaction (opt-in) replaces a big idle session with pi's own summary. Here
# `compact now` stands in for the automatic trigger (an idle session above the size limit).
#
# Runs a real pi with only the pi-context-diet extension loaded (and pi's built-in read and write
# tools), on the throw-away project from fixture.sh. A tiny scripted mock model (mock-llm.ts) plays
# the agent and tells you what context it RECEIVED, so the recording shows the extension's effect.
# HOME and the pi agent dir are redirected into /tmp: it never touches your real files or settings.

Output examples/vhs/generated/compaction.gif

Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 720
Set Padding 24
Set PlaybackSpeed 1.0
Set Theme "Catppuccin Mocha"

Hide
Type 'bash examples/vhs/fixture.sh >/dev/null && echo DONE-$((6*7))'
Enter
Wait+Screen@60s /DONE-42/
Type 'eval "$(examples/vhs/fixture.sh env)" && (bun examples/vhs/mock-llm.ts 8993 >/dev/null 2>&1 &) ; sleep 1 ; clear'
Enter
Type "bash examples/vhs/pi-demo.sh"
Enter
Wait+Screen@30s /demo-model/
Show

Sleep 2s
Type "Survey the project"
Sleep 800ms
Enter
Wait+Screen@40s /Surveyed 5 files/
Sleep 2s
# measured from pi's own usage numbers, and what the next cold start would take
Type "/context-diet"
Sleep 700ms
Enter
Sleep 300ms
Enter
Sleep 4.5s
Type "/context-diet show"
Sleep 700ms
Enter
Sleep 300ms
Enter
Sleep 4s
# compact the session with pi's own summariser
Type "/context-diet compact now"
Sleep 700ms
Enter
Sleep 300ms
Enter
Wait+Screen@40s /compaction done/
Sleep 2.5s
Type "What do you still know?"
Sleep 800ms
Enter
Wait+Screen@40s /Context I received: [0-9]+ tool results/
Sleep 4s

# (hidden) quit pi, then stop the mock model
Hide
Ctrl+D
Sleep 1s
Type "pkill -f mock-llm"
Enter
Sleep 500ms
