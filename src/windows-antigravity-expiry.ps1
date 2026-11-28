$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AntigravityCredential {
    [StructLayout(LayoutKind.Sequential)]
    public struct Entry {
        public UInt32 Flags;
        public UInt32 Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 BlobSize;
        public IntPtr Blob;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr entry);

    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr entry);
}
'@

$pointer = [IntPtr]::Zero
if (-not [AntigravityCredential]::CredRead('gemini:antigravity', 1, 0, [ref]$pointer)) { exit 1 }
try {
    $entry = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][AntigravityCredential+Entry])
    if ($entry.BlobSize -eq 0 -or $entry.BlobSize -gt 32768) { exit 1 }
    $blob = New-Object byte[] $entry.BlobSize
    [Runtime.InteropServices.Marshal]::Copy($entry.Blob, $blob, 0, $blob.Length)
    $credential = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString($blob))
    $expiry = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse([string]$credential.token.expiry, [ref]$expiry)) {
        $expiry.ToUnixTimeMilliseconds()
    }
} catch {
    exit 1
} finally {
    [AntigravityCredential]::CredFree($pointer)
}
