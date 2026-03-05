$env:PATH = "C:\Program Files\nodejs;" + $env:PATH
Set-Location "C:\Codeland\sankey-visual"

$pbivizPath = "$PWD\pbiviz.json"
$utf8NoBom  = New-Object System.Text.UTF8Encoding $false
$pbivizRaw  = [System.IO.File]::ReadAllText($pbivizPath, $utf8NoBom)
$version    = ($pbivizRaw | ConvertFrom-Json).visual.version

try {
    # Temporarily prepend the version to the description field so it shows
    # in the Power BI visualizations-pane hover tooltip, e.g.:
    #   "v1.0.4.0 - Sankey flow diagram showing source to target flows..."
    # pbiviz.json is always restored in the finally block.
    $prefix  = "v$version - "
    $patched = $pbivizRaw -replace '("description":\s*")', ('$1' + $prefix)
    [System.IO.File]::WriteAllText($pbivizPath, $patched, $utf8NoBom)

    & "C:\Program Files\nodejs\npm.cmd" run package
}
finally {
    # Restore pbiviz.json exactly as it was - git never sees this change
    [System.IO.File]::WriteAllText($pbivizPath, $pbivizRaw, $utf8NoBom)
}

# Rename DDP_Sankey.X.X.X.X.pbiviz to DDP_Sankey_X.X.X.X.pbiviz
# (Move-Item -Force overwrites any existing file at the destination)
Get-ChildItem -Path "dist" -Filter "DDP_Sankey.*.pbiviz" | ForEach-Object {
    $newName = $_.Name -replace "^DDP_Sankey\.", "DDP_Sankey_"
    if ($newName -ne $_.Name) {
        $dest = Join-Path "dist" $newName
        Move-Item -Path $_.FullName -Destination $dest -Force
        Write-Host " info   Renamed output: $newName"
    }
}
