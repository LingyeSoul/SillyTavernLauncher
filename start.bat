@echo off
rem Start SillyTavernLauncher (GPUIX) with cwd = install root,
rem so config.json / logs / SillyTavern / env resolve to this folder.
cd /d "%~dp0"
bun src\app.tsx
