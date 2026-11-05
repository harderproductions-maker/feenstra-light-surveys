@echo off
cd /d "%~dp0"
copy /b PrimeOps-Desktop.part* PrimeOps-Windows.zip
if errorlevel 1 exit /b 1
echo.
echo Done. Right-click PrimeOps-Windows.zip, choose Extract All, then run "PrimeOps.exe".
pause
