@echo off
setlocal

rem Runs the Keycloak diagnostic from THIS repository, wherever it is checked
rem out. No deployment path, network share, drive letter, host name or
rem certificate location is stored in this file.
cd /d "%~dp0"

rem NODE_EXTRA_CA_CERTS must already exist before node.exe starts: Node reads it
rem once at process start. Set it in the shell (or the service environment)
rem before running this script. The value itself is never printed.
rem A publicly trusted Keycloak certificate needs no extra CA bundle. Exiting
rem here also skipped TEST 2, so the wrapper could not diagnose that perfectly
rem valid configuration. Warn and continue: the discovery request reports the
rem real TLS outcome.
set "MR_CA_STATE=set"
if not defined NODE_EXTRA_CA_CERTS (
  echo NODE_EXTRA_CA_CERTS is not set.
  echo Continuing. TEST 2 will report whether Node trusts the Keycloak certificate.
  set "MR_CA_STATE=not set"
)

echo Repository directory: %CD%
echo NODE_EXTRA_CA_CERTS: %MR_CA_STATE%
echo.

node diagnose-keycloak.cjs
echo.
pause
