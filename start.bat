@echo off
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto node_missing

if exist "node_modules\" goto run_server
echo Installing dependencies...
call npm install
if errorlevel 1 goto install_failed

:run_server
start "Resume Expert" /D "%~dp0" cmd /k "call npm start"
echo Waiting 15 seconds for the local services to start...
timeout /t 15 /nobreak >nul
start http://localhost:5173
pause
exit /b 0

:node_missing
echo Node.js is not installed. Please install Node.js first.
pause
exit /b 1

:install_failed
echo Dependency installation failed. Please check the error above.
pause
exit /b 1
