$script:SnapshotEntropyText = 'Musicala.BackfillSnapshot.v2'

function Protect-SnapshotBytes([byte[]] $PlainBytes) {
  Add-Type -AssemblyName System.Security
  $entropy = [Text.Encoding]::UTF8.GetBytes($script:SnapshotEntropyText)
  return [Security.Cryptography.ProtectedData]::Protect(
    $PlainBytes,
    $entropy,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
}

function Unprotect-SnapshotBytes([byte[]] $CipherBytes) {
  Add-Type -AssemblyName System.Security
  $entropy = [Text.Encoding]::UTF8.GetBytes($script:SnapshotEntropyText)
  return [Security.Cryptography.ProtectedData]::Unprotect(
    $CipherBytes,
    $entropy,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
}

function Test-ObjectProperty($Value, [string] $Name) {
  return $null -ne $Value -and $null -ne $Value.PSObject.Properties[$Name]
}

function Assert-SnapshotContent($Snapshot, [int] $ExpectedDocumentCount = 0, $ExpectedDocuments = $null) {
  try {
    if (-not (Test-ObjectProperty $Snapshot 'schemaVersion') -or [int]$Snapshot.schemaVersion -ne 2) { throw 'invalid' }
    if (-not (Test-ObjectProperty $Snapshot 'runId') -or [string]::IsNullOrWhiteSpace([string]$Snapshot.runId)) { throw 'invalid' }
    if (-not (Test-ObjectProperty $Snapshot 'createdAt') -or [string]::IsNullOrWhiteSpace([string]$Snapshot.createdAt)) { throw 'invalid' }
    if (-not (Test-ObjectProperty $Snapshot 'documents') -or -not ($Snapshot.documents -is [Array])) { throw 'invalid' }
    if ($Snapshot.documents.Count -lt 1) { throw 'invalid' }
    if ($ExpectedDocumentCount -gt 0 -and $Snapshot.documents.Count -ne $ExpectedDocumentCount) { throw 'invalid' }

    $actualRoutes = @{}
    foreach ($item in $Snapshot.documents) {
      foreach ($required in @('project', 'path', 'existedBefore', 'updateTime', 'content')) {
        if (-not (Test-ObjectProperty $item $required)) { throw 'invalid' }
      }
      $project = [string]$item.project
      $path = [string]$item.path
      if ([string]::IsNullOrWhiteSpace($project) -or [string]::IsNullOrWhiteSpace($path)) { throw 'invalid' }
      if (-not ($item.existedBefore -is [bool])) { throw 'invalid' }
      $route = "$project|$path"
      if ($actualRoutes.ContainsKey($route)) { throw 'invalid' }
      $actualRoutes[$route] = $true

      if ($item.existedBefore) {
        if ([string]::IsNullOrWhiteSpace([string]$item.updateTime) -or $null -eq $item.content) { throw 'invalid' }
        if (-not (Test-ObjectProperty $item.content 'name') -or -not (Test-ObjectProperty $item.content 'fields')) { throw 'invalid' }
        if ([string]::IsNullOrWhiteSpace([string]$item.content.name)) { throw 'invalid' }
        if ((Test-ObjectProperty $item.content 'value') -and (Test-ObjectProperty $item.content 'Count') -and -not (Test-ObjectProperty $item.content 'fields')) { throw 'invalid' }
      } elseif ($null -ne $item.content -or $null -ne $item.updateTime) {
        throw 'invalid'
      }
    }

    if ($null -ne $ExpectedDocuments) {
      $expectedRoutes = @{}
      foreach ($item in @($ExpectedDocuments)) {
        $project = [string]$item.project
        $path = [string]$item.path
        if ([string]::IsNullOrWhiteSpace($project) -or [string]::IsNullOrWhiteSpace($path)) { throw 'invalid' }
        $route = "$project|$path"
        if ($expectedRoutes.ContainsKey($route)) { throw 'invalid' }
        $expectedRoutes[$route] = $true
      }
      if ($expectedRoutes.Count -ne $actualRoutes.Count) { throw 'invalid' }
      foreach ($route in $expectedRoutes.Keys) {
        if (-not $actualRoutes.ContainsKey($route)) { throw 'invalid' }
      }
    }
  } catch {
    throw 'SNAPSHOT_CONTENT_INVALID'
  }
}

function Read-EncryptedSnapshot([string] $SnapshotPath, [string] $ExpectedSha256 = '') {
  $resolved = [IO.Path]::GetFullPath($SnapshotPath)
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw 'SNAPSHOT_NOT_FOUND' }
  $actualHash = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ExpectedSha256 -and $actualHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'SNAPSHOT_HASH_MISMATCH' }
  try {
    $plain = Unprotect-SnapshotBytes ([IO.File]::ReadAllBytes($resolved))
    $snapshot = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json
  } catch {
    throw 'SNAPSHOT_CONTENT_INVALID'
  }
  return [pscustomobject]@{ snapshot = $snapshot; sha256 = $actualHash }
}
