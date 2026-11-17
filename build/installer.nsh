; CrossDrop 安装程序的自定义 NSIS 行为
;
; 卸载时除了 electron-builder 默认清理的内容，还会：
;   1) 结束可能残留的应用进程
;   2) 清空安装目录内用户后来放入的文件
;   3) 由临时脚本在卸载器退出后删除整个安装目录（卸载器自身正被占用，需延迟执行）

!macro customUnInstall
  SetOutPath "$TEMP"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\swiftshader"
  Delete "$INSTDIR\*.exe"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.ico"
  Delete "$INSTDIR\*.txt"
  RMDir "$INSTDIR"

  ; 卸载器自己仍在 $INSTDIR 中运行，交给临时批处理在退出后收尾
  InitPluginsDir
  FileOpen $0 "$TEMP\crossdrop-uninstall-cleanup.bat" w
  FileWrite $0 "timeout /t 3 /nobreak >nul$\r$\n"
  FileWrite $0 "rmdir /s /q $\"$INSTDIR$\"$\r$\n"
  FileWrite $0 "del /f /q $\"$TEMP\crossdrop-uninstall-cleanup.bat$\"$\r$\n"
  FileClose $0
  ExecShell "open" "$TEMP\crossdrop-uninstall-cleanup.bat" SW_HIDE
!macroend
