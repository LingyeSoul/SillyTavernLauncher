@echo off
chcp 65001
set /p SEMVER=请输 版本号（例如 1.0.0）: 
for /f "tokens=1,2,3 delims=." %%a in ("%SEMVER%") do (
    set MAJOR=%%a
    set MINOR=%%b
    set PATCH=%%c
)

set APP_NAME=SillyTavernLauncher
set PRODUCT_NAME=酒馆启动器
set COMPANY_NAME=LingyeSoul
set ICON_PATH=src/assets/icon.ico
set DIST_PATH=dist


flet pack src/main.py ^
  --icon "%ICON_PATH%" ^
  --name "%APP_NAME%" ^
  --product-name "%PRODUCT_NAME%" ^
  --file-description "%APP_NAME% %PRODUCT_NAME%" ^
  --product-version "%SEMVER%" ^
  --file-version "%MAJOR%.%MINOR%.%PATCH%.0" ^
  --company-name "%COMPANY_NAME%" ^
  --copyright "Copyright (c) 2025 LingyeSoul" ^
  --onedir ^
  --distpath "%DIST_PATH%" ^
  --yes

pause