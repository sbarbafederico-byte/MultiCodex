using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace MultiCodex {
    public sealed class ProcessRow {
        public uint ProcessId;
        public uint ParentProcessId;
        public string Name;
        public string ExecutablePath;
    }
    public static class ProcessSnapshot {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct ProcessEntry {
            public uint dwSize, cntUsage, th32ProcessID;
            public UIntPtr th32DefaultHeapID;
            public uint th32ModuleID, cntThreads, th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
        [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        public static string ImagePath(uint processId) {
            IntPtr handle = OpenProcess(0x1000, false, processId);
            if (handle == IntPtr.Zero) return null;
            try {
                int length = 32768;
                StringBuilder name = new StringBuilder(length);
                return QueryFullProcessImageName(handle, 0, name, ref length) ? name.ToString() : null;
            } finally { CloseHandle(handle); }
        }
        public static ProcessRow[] Read() {
            IntPtr handle = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS only
            if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                var entry = new ProcessEntry();
                entry.dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry));
                var rows = new List<ProcessRow>();
                if (!Process32First(handle, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());
                do {
                    bool codex = string.Equals(entry.szExeFile, "ChatGPT.exe", StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(entry.szExeFile, "Codex.exe", StringComparison.OrdinalIgnoreCase);
                    rows.Add(new ProcessRow { ProcessId = entry.th32ProcessID, ParentProcessId = entry.th32ParentProcessID,
                        Name = entry.szExeFile, ExecutablePath = codex ? ImagePath(entry.th32ProcessID) : null });
                } while (Process32Next(handle, ref entry));
                int error = Marshal.GetLastWin32Error();
                if (error != 18) throw new Win32Exception(error); // ERROR_NO_MORE_FILES
                return rows.ToArray();
            } finally { CloseHandle(handle); }
        }
    }
}
