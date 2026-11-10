$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root ".venv\Scripts\python.exe"

if (-not (Test-Path $Python)) {
    $PythonCommand = Get-Command py -ErrorAction SilentlyContinue
    if ($PythonCommand) {
        & $PythonCommand.Source -3 (Join-Path $Root "run_local.py") @args
        exit $LASTEXITCODE
    }
    $PythonCommand = Get-Command python,python3 -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $PythonCommand) {
        throw "Python was not found. Install Python 3.12+, then run this script with --setup once."
    }
    $Python = $PythonCommand.Source
}

& $Python (Join-Path $Root "run_local.py") @args
exit $LASTEXITCODE
