@echo off
chcp 65001
set APP_NAME=SillyTavernLauncher
set PRODUCT_NAME=酒馆启动器
set COMPANY_NAME=LingyeSoul
set ICON_PATH=src/assets/icon.ico
set DIST_PATH=debugdist


flet packn src/main.py ^
  --icon "%ICON_PATH%" ^
  --name "%APP_NAME%" ^
  --product-name "%PRODUCT_NAME%" ^
  --file-description "%APP_NAME% %PRODUCT_NAME%" ^
  --copyright "Copyright (c) 2025 LingyeSoul" ^
  --distpath "%DIST_PATH%" ^
  --debug-console^
  --yes

pause