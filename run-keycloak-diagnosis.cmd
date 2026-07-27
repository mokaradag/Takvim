@echo off
setlocal

set "PROJECT_DIR=M:\Primavera\PYB\08 - MERGEN Rota"

rem IMPORTANT:
rem NODE_EXTRA_CA_CERTS must exist before node.exe starts.
rem Replace the path below only if your current certificate path is different.
if not defined NODE_EXTRA_CA_CERTS (
  set "NODE_EXTRA_CA_CERTS=\\rehisds\uygulamalar\Primavera\PYB\02 - Modelleme\IscilikTahmini\ShinyApp\Sertifikalar\cert.pem"
)

cd /d "%PROJECT_DIR%" || (
  echo ERROR: Cannot open project directory: %PROJECT_DIR%
  pause
  exit /b 1
)

echo Project directory: %CD%
echo NODE_EXTRA_CA_CERTS: %NODE_EXTRA_CA_CERTS%
echo.
node "%~dp0diagnose-keycloak.cjs"
echo.
pause