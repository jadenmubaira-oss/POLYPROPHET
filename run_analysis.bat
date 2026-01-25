@echo off
setlocal enabledelayedexpansion

REM Ensure we run from the repo root (directory containing this .bat)
pushd "%~dp0"

echo ==============================================
echo POLYPROPHET - Certainty-First Analysis Runner
echo ==============================================
echo.

echo [1/4] Checking Node + NPM...
node -v
if errorlevel 1 (
  echo.
  echo ERROR: Node.js not found. Install Node 20.x and re-run.
  echo https://nodejs.org/
  popd
  exit /b 1
)
npm -v
if errorlevel 1 (
  echo.
  echo ERROR: NPM not found. Install Node 20.x (includes npm) and re-run.
  popd
  exit /b 1
)

echo.
echo [2/4] Installing dependencies (only if needed)...
if not exist "node_modules" (
  echo node_modules not found - running: npm install
  call npm install
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    popd
    exit /b 1
  )
) else (
  echo node_modules already exists - skipping npm install
)

echo.
echo [3/4] Running exhaustive Polymarket-only analysis...
call npm run analysis
if errorlevel 1 (
  echo.
  echo ERROR: Analysis failed.
  popd
  exit /b 1
)

echo.
echo [4/4] Generating final_golden_strategy.json summary...
node final_golden_strategy.js
if errorlevel 1 (
  echo.
  echo ERROR: final_golden_strategy.js failed.
  popd
  exit /b 1
)

echo.
echo ==============================================
echo DONE
echo - exhaustive_analysis\final_results.json
echo - exhaustive_analysis\strategies_ranked.json
echo - exhaustive_analysis\strategies_validated.json
echo - final_golden_strategy.json
echo ==============================================
echo.
echo Next: send me final_golden_strategy.json (and optionally strategies_validated.json)
echo so I can analyze per-asset certainty + streak probabilities.
echo.

popd
pause
