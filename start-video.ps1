param(
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Concept = "",
  [string]$Model = "",
  [int]$Duration = 5,
  [int]$Scenes = 0
)

# start-video.ps1 — COMPATIBILITY WRAPPER (STEP-8HJ)
#
# This script no longer orchestrates the pipeline. It only:
#   1. loads local credentials from scripting/.env (never printed), and
#   2. delegates to the CANONICAL workflow entrypoint: `npm run video -- create`.
#
# The canonical workflow allocates the project id, generates/validates the pipeline, and reports
# the required external inputs. All Flow, production, approval and publish work is performed by
# the `video` CLI (see the guidance printed at the end). This wrapper NEVER invokes Flow, Chrome,
# the scene/production stages, approval, or publishing itself.

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
# Load local credentials from scripting/.env into this process (values are never printed).
$envFile = Join-Path $repoRoot "scripting\.env"
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $name = $matches[1]
      $value = $matches[2].Trim().Trim('"').Trim("'")
      if ($value -and [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
      }
    }
  }
}
if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY) -and [string]::IsNullOrWhiteSpace($env:GROQ_API_KEY)) {
  throw "Set OPENAI_API_KEY or GROQ_API_KEY in scripting/.env or your environment before starting a project."
}

# Delegate to the canonical workflow: `npm run video -- create`.
$productionDir = Join-Path $repoRoot "production"
$arguments = @("run", "video", "--", "create", "--title", $Title, "--duration", "$Duration")
if ($Scenes -gt 0) { $arguments += @("--scenes", "$Scenes") }
if (-not [string]::IsNullOrWhiteSpace($Model)) { $arguments += @("--model", $Model) }
if (-not [string]::IsNullOrWhiteSpace($Concept)) { $arguments += @("--concept", $Concept) }

Push-Location $productionDir
try {
  $output = & npm @arguments 2>&1
  $exitCode = $LASTEXITCODE
} finally {
  Pop-Location
}

$output | ForEach-Object { Write-Host $_ }
if ($exitCode -ne 0) {
  # Fail closed: do not create partial legacy state or continue a failed creation.
  Write-Error "video create failed (exit $exitCode). No project was continued."
  exit $exitCode
}

# Recover the canonical pipeline path from the create report (`path:` line) for guidance.
$projectPath = ($output | Where-Object { $_ -match '^path:\s' } | Select-Object -First 1)
if ($projectPath) { $projectPath = ($projectPath -replace '^path:\s+', '').Trim() }
if ([string]::IsNullOrWhiteSpace($projectPath)) { $projectPath = "<path from the create output above>" }

Write-Host ""
Write-Host "Project created. Continue with the canonical workflow (run from the production/ directory):"
Write-Host "  npm run video -- status  --project `"$projectPath`""
Write-Host "  npm run video -- health  --project `"$projectPath`""
Write-Host "  npm run video -- resume  --project `"$projectPath`""
Write-Host "  npm run video -- resume  --project `"$projectPath`" --run-flow --flow-session   # ONLY when Flow work is required (opens Chrome; uses Flow credits)"
Write-Host "  npm run video -- approve --project `"$projectPath`" --yes                        # explicit HUMAN approval (after AWAITING_APPROVAL)"
Write-Host "  npm run video -- publish-status --project `"$projectPath`""
Write-Host ""
Write-Host "External inputs (narration via Google AI Studio, BGM, branding, character/background assets)"
Write-Host "are reported by 'video status' / 'video health'. Supply them, then re-run 'video resume'."
