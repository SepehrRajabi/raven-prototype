# Lists raven-desktop's WASAPI capture sessions per input endpoint: ACTIVE while a
# microphone stream is open, inactive once it is closed.   powershell -File mic-sessions.ps1
$src = @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
  int GetCount(out int count);
  int Item(int index, out IMMDevice device);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  int OpenPropertyStore(int access, out IntPtr props);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
  int GetAudioSessionControl(IntPtr a, int b, out IntPtr c);
  int GetSimpleAudioVolume(IntPtr a, int b, out IntPtr c);
  int GetSessionEnumerator(out IAudioSessionEnumerator e);
}
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator {
  int GetCount(out int count);
  int GetSession(int index, out IAudioSessionControl2 session);
}
[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  int GetState(out int state);
  int GetDisplayName(out IntPtr n); int SetDisplayName(IntPtr a, IntPtr b);
  int GetIconPath(out IntPtr n); int SetIconPath(IntPtr a, IntPtr b);
  int GetGroupingParam(out Guid g); int SetGroupingParam(IntPtr a, IntPtr b);
  int RegisterAudioSessionNotification(IntPtr a); int UnregisterAudioSessionNotification(IntPtr a);
  int GetSessionIdentifier(out IntPtr s); int GetSessionInstanceIdentifier(out IntPtr s);
  int GetProcessId(out uint pid);
}
public static class MicSessions {
  public static List<string> List(uint pid) {
    var result = new List<string>();
    var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
    IMMDeviceCollection col; en.EnumAudioEndpoints(1 /*capture*/, 1 /*active*/, out col);
    int n; col.GetCount(out n);
    for (int i = 0; i < n; i++) {
      IMMDevice dev; col.Item(i, out dev);
      string id; dev.GetId(out id);
      var iid = typeof(IAudioSessionManager2).GUID; object o;
      dev.Activate(ref iid, 23, IntPtr.Zero, out o);
      var mgr = (IAudioSessionManager2)o;
      IAudioSessionEnumerator se; mgr.GetSessionEnumerator(out se);
      int c; se.GetCount(out c);
      for (int j = 0; j < c; j++) {
        IAudioSessionControl2 s; se.GetSession(j, out s);
        uint p; s.GetProcessId(out p); int st; s.GetState(out st);
        if (p == pid) result.Add(id + " state=" + (st == 1 ? "ACTIVE" : st == 0 ? "inactive" : "expired"));
      }
    }
    return result;
  }
}
"@
Add-Type -TypeDefinition $src
$p = (Get-Process raven-desktop).Id
$r = [MicSessions]::List([uint32]$p)
if ($r.Count -eq 0) { "raven-desktop ($p): no capture sessions" } else { $r | ForEach-Object { "raven-desktop ($p): $_" } }
