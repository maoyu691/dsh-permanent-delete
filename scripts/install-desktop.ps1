param(
  [string]$DshCli
)

$ErrorActionPreference = 'Stop'

if (-not $DshCli) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\harness\node_modules\@deepseek-ai\dsh\lib\bin.js')
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      $DshCli = $candidate
      break
    }
  }
}

if (-not $DshCli) {
  $command = Get-Command dsh -ErrorAction SilentlyContinue
  if ($command) {
    $DshCli = $command.Source
  }
}

if (-not $DshCli) {
  throw 'Could not find the DeepSeek Harness desktop dsh CLI. Pass -DshCli with the path shown in the Desktop diagnostics page.'
}

$packageDir = Split-Path -Parent $PSScriptRoot
if ($DshCli.EndsWith('.js')) {
  node $DshCli plugin --profile desktop add $packageDir
} else {
  & $DshCli plugin --profile desktop add $packageDir
}
