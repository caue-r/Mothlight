@echo off
chcp 65001 >nul
title Mothlight - Instalador
color 0B
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='SilentlyContinue'; if (Test-Path -LiteralPath '%~f0') { Unblock-File -LiteralPath '%~f0' }" 2>nul

set "REPO=caue-r/Mothlight"
set "BRANCH=main"
set "SCRIPT=instalar_yanineko.py"
set "RAW=https://raw.githubusercontent.com/%REPO%/%BRANCH%/%SCRIPT%"
set "WORK=%LOCALAPPDATA%\Mothlight\bootstrap"

echo ======================================================
echo   Mothlight - Instalador
echo   Origem: github.com/%REPO% (branch %BRANCH%)
echo ======================================================
echo.
echo O instalador baixa Git, Node e pnpm em:
echo   %LOCALAPPDATA%\Mothlight\tools
echo compila o Vencord com o plugin e injeta no Discord Stable.
echo.
echo ATENCAO: o Discord sera fechado durante o processo.
echo.
choice /C SN /N /M "Continuar com a instalacao? [S/N]: "
if errorlevel 2 exit /b 0
echo.

rem ---------- Windows 64-bit ----------
if /i "%PROCESSOR_ARCHITECTURE%"=="AMD64" goto :arch_ok
if /i "%PROCESSOR_ARCHITEW6432%"=="AMD64" goto :arch_ok
echo [ERRO] Este projeto exige Windows 64-bit.
goto :fim
:arch_ok

rem ---------- Python 3 ----------
set "PY="
py -3 --version >nul 2>&1
if %errorlevel% equ 0 set "PY=py -3"
if defined PY goto :py_ok
python --version >nul 2>&1
if %errorlevel% equ 0 set "PY=python"
:py_ok
if not defined PY (
    echo [ERRO] Python 3 nao encontrado no PATH.
    echo        Instale por https://www.python.org/downloads/ marcando
    echo        "Add python.exe to PATH", ou rode no terminal:
    echo            winget install -e --id Python.Python.3.12
    goto :fim
)
echo [1/2] Python: %PY%

rem ---------- baixa o instalador do repositorio ----------
if not exist "%WORK%" mkdir "%WORK%" >nul 2>&1
echo [2/2] Baixando %SCRIPT% de %REPO%...
del /q "%WORK%\%SCRIPT%" >nul 2>&1
curl -L --fail --silent --show-error -o "%WORK%\%SCRIPT%" "%RAW%"
if %errorlevel% neq 0 (
    echo       curl falhou, tentando pelo PowerShell...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$ProgressPreference='SilentlyContinue'; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '%RAW%' -OutFile '%WORK%\%SCRIPT%' } catch { exit 1 }"
)
if not exist "%WORK%\%SCRIPT%" (
    echo [ERRO] Nao consegui baixar o instalador de:
    echo        %RAW%
    echo        Verifique a conexao e se o repositorio esta acessivel.
    goto :fim
)

echo.
echo ------------------------------------------------------
echo   Executando o instalador
echo ------------------------------------------------------
echo.
%PY% "%WORK%\%SCRIPT%"
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" (
    echo [ERRO] O instalador terminou com codigo %RC%.
    echo        Log completo em: %LOCALAPPDATA%\Mothlight\logs
    goto :fim
)
echo [OK] Instalacao concluida.
echo      Abra o Discord e ative Mothlight em Configuracoes ^> Plugins.
exit /b 0

:fim
echo.
pause
exit /b 1
