@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando MoonWolf Agent...
  call npm install
  if errorlevel 1 (
    echo.
    echo No se pudo instalar el Agent.
    pause
    exit /b 1
  )
)
node index.js --server-dir "%~dp0.."
pause
