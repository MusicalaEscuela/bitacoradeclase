[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $SnapshotPath,
  [string] $ExpectedSha256,
  [string] $FixtureStatePath,
  [string] $FixtureResultPath,
  [switch] $Apply
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'snapshot-common.ps1')

function Full-DocumentName([string] $Project, [string] $Path) {
  return "projects/$Project/databases/(default)/documents/$Path"
}

$readResult = Read-EncryptedSnapshot $SnapshotPath $ExpectedSha256
$actualHash = $readResult.sha256
$snapshot = $readResult.snapshot
Assert-SnapshotContent $snapshot

if ($FixtureStatePath) {
  if (-not $FixtureResultPath) { throw 'FIXTURE_RESULT_REQUIRED' }
  $state = Get-Content -LiteralPath $FixtureStatePath -Raw | ConvertFrom-Json
  $map = @{}
  foreach ($item in $state.documents) { $map["$($item.project)|$($item.path)"] = $item }
  $restored = 0
  $deleted = 0
  foreach ($item in $snapshot.documents) {
    $key = "$($item.project)|$($item.path)"
    if ($item.existedBefore) {
      $map[$key] = [pscustomobject]@{ project = $item.project; path = $item.path; content = $item.content }
      $restored += 1
    } elseif ($map.ContainsKey($key)) {
      $map.Remove($key)
      $deleted += 1
    }
  }
  $result = [pscustomobject]@{ documents = @($map.Values) }
  [IO.File]::WriteAllText(
    [IO.Path]::GetFullPath($FixtureResultPath),
    ($result | ConvertTo-Json -Depth 100 -Compress),
    [Text.UTF8Encoding]::new($false)
  )
  [pscustomobject]@{ ok = $true; fixture = $true; restored = $restored; deletedCreated = $deleted } |
    ConvertTo-Json -Compress
  exit 0
}

if (-not $Apply) { throw 'ROLLBACK_APPLY_SWITCH_REQUIRED' }
$gcloud = (Get-Command gcloud.cmd -ErrorAction SilentlyContinue)
if (-not $gcloud) { $gcloud = Get-Command gcloud -ErrorAction Stop }
$token = & $gcloud.Source auth print-access-token
if ($LASTEXITCODE -ne 0 -or -not $token) { throw 'ACCESS_TOKEN_UNAVAILABLE' }
$headers = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }
$restoredCount = 0
$deletedCount = 0

foreach ($projectGroup in ($snapshot.documents | Group-Object project)) {
  $writes = @()
  foreach ($item in $projectGroup.Group) {
    if ($item.existedBefore) {
      $update = [ordered]@{
        name = Full-DocumentName ([string]$item.project) ([string]$item.path)
        fields = $item.content.fields
      }
      $writes += [ordered]@{ update = $update; currentDocument = @{ exists = $true } }
      $restoredCount += 1
    } else {
      $writes += [ordered]@{
        delete = Full-DocumentName ([string]$item.project) ([string]$item.path)
        currentDocument = @{ exists = $true }
      }
      $deletedCount += 1
    }
  }
  for ($offset = 0; $offset -lt $writes.Count; $offset += 400) {
    $last = [Math]::Min($offset + 399, $writes.Count - 1)
    $body = @{ writes = @($writes[$offset..$last]) } | ConvertTo-Json -Depth 100 -Compress
    $uri = "https://firestore.googleapis.com/v1/projects/$($projectGroup.Name)/databases/(default)/documents:commit"
    Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $body | Out-Null
  }
}
Remove-Variable token -ErrorAction SilentlyContinue

[pscustomobject]@{
  ok = $true
  restored = $restoredCount
  deletedCreated = $deletedCount
  sha256Verified = [bool]$ExpectedSha256
} | ConvertTo-Json -Compress
