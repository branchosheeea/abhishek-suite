@echo off
setlocal
cd /d "%~dp0"

if not exist ".runtime-fast\python.exe" (
    where py >nul 2>nul
    if errorlevel 1 (
        echo Python 3.13 and the Windows Python launcher are required.
        echo Install Python 3.13, then run this setup again.
        pause
        exit /b 1
    )
    py -3.13 -m venv .runtime-fast
    if errorlevel 1 (
        echo Could not create the Python 3.13 runtime.
        echo Confirm Python 3.13 is installed, then run this setup again.
        pause
        exit /b 1
    )
)

".runtime-fast\python.exe" -m pip install -r requirements.txt -r requirements-fast.txt
if errorlevel 1 (
    echo Fast local mode dependencies could not be installed.
    pause
    exit /b 1
)

".runtime-fast\python.exe" setup_fast_model.py
if errorlevel 1 (
    echo Fast local model files could not be prepared.
    pause
    exit /b 1
)

echo Fast local mode dependencies and model are ready.
echo Now start the application with Start Inspection.cmd.
pause
