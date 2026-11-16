@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
    set "PYTHON=py -3"
) else (
    where python >nul 2>nul
    if errorlevel 1 (
        echo Python 3 is not installed or is not available on PATH.
        echo Contact your vessel IT support to install the approved Python runtime.
        pause
        exit /b 1
    )
    set "PYTHON=python"
)
%PYTHON% -c "import openpyxl" >nul 2>nul
if errorlevel 1 (
    echo The dashboard dependency openpyxl is missing.
    echo From this folder, run: %PYTHON% -m pip install -r requirements.txt
    echo If the vessel is offline, ask IT to provide the approved offline package.
    pause
    exit /b 1
)
%PYTHON% dashboard.py
if errorlevel 1 (
    echo.
    echo Dashboard stopped with an error. Read the message above or contact support.
    pause
)
