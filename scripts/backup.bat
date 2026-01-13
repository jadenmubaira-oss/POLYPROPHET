@echo off
REM POLYPROPHET Backup Script (Windows)
REM Usage: backup.bat
REM Requires: REDIS_URL environment variable set

if "%REDIS_URL%"=="" (
    echo ERROR: REDIS_URL environment variable not set
    echo Set it with: set REDIS_URL=your_redis_url_here
    exit /b 1
)

echo Setting SOURCE_REDIS_URL...
set SOURCE_REDIS_URL=%REDIS_URL%

echo Running backup...
node scripts/migrate-redis.js backup

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Backup complete! File saved to: redis-export.json
    echo Save this file to USB/external drive for nuclear option recovery.
) else (
    echo Backup failed!
    exit /b 1
)
