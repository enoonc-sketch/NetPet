; 卸载时：清除开机自启项，并询问是否删除本地数据（静默卸载/升级时默认保留）
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "NetPet"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "netpet"
  ; 1.4.0：不同 Electron 版本登记的自启项名称可能不同（如 electron.app.NetPet），一并清除；不存在时无影响
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.NetPet"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.netpet.app"
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除 NetPet 的本地数据（设置、统计、连接记录）？$\r$\n选“否”会保留数据，方便以后重新安装。" /SD IDNO IDNO keepdata
    RMDir /r "$APPDATA\NetPet"
  keepdata:
!macroend
