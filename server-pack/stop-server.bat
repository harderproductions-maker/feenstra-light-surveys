@echo off
cd /d "%~dp0"
docker compose down
echo The PrimeOps server is stopped. Your data and reports are kept; run start-server.bat to start it again.
pause
