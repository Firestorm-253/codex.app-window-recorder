$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginRoot = Split-Path -Parent $scriptRoot

Set-Location $pluginRoot

$nodePath = $null

try {
    $nodePath = (Get-Command node -ErrorAction Stop).Source
} catch {
    $candidateRoots = @(
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)}
    ) | Where-Object { $_ }

    $candidatePaths = $candidateRoots |
        ForEach-Object { Join-Path $_ "nodejs\\node.exe" } |
        Where-Object { Test-Path $_ }

    if ($candidatePaths.Count -gt 0) {
        $nodePath = $candidatePaths[0]
    }
}

if (-not $nodePath) {
    throw "Unable to locate node.exe. Install Node.js or add it to PATH."
}

& $nodePath (Join-Path $scriptRoot "server.mjs")
exit $LASTEXITCODE
