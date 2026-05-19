#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node required (>=20)"; exit 1
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Error "claude (Claude Code) required"; exit 1
}

Write-Host "Building MCP..."
Push-Location (Join-Path $root "mcp")
try {
  npm install --silent
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
} finally {
  Pop-Location
}

Write-Host "Registering MCP (user scope)..."
# `claude mcp remove` exits non-zero and writes to stderr when the server
# isn't registered — that's expected on first install, so swallow both.
try { & claude mcp remove compute-finance *>$null } catch {}
$global:LASTEXITCODE = 0

& claude mcp add --scope user compute-finance node (Join-Path $root "mcp\dist\index.js")
if ($LASTEXITCODE -ne 0) { throw "claude mcp add failed" }

Write-Host ""
Write-Host "Compute Finance MCP - install which skill?"
Write-Host "  1) cf-session-management   (post-session cost + history + insights)"
Write-Host "  2) cf-session-consumption  (per-turn token breakdown with visual)"
Write-Host "  3) cf-active-sessions      (multi-session overview across projects)"
Write-Host "  4) all"
$choice = Read-Host "Choose [4]"
if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "4" }

$skillsRoot = Join-Path $env:USERPROFILE ".claude\skills"
New-Item -ItemType Directory -Force -Path $skillsRoot | Out-Null

function Install-Skill($name) {
  $dst = Join-Path $skillsRoot $name
  if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
  Copy-Item -Recurse (Join-Path $root "skills\$name") $dst
  Write-Host "  installed: $name"
}

switch ($choice) {
  "1" { Install-Skill "cf-session-management" }
  "2" { Install-Skill "cf-session-consumption" }
  "3" { Install-Skill "cf-active-sessions" }
  "4" {
    Install-Skill "cf-session-management"
    Install-Skill "cf-session-consumption"
    Install-Skill "cf-active-sessions"
  }
  default { Write-Error "Invalid choice: $choice"; exit 1 }
}

Write-Host ""
Write-Host "Done. Restart Claude Code, then invoke the skill(s) by name."
Write-Host "Local data: ~\.compute-finance-mcp\{sessions,turns}.jsonl (never uploaded)."
