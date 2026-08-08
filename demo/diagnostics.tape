Output assets/ish-diagnostics.gif

Require node
Require zsh

Set Shell "zsh"
Set FontSize 18
Set LetterSpacing 0
Set Width 1200
Set Height 720
Set Padding 28
Set Framerate 30
Set LoopOffset 7%
Set TypingSpeed 22ms
Set Theme "TokyoNight"
Set WindowBar "ColorfulRight"
Set WindowBarSize 38
Set BorderRadius 8
Set Margin 16
Set MarginFill "#16161e"

Hide
Type "demo/launch.sh"
Enter
Sleep 1s
Type "clear"
Enter
Sleep 500ms
Show
Type "printf '[ 812.440] thermal throttle sentinel: CPU0 crossed 92 C\\n[ 812.441] cooling state raised to 3\\n'"
Enter
Sleep 1s
Type "? analyze the kernel-style log above and tell me whether it is healthy"
Enter
Sleep 3s
