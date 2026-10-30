@echo off
cd /d "%~dp0"
node --disable-warning=ExperimentalWarning "%~dp0manual.mjs"
pause
