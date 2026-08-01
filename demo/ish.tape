Output assets/ish-demo.gif

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
Set TypingSpeed 24ms
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
Type "printf 'native path  →  '; command -v ls"
Enter
Sleep 1s

Type "? what shell is this, and what makes it different?"
Enter
Sleep 2s

Type "/capsules"
Enter
Sleep 2s

Type "mkdir -p /tmp/ish-demo-cache"
Enter
Sleep 500ms
Type "rm -rf /tmp/ish-demo-cache"
Enter
Sleep 2s
Type "n"
Sleep 2s

Type "printf 'still here  →  '; test -d /tmp/ish-demo-cache && echo protected"
Enter
Sleep 3s
