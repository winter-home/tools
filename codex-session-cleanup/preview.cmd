@echo off
cd /d "%~dp0"
node --disable-warning=ExperimentalWarning "%~dp0cleanup.mjs"
pause
