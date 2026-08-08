Output assets/ish-capabilities.gif

Require node
Require zsh

Set Shell "zsh"
Set FontSize 17
Set LetterSpacing 0
Set Width 1200
Set Height 720
Set Padding 28
Set Framerate 30
Set LoopOffset 7%
Set TypingSpeed 18ms
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
Type "ish capability enable web --provider brave"
Enter
Sleep 2s
Type "ish mcp add docs --command docs-mcp --version 1.2.3 --tools search,fetch --authority observation --approval none -- --stdio"
Enter
Sleep 2s
Type "ish capability list"
Enter
Sleep 3s
