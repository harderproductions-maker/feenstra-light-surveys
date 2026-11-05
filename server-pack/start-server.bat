@echo off
setlocal
cd /d "%~dp0"
title PrimeOps server

where docker >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop is not installed. Install it from https://www.docker.com/products/docker-desktop/ then run this file again.
  pause
  exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop is not running. Start it, wait until it says "Engine running", then run this file again.
  pause
  exit /b 1
)

if not exist .env (
  echo First-time setup: choose the administrator sign-in for the app.
  set /p ADMIN_EMAIL=Admin username: 
  set /p ADMIN_PASSWORD=Admin password ^(at least 4 characters; use 12 or more^): 
  powershell -NoProfile -Command "$j=[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N'); $d=[guid]::NewGuid().ToString('N'); @('POSTGRES_DB=primeops','POSTGRES_USER=primeops','POSTGRES_PASSWORD='+$d,'JWT_SECRET='+$j,'ADMIN_EMAIL='+$env:ADMIN_EMAIL,'ADMIN_PASSWORD='+$env:ADMIN_PASSWORD,'APP_PORT=3001','REPORTS_DIR=./reports') | Set-Content -Encoding ascii .env"
)

powershell -NoProfile -Command "$legacy=Get-Content 'server/legacy-database.json' -Raw | ConvertFrom-Json; $text=Get-Content .env -Raw; $lines=@(); if($text -notmatch '(?m)^POSTGRES_DB='){$lines+='POSTGRES_DB='+$legacy.databaseName}; if($text -notmatch '(?m)^POSTGRES_USER='){$lines+='POSTGRES_USER='+$legacy.databaseUser}; if($lines.Count){Add-Content -Encoding ascii .env ''; Add-Content -Encoding ascii .env $lines}"
if errorlevel 1 (
  echo Could not preserve the existing database configuration. Startup stopped.
  pause
  exit /b 1
)

echo Starting the PrimeOps server. The first start downloads and builds everything and can take several minutes.
docker compose up -d --build
if errorlevel 1 (
  echo The server could not start. See the messages above.
  pause
  exit /b 1
)

echo.
echo PrimeOps server is running. Open this address on this PC to sign in:
echo   http://localhost:3001
echo.
echo On the phone ^(same Wi-Fi^) and in the desktop app, use one of these as the server address:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo   http://%%a:3001
echo.
echo Completed reports are saved in the "reports" folder next to this file.
echo Admins can pick a sub-folder in the app under "Report storage".
echo If the phone cannot connect, allow Docker Desktop through Windows Firewall for private networks.
pause
