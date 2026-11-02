Output demo.gif
Require npx

Set Shell "zsh"
Set FontSize 15
Set Width 1300
Set Height 760
Set Padding 18
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set WindowBar Colorful

Hide
Type "unset NODE_OPTIONS; setopt interactivecomments; export PS1='$ '; rm -rf docs/.markindex; clear"
Enter
Sleep 3s
Show

Type "# 5 long docs: two JPMorgan 10-Ks, two Chinese laws, a clinical guideline"
Enter
Sleep 800ms
Type "npx markindex index ./docs"
Enter
Wait+Screen@60s /added 5, updated 0/
Sleep 2s

Type "npx markindex tree ./docs law/劳动合同法.md --depth 1"
Enter
Wait+Screen@30s /f3f9b92a01/
Sleep 4s

Type "clear"
Enter
Type "npx markindex search ./docs '解除劳动合同 经济补偿' --limit 2"
Enter
Wait+Screen@30s /c3645c1a58/
Sleep 4s

Type "npx markindex search ./docs 'head office 383 Madison' --limit 2"
Enter
Wait+Screen@30s /L1058-1097/
Sleep 5s

Type "# agents get the same as 5 MCP tools: npx markindex mcp ./docs"
Enter
Sleep 3s
