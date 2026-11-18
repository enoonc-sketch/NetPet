; 卸载时：清除开机自启项，并询问是否删除本地数据（静默卸载/升级时默认保留）
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "NetPet"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "netpet"
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除 NetPet 的本地数据（设置、统计、连接记录）？$\r$\n选“否”会保留数据，方便以后重新安装。" /SD IDNO IDNO keepdata
    RMDir /r "$APPDATA\NetPet"
  keepdata:
!macroend
