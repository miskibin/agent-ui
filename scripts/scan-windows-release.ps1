[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]] $Path,
    [string] $ReportPath = '.tmp-antivirus/defender-report.json'
)

$ErrorActionPreference = 'Stop'
$status = Get-MpComputerStatus
if (-not $status.AntivirusEnabled -or -not $status.RealTimeProtectionEnabled) {
    throw 'Microsoft Defender Antivirus and real-time protection must be enabled.'
}

$platform = Join-Path $env:ProgramData 'Microsoft/Windows Defender/Platform'
$scanner = Get-ChildItem -LiteralPath $platform -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'MpCmdRun.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
if (-not $scanner) {
    $scanner = Join-Path $env:ProgramFiles 'Windows Defender/MpCmdRun.exe'
}
if (-not (Test-Path -LiteralPath $scanner -PathType Leaf)) {
    throw 'Microsoft Defender scanner not found.'
}

# Resolve every requested file up front. An empty glob or a quarantined file
# must fail the gate rather than silently becoming a successful empty scan.
$files = @(
    foreach ($pattern in $Path) {
        $matches = @(Get-Item -Path $pattern -ErrorAction Stop)
        if ($matches.Count -eq 0) { throw "No files matched: $pattern" }
        foreach ($file in $matches) {
            if ($file.PSIsContainer) { throw "Expected a file: $($file.FullName)" }
            $file.FullName
        }
    }
) | Sort-Object -Unique

$results = @()
$failed = $false
foreach ($file in $files) {
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    $signature = (Get-AuthenticodeSignature -LiteralPath $file).Status.ToString()
    Write-Host "Scanning $file (SHA256 $hash, Authenticode $signature)"
    # Detection-only custom scan: ignores exclusions and scans archives. It
    # does NOT disable real-time protection. Without this flag exit 0 can
    # also mean 'malware found and remediated', which cannot pass a release.
    $output = & $scanner -Scan -ScanType 3 -File $file -DisableRemediation 2>&1
    $code = $LASTEXITCODE
    $output | ForEach-Object { Write-Host $_ }
    $unchanged = (Test-Path -LiteralPath $file -PathType Leaf) -and
        ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -eq $hash)
    if ($code -ne 0 -or -not $unchanged) { $failed = $true }
    $results += [ordered]@{
        path = $file
        sha256 = $hash
        authenticode = $signature
        exitCode = $code
        unchanged = $unchanged
        output = ($output | Out-String).Trim()
    }
}

$reportDirectory = Split-Path -Parent ([System.IO.Path]::GetFullPath($ReportPath))
New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
[ordered]@{
    scannedAt = [DateTime]::UtcNow.ToString('o')
    engine = $status.AMEngineVersion
    signatures = $status.AntivirusSignatureVersion
    passed = -not $failed
    files = @($results)
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReportPath -Encoding utf8
if ($failed) { throw "Defender scan failed. See $ReportPath. Do not distribute these files." }
