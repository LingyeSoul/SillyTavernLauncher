@echo off
rem Build SillyTavernLauncher as a single-file executable (src\dist\*.exe).
rem Usage: build.bat [--skip-tests] [--skip-smoke]
rem Anchored to repo root so double-click works from any cwd.
cd /d "%~dp0"
rem UTF-8 codepage so the build script's Chinese output renders correctly
chcp 65001 >nul

where bun >nul 2>nul
if errorlevel 1 (
    echo [ERROR] bun not found in PATH. Install it first: https://bun.sh
    pause
    exit /b 1
)

bun src\scripts\build-onefile.ts %*
if errorlevel 1 (
    echo.
    echo [FAILED] Build did not complete. See messages above.
) else (
    echo.
    echo [OK] Artifact is in dist\ : SillyTavernLauncher-^<version^>-win-x64.exe
)
pause
