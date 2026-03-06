$pkg = Get-Content 'C:\Codeland\sankey-visual\package.json' -Raw
$pkg = $pkg -replace '"version": "1\.2\.11-beta\.1"', '"version": "1.2.12-beta.1"'
Set-Content 'C:\Codeland\sankey-visual\package.json' $pkg

$pbiviz = Get-Content 'C:\Codeland\sankey-visual\pbiviz.json' -Raw
$pbiviz = $pbiviz -replace '"version": "1\.2\.11\.0"', '"version": "1.2.12.0"'
Set-Content 'C:\Codeland\sankey-visual\pbiviz.json' $pbiviz

Write-Host "Versions bumped to 1.2.12"
