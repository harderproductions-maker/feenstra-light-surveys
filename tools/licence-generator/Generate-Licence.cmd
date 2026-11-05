@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22 LTS or newer from https://nodejs.org first.
  echo Then run this private owner tool again. No npm install is needed.
  pause
  exit /b 1
)
node "%~dp0FG-Ops-Licence-Generator.cjs" wizard
echo.
pause
