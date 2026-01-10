@echo off
setlocal EnableExtensions

cd /d "%~dp0"
echo === POLYPROPHET Deploy (commit + push) ===

echo.
echo [1/4] Git status:
git status -sb
if errorlevel 1 goto :fail

echo.
echo [2/4] Staging ALL changes (tracked + new files)...
git add -A
if errorlevel 1 goto :fail

echo.
echo [3/4] Committing...
set "MSG=%*"
if "%MSG%"=="" set "MSG=v101: taker-fee model + shares-based min order + oracle docs"
git commit -m "%MSG%"
if errorlevel 1 goto :fail

echo.
echo [4/4] Pushing to origin/main (Render will auto-deploy)...
git push
if errorlevel 1 goto :fail

echo.
echo === Done! ===
echo Verify:
echo - https://polyprophet.onrender.com/api/version?apiKey=YOUR_KEY
echo - https://polyprophet.onrender.com/api/health
pause
exit /b 0

:fail
echo.
echo !!! Deploy script failed. See output above.
pause
exit /b 1
