@echo off
chcp 65001 >nul
echo ========================================
echo   Building with Nuitka and venv
echo ========================================
echo.

if not exist "venv\Scripts\python.exe" (
    echo [ERROR] Virtual environment not found
    echo Please run setup_venv.bat first
    pause
    exit /b 1
)

echo [1/4] Activating virtual environment...
call venv\Scripts\activate.bat
if %errorlevel% neq 0 (
    echo [ERROR] Failed to activate virtual environment
    pause
    exit /b 1
)
echo [OK] Virtual environment activated
echo.

echo [2/4] Checking flet installation...
python -c "import flet" >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARNING] flet not found, installing...
    pip install flet[all]
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install flet
        pause
        exit /b 1
    )
)
echo [OK] flet installed
echo.

echo [3/4] Enter version info...
set /p SEMVER=Enter version number (e.g. 1.0.0):
for /f "tokens=1,2,3 delims=." %%a in ("%SEMVER%") do (
    set MAJOR=%%a
    set MINOR=%%b
    set PATCH=%%c
)

set APP_NAME=SillyTavernLauncher
set COMPANY_NAME=LingyeSoul
set ICON_PATH=src/assets/icon.ico
set DIST_PATH=Nuitkadist

echo.
echo [4/4] Starting Nuitka build...
echo Version: %SEMVER%
echo.
echo NOTE: Nuitka build takes 10-30 minutes, please wait...
echo.

flet packn src/main.py ^
  --icon "%ICON_PATH%" ^
  --name "%APP_NAME%" ^
  --product-name "酒馆启动器" ^
  --file-description "%APP_NAME% %PRODUCT_NAME%" ^
  --product-version "%SEMVER%" ^
  --copyright "Copyright (c) 2025 LingyeSoul" ^
  --distpath "%DIST_PATH%" ^
  --yes

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Nuitka build failed
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Nuitka build completed!
echo ========================================
echo.
echo Output directory: %DIST_PATH%\%APP_NAME%\
echo.
echo Nuitka advantages:
echo   - Faster startup speed
echo   - Smaller file size
echo   - Better performance
echo   - Single file with all dependencies
echo.
echo Next steps:
echo   1. Test the app in output directory
echo   2. Create installer with NSIS
echo.
pause
