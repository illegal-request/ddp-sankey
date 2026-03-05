$env:PATH = "C:\Program Files\nodejs;" + $env:PATH
Set-Location "C:\Codeland\sankey-visual"

$pbivizPath = "$PWD\pbiviz.json"
$utf8NoBom  = New-Object System.Text.UTF8Encoding $false
$pbivizRaw  = [System.IO.File]::ReadAllText($pbivizPath, $utf8NoBom)
$version    = ($pbivizRaw | ConvertFrom-Json).visual.version

try {
    # Patch both the displayName and description so the version is visible in
    # Power BI Desktop in two places:
    #   displayName → shown in the visualizations-pane hover tooltip
    #                 e.g. "DDP SanKey v1.2.2.0"
    #   description → shown in the visual's info / detail panel
    #                 e.g. "v1.2.2.0 - Sankey flow diagram..."
    # pbiviz.json is always restored in the finally block — git never sees these changes.

    $patched = $pbivizRaw `
        -replace '("displayName":\s*"DDP SanKey")',          ('"displayName": "DDP SanKey v' + $version + '"') `
        -replace '("description":\s*")',                     ('$1v' + $version + ' - ')

    [System.IO.File]::WriteAllText($pbivizPath, $patched, $utf8NoBom)

    & "C:\Program Files\nodejs\npm.cmd" run package
}
finally {
    # Restore pbiviz.json exactly as it was
    [System.IO.File]::WriteAllText($pbivizPath, $pbivizRaw, $utf8NoBom)
}

# Rename DDP_Sankey.X.X.X.X.pbiviz  →  DDP_Sankey_X.X.X.X.pbiviz
Get-ChildItem -Path "dist" -Filter "DDP_Sankey.*.pbiviz" | ForEach-Object {
    $newName = $_.Name -replace "^DDP_Sankey\.", "DDP_Sankey_"
    if ($newName -ne $_.Name) {
        $dest = Join-Path "dist" $newName
        Move-Item -Path $_.FullName -Destination $dest -Force
        Write-Host " info   Renamed output: $newName"
    }
}
