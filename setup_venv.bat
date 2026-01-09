@echo off
chcp 65001 >nul
echo ========================================
echo   Creating Python virtual environment
echo   and installing dependencies
echo ========================================
echo.

REM Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found, please install Python 3.9 or higher
    pause
    exit /b 1
)

echo [1/3] Detected Python version:
python --version
echo.

echo [2/3] Creating virtual environment...
python -m venv venv
if %errorlevel% neq 0 (
    echo [ERROR] Failed to create virtual environment
    pause
    exit /b 1
)
echo [OK] Virtual environment created
echo.

echo [3/3] Installing dependencies...
call venv\Scripts\activate.bat
if %errorlevel% neq 0 (
    echo [ERROR] Failed to activate virtual environment
    pause
    exit /b 1
)

echo Upgrading pip...
python -m pip install --upgrade pip

echo Installing packages from requirements.txt...
pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo Installing custom flet-cli...
pip install git+https://github.com/LingyeSoul/flet_cli.git@main
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install custom flet-cli
    pause
    exit /b 1
)

echo Installing flet-desktop...
pip install flet-desktop==0.80.1
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install flet-desktop
    pause
    exit /b 1
)

echo Installing Nuitka and dependencies...
pip install -U Nuitka pefile pyinstaller
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install Nuitka
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Installation completed!
echo ========================================
echo.
echo Usage:
echo   1. Activate venv: call venv\Scripts\activate.bat
echo   2. Run app:      python src\main.py
echo   3. Deactivate:   deactivate
echo   4. Build app:    Use build_with_venv.bat
echo.
pause
