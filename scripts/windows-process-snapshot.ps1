param(
    [int]$RootProcessId = 0,
    [string]$ProcessIdCsv = ''
)

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class WindowsProcessSnapshot
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    public sealed class Entry
    {
        public int ProcessId { get; set; }
        public int ParentProcessId { get; set; }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static Entry[] Capture()
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1))
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }

        try
        {
            var entries = new List<Entry>();
            var entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32FirstW(snapshot, ref entry))
            {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }

            do
            {
                entries.Add(new Entry
                {
                    ProcessId = (int)entry.th32ProcessID,
                    ParentProcessId = (int)entry.th32ParentProcessID,
                });
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            }
            while (Process32NextW(snapshot, ref entry));

            return entries.ToArray();
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

$snapshot = [WindowsProcessSnapshot]::Capture()
$selected = @()
if ($ProcessIdCsv.Length -gt 0) {
    $wanted = @{}
    foreach ($value in $ProcessIdCsv.Split(',')) {
        $wanted[[int]$value] = $true
    }
    $selected = @($snapshot | Where-Object { $wanted.ContainsKey($_.ProcessId) })
}
elseif ($RootProcessId -gt 0) {
    $queue = New-Object System.Collections.Generic.Queue[int]
    $seen = @{}
    $queue.Enqueue($RootProcessId)
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        if ($seen.ContainsKey($current)) {
            continue
        }
        $seen[$current] = $true
        foreach ($entry in $snapshot) {
            if ($entry.ProcessId -eq $current) {
                $selected += $entry
            }
            elseif ($entry.ParentProcessId -eq $current) {
                $queue.Enqueue($entry.ProcessId)
            }
        }
    }
}

$result = @()
foreach ($entry in $selected) {
    $startedAt = $null
    try {
        $startedAt = (Get-Process -Id $entry.ProcessId -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()
    }
    catch {
        # A process that exited or is inaccessible has an unknown start time.
        $startedAt = $null
    }

    $result += [PSCustomObject]@{
        processId = $entry.ProcessId
        parentProcessId = $entry.ParentProcessId
        startedAt = $startedAt
    }
}

ConvertTo-Json -InputObject @($result) -Compress
