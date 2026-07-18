[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $SnapshotPath,
  [Parameter(Mandatory = $true)] [string] $ExpectedSha256,
  [Parameter(Mandatory = $true)] [string] $ManifestPath,
  [Parameter(Mandatory = $true)] [int] $ExpectedDocumentCount
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'snapshot-common.ps1')

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if (-not $manifest.runId -or -not ($manifest.documents -is [Array])) { throw 'SNAPSHOT_CONTENT_INVALID' }
$readResult = Read-EncryptedSnapshot $SnapshotPath $ExpectedSha256
Assert-SnapshotContent $readResult.snapshot $ExpectedDocumentCount $manifest.documents
if ([string]$readResult.snapshot.runId -ne [string]$manifest.runId) { throw 'SNAPSHOT_CONTENT_INVALID' }

[pscustomobject]@{
  ok = $true
  schemaVersion = 2
  documents = [int]$readResult.snapshot.documents.Count
  hashVerified = $true
  coverageVerified = $true
} | ConvertTo-Json -Compress
