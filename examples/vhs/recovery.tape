# VHS tape: recovery
# What an elided result leaves behind (its last lines and any error lines), and what happens when the
# agent needs one again: it re-reads the file, the footer shows the re-fetch (↺1), and /context-diet
# reports the real cost, so you can see whether eliding hurt.
#
# Runs a real pi with only the pi-context-diet extension loaded (and pi's built-in read and write
# tools), on the throw-away project from fixture.sh. A tiny scripted mock model (mock-llm.ts) plays
# the agent and tells you what context it RECEIVED, so the recording shows the extension's effect.
# HOME and the pi agent dir are redirected into /tmp: it never touches your real files or settings.

Output examples/vhs/generated/recovery.gif

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
Type "/context-diet now"
Sleep 700ms
Enter
Sleep 300ms
Enter
Sleep 1.5s
Type "Show me one stub"
Sleep 800ms
Enter
Wait+Screen@40s /first stub I received/
Sleep 5s
Type "Read the first file again"
Sleep 800ms
Enter
Wait+Screen@40s /Read it again/
Sleep 3s
Type "/context-diet"
Sleep 700ms
Enter
Sleep 300ms
Enter
Sleep 5s

# (hidden) quit pi, then stop the mock model
Hide
Ctrl+D
Sleep 1s
Type "pkill -f mock-llm"
Enter
Sleep 500ms
