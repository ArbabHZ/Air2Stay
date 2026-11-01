$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root ".venv\Scripts\python.exe"

if (-not (Test-Path $Python)) {
    $PythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if (-not $PythonCommand) {
        throw "Python was not found. Install Python 3.12+ and run this script again."
    }
    $Python = $PythonCommand.Source
}

& $Python (Join-Path $Root "run_local.py") @args
exit $LASTEXITCODE
