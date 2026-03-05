$env:PATH = "C:\Program Files\nodejs;" + $env:PATH
Set-Location "C:\Codeland\sankey-visual"
& "C:\Program Files\nodejs\npm.cmd" run package

# Rename the pbiviz output from  DDP_Sankey.X.X.X.X.pbiviz
#                              to  DDP_Sankey_X.X.X.X.pbiviz
# (pbiviz always uses a dot between guid and version; we prefer an underscore)
Get-ChildItem -Path "dist" -Filter "DDP_Sankey.*.pbiviz" | ForEach-Object {
    $newName = $_.Name -replace "^DDP_Sankey\.", "DDP_Sankey_"
    if ($newName -ne $_.Name) {
        Rename-Item -Path $_.FullName -NewName $newName -Force
        Write-Host " info   Renamed output: $newName"
    }
}
