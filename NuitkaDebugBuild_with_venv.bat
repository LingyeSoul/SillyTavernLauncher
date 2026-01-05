@echo off
chcp 65001 >nul
echo ========================================
echo   Building Nuitka debug version with venv
echo ========================================
echo.

if not exist "venv\Scripts\python.exe" (
    echo [ERROR] Virtual environment not found
    echo Please run setup_venv.bat first
    pause
    exit /b 1
)

echo [1/3] Activating virtual environment...
call venv\Scripts\activate.bat
if %errorlevel% neq 0 (
    echo [ERROR] Failed to activate virtual environment
    pause
    exit /b 1
)
echo [OK] Virtual environment activated
echo.

echo [2/3] Checking flet installation...
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

set APP_NAME=SillyTavernLauncher
set COMPANY_NAME=LingyeSoul
set ICON_PATH=src/assets/icon.ico
set DIST_PATH=debugdist

echo [3/3] Building Nuitka debug version...
echo.
echo NOTE: Nuitka build takes 10-30 minutes, please wait...
echo.

flet packn src/main.py ^
  --icon "%ICON_PATH%" ^
  --name "%APP_NAME%" ^
  --product-name "酒馆启动器" ^
  --file-description "%APP_NAME% %PRODUCT_NAME%" ^
  --copyright "Copyright (c) 2025 LingyeSoul" ^
  --distpath "%DIST_PATH%" ^
  --debug-console ^
  --yes

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Nuitka build failed
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Nuitka debug build completed!
echo ========================================
echo.
echo Output directory: %DIST_PATH%\%APP_NAME%\
echo.
echo Note: Debug version shows console window
echo.
pause
