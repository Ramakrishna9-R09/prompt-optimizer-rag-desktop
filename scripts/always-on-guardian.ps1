param(
  [Parameter(Mandatory = $true)]
  [string]$AppPath
)

$ErrorActionPreference = 'SilentlyContinue'
$resolvedApp = [IO.Path]::GetFullPath($AppPath)
if (-not (Test-Path -LiteralPath $resolvedApp -PathType Leaf)) { exit 2 }

$createdNew = $false
$guardianMutex = New-Object Threading.Mutex($true, 'Local\PromptOptimizerAlwaysOnGuardian', [ref]$createdNew)
if (-not $createdNew) { exit 0 }

try {
  while ($true) {
    $running = Get-CimInstance Win32_Process -Filter "Name = 'Prompt Optimizer.exe'" |
      Where-Object { $_.CommandLine -notmatch '--type=' } |
      Select-Object -First 1

    if (-not $running) {
      Start-Process -FilePath $resolvedApp -WindowStyle Hidden
    }

    Start-Sleep -Seconds 3
  }
} finally {
  $guardianMutex.ReleaseMutex()
  $guardianMutex.Dispose()
}
