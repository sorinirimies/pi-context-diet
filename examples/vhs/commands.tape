# VHS tape: commands
# /context-diet shows the settings and the savings. keep, ttl and mode tune it; on / off switch it;
# `now` forces a pass on the next request.
#
# Runs a real pi with only the pi-context-diet extension loaded (and pi's built-in read tool), on the
# throw-away project from fixture.sh. A tiny scripted mock model (mock-llm.ts) plays the agent and
# tells you what context it RECEIVED, so the recording shows the extension's effect. HOME and the pi
# agent dir are redirected into /tmp: it never touches your real files or settings.

Output examples/vhs/generated/commands.gif

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

Sleep 1.5s
Type "/context-diet"
Sleep 700ms
Enter
Sleep 300ms
Enter
Sleep 2.5s
Type "/context-diet keep 5"
Sleep 600ms
Enter
Sleep 2s
Type "/context-diet ttl 60"
Sleep 600ms
Enter
Sleep 2s
Type "/context-diet mode always"
Sleep 700ms
Enter
Sleep 300ms
Enter
Sleep 2.5s
Type "/context-diet mode cold"
Sleep 700ms
Enter
Sleep 300ms
Enter
Sleep 2.5s
Type "/context-diet off"
Sleep 700ms
Enter
Sleep 300ms
Enter
Sleep 2.5s
Type "/context-diet on"
Sleep 700ms
Enter
Sleep 300ms
Enter
Sleep 2.5s

# (hidden) quit pi, then stop the mock model
Hide
Ctrl+D
Sleep 1s
Type "pkill -f mock-llm"
Enter
Sleep 500ms
