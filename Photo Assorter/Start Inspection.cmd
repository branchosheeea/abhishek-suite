@echo off
cd /d "%~dp0"
if not exist ".runtime-fast\python.exe" (
    echo The project Python 3.13 runtime is not set up.
    echo Run setup_fast_mode.cmd once, then start this application again.
    pause
    exit /b 1
)
".runtime-fast\python.exe" app.py
if errorlevel 1 pause
