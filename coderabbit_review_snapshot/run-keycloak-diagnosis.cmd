@echo off
setlocal

rem Runs the Keycloak diagnostic from THIS repository, wherever it is checked
rem out. No deployment path, network share, drive letter, host name or
rem certificate location is stored in this file.
cd /d "%~dp0"

rem NODE_EXTRA_CA_CERTS must already exist before node.exe starts: Node reads it
rem once at process start. Set it in the shell (or the service environment)
rem before running this script. The value itself is never printed.
if not defined NODE_EXTRA_CA_CERTS (
  echo NODE_EXTRA_CA_CERTS is not set.
  echo Set it before running this diagnostic.
  pause
  exit /b 1
)

echo Repository directory: %CD%
echo NODE_EXTRA_CA_CERTS: set
echo.

node diagnose-keycloak.cjs
echo.
pause
