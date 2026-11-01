# Re-record the terminal demo with VHS (https://github.com/charmbracelet/vhs): vhs docs/demo.tape
# Prepare a scenario repository first (prints its path):
#   node examples/demo-shop/try.mjs ai-refactor
Output docs/assets/demo.gif
Set FontSize 15
Set Width 1000
Set Height 640
Set Theme "Dracula"
Set TypingSpeed 40ms

Type "npx doppeldiff --base main --claim-file pr.md"
Sleep 500ms
Enter
Sleep 9s
