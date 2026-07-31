; 仅注册「打开方式」：不改写 .ext 的默认 ProgID（不影响记事本等默认打开）
!macro customInstall
  WriteRegNone SHELL_CONTEXT "Software\Classes\.txt\OpenWithProgids" "ColorTxt.txt"
  WriteRegStr SHELL_CONTEXT "Software\Classes\ColorTxt.txt" "" "用彩读打开"
  WriteRegStr SHELL_CONTEXT "Software\Classes\ColorTxt.txt\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\ColorTxt.txt\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegNone SHELL_CONTEXT "Software\Classes\.md\OpenWithProgids" "ColorTxt.md"
  WriteRegStr SHELL_CONTEXT "Software\Classes\ColorTxt.md" "" "用彩读打开"
  WriteRegStr SHELL_CONTEXT "Software\Classes\ColorTxt.md\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\ColorTxt.md\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.txt\OpenWithProgids" "ColorTxt.txt"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\ColorTxt.txt"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.md\OpenWithProgids" "ColorTxt.md"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\ColorTxt.md"
!macroend
