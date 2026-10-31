@echo off
cd /d "%~dp0"
node --disable-warning=ExperimentalWarning "%~dp0repair-list.mjs"
pause
