[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $OutputPath,
  [string] $ManifestPath,
  [string] $FixtureInputPath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'snapshot-common.ps1')

function Get-FullPath([string] $Path) {
  return [IO.Path]::GetFullPath($Path)
}

function Assert-OutsideGit([string] $Path) {
  $target = Get-FullPath $Path
  $repo = (& git -C $PSScriptRoot rev-parse --show-toplevel 2>$null)
  if ($LASTEXITCODE -eq 0 -and $repo) {
    $repoRoot = (Get-FullPath $repo).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (($target + [IO.Path]::DirectorySeparatorChar).StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'SNAPSHOT_MUST_BE_OUTSIDE_GIT'
    }
  }
  return $target
}

function Encode-DocumentPath([string] $Path) {
  return (($Path -split '/') | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
}

function Assert-AllowedDocument([string] $Project, [string] $Path) {
  $allowed = switch ($Project) {
    'estudiantes-musicala' { @('^estudiantes/[^/]+$', '^student_document_index/[^/]+$') }
    'rip-musicala' { @('^students/[^/]+$') }
    'bitacoras-de-clase' { @('^students/[^/]+$', '^users/[^/]+$', '^app_config/student_sync_status$') }
    default { throw 'SNAPSHOT_PROJECT_NOT_ALLOWED' }
  }
  if (-not ($allowed | Where-Object { $Path -match $_ })) { throw 'SNAPSHOT_PATH_NOT_ALLOWED' }
}

$resolvedOutput = Assert-OutsideGit $OutputPath
$parent = Split-Path -Parent $resolvedOutput
if (-not (Test-Path -LiteralPath $parent)) {
  [IO.Directory]::CreateDirectory($parent) | Out-Null
}

if ($FixtureInputPath) {
  $payload = Get-Content -LiteralPath $FixtureInputPath -Raw | ConvertFrom-Json
  Assert-SnapshotContent $payload
} else {
  if (-not $ManifestPath) { throw 'MANIFEST_REQUIRED' }
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  if (-not $manifest.runId -or -not $manifest.documents -or $manifest.documents.Count -lt 1) {
    throw 'INVALID_SNAPSHOT_MANIFEST'
  }
  $gcloud = (Get-Command gcloud.cmd -ErrorAction SilentlyContinue)
  if (-not $gcloud) { $gcloud = Get-Command gcloud -ErrorAction Stop }
  $token = & $gcloud.Source auth print-access-token
  if ($LASTEXITCODE -ne 0 -or -not $token) { throw 'ACCESS_TOKEN_UNAVAILABLE' }
  $headers = @{ Authorization = "Bearer $token" }
  $documents = @()
  foreach ($item in $manifest.documents) {
    $project = [string]$item.project
    $path = [string]$item.path
    Assert-AllowedDocument $project $path
    $encodedPath = Encode-DocumentPath $path
    $uri = "https://firestore.googleapis.com/v1/projects/$project/databases/(default)/documents/$encodedPath"
    try {
      $content = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers
      $documents += [pscustomobject]@{
        existedBefore = $true
        content = $content
        updateTime = [string]$content.updateTime
        project = $project
        path = $path
      }
    } catch {
      if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
      $documents += [pscustomobject]@{
        existedBefore = $false
        content = $null
        updateTime = $null
        project = $project
        path = $path
      }
    }
  }
  Remove-Variable token -ErrorAction SilentlyContinue
  $payload = [pscustomobject]@{
    schemaVersion = 2
    runId = [string]$manifest.runId
    createdAt = [DateTime]::UtcNow.ToString('o')
    documents = @($documents)
  }
  Assert-SnapshotContent $payload ([int]$manifest.documents.Count) $manifest.documents
}

$json = $payload | ConvertTo-Json -Depth 100 -Compress
$plainBytes = [Text.Encoding]::UTF8.GetBytes($json)
$cipherBytes = Protect-SnapshotBytes $plainBytes
[IO.File]::WriteAllBytes($resolvedOutput, $cipherBytes)

$readBack = Read-EncryptedSnapshot $resolvedOutput
$verified = $readBack.snapshot
Assert-SnapshotContent $verified ([int]$payload.documents.Count) $payload.documents
$hash = (Get-FileHash -LiteralPath $resolvedOutput -Algorithm SHA256).Hash.ToLowerInvariant()

[pscustomobject]@{
  ok = $true
  encrypted = $true
  verified = $true
  documents = [int]$payload.documents.Count
  sha256 = $hash
} | ConvertTo-Json -Compress
