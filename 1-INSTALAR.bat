@echo off
setlocal
chcp 65001 >nul
title Mothlight
color 0B
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='SilentlyContinue'; if (Test-Path -LiteralPath '%~f0') { Unblock-File -LiteralPath '%~f0' }" 2>nul

set "REPO=caue-r/Mothlight"
set "BRANCH=main"
set "SCRIPT=instalar_yanineko.py"
rem A query nao muda o arquivo servido, mas cria uma chave de cache propria no
rem CDN do raw.githubusercontent. Sem isso, uma correcao recem-publicada demora
rem ate ~5 minutos para chegar, e o usuario roda a versao antiga sem saber.
set "RAW=https://raw.githubusercontent.com/%REPO%/%BRANCH%/%SCRIPT%?nocache=%RANDOM%%TIME:~6,2%%TIME:~9,2%"
set "WORK=%TEMP%\mothlight-bootstrap"
set "PYVER=3.12.10"
set "PYURL=https://www.python.org/ftp/python/%PYVER%/python-%PYVER%-amd64.exe"

rem ---------- exige Windows 64-bit ----------
if /i "%PROCESSOR_ARCHITECTURE%"=="AMD64" goto :menu
if /i "%PROCESSOR_ARCHITEW6432%"=="AMD64" goto :menu
echo [ERRO] Este projeto exige Windows 64-bit.
goto :fim

:menu
cls
echo ======================================================
echo   Mothlight
echo   Origem: github.com/%REPO% (branch %BRANCH%)
echo ======================================================
echo.
echo   [1] Instalar
echo       Instala as dependencias, compila o Equicord com o
echo       plugin e injeta no Discord Stable.
echo.
echo   [2] Reinstalar
echo       Apaga o build anterior, recompila do zero e
echo       reinjeta. Preserva o login Proton.
echo.
echo   [3] Desinstalar
echo       Despatcheia o Discord, remove o WireSock e apaga
echo       todos os dados, inclusive o login Proton.
echo.
echo   [0] Sair
echo.
choice /C 1230 /N /M "Escolha uma opcao [1/2/3/0]: "
set "OPCAO=%errorlevel%"
if "%OPCAO%"=="4" exit /b 0
if "%OPCAO%"=="1" set "MODO=instalar"
if "%OPCAO%"=="2" set "MODO=reinstalar"
if "%OPCAO%"=="3" set "MODO=desinstalar"
echo.

if not "%MODO%"=="desinstalar" goto :confirmado
echo ------------------------------------------------------
echo   ATENCAO
echo ------------------------------------------------------
echo   Isto remove o WireSock do sistema inteiro, apaga o
echo   login Proton salvo e devolve o Discord ao original.
echo   Os seus outros plugins do Equicord nao sao afetados.
echo.
choice /C SN /N /M "Confirmar a desinstalacao? [S/N]: "
if errorlevel 2 goto :menu
echo.
:confirmado

echo ------------------------------------------------------
echo   [1/3] Verificando o Python
echo ------------------------------------------------------
call :acha_python
if defined PY goto :py_pronto

echo       Python 3 nao encontrado. Instalando automaticamente.
if not exist "%WORK%" mkdir "%WORK%" >nul 2>&1
where winget >nul 2>&1
if errorlevel 1 goto :py_pelo_site
echo       $ winget install -e --id Python.Python.3.12
winget install -e --id Python.Python.3.12 --source winget --silent --accept-package-agreements --accept-source-agreements
goto :py_recheca

:py_pelo_site
echo       winget indisponivel; baixando o instalador oficial do Python %PYVER%.
curl -L --fail --silent --show-error -o "%WORK%\python-setup.exe" "%PYURL%"
if not exist "%WORK%\python-setup.exe" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -UseBasicParsing -Uri '%PYURL%' -OutFile '%WORK%\python-setup.exe' } catch { exit 1 }"
)
if not exist "%WORK%\python-setup.exe" (
    echo [ERRO] Nao consegui baixar o instalador do Python.
    goto :fim
)
echo       instalando em modo silencioso, aguarde...
"%WORK%\python-setup.exe" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1
del /q "%WORK%\python-setup.exe" >nul 2>&1

:py_recheca
call :acha_python
if defined PY goto :py_pronto
echo [ERRO] O Python foi instalado mas nao foi localizado nesta sessao.
echo        Feche esta janela, abra de novo e rode o %~nx0 novamente.
goto :fim

:py_pronto
echo       Python: "%PY%" %PYA%

echo.
echo ------------------------------------------------------
echo   [2/3] Baixando o instalador de %REPO%
echo ------------------------------------------------------
if not exist "%WORK%" mkdir "%WORK%" >nul 2>&1
del /q "%WORK%\%SCRIPT%" >nul 2>&1
curl -L --fail --silent --show-error -o "%WORK%\%SCRIPT%" "%RAW%"
if not exist "%WORK%\%SCRIPT%" (
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
echo       OK

echo.
echo ------------------------------------------------------
echo   [3/3] Executando: %MODO%
echo ------------------------------------------------------
echo.
"%PY%" %PYA% "%WORK%\%SCRIPT%" --modo %MODO% --sem-pausa
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" (
    echo [ERRO] O modo %MODO% terminou com codigo %RC%.
    echo        Log completo em: %LOCALAPPDATA%\Mothlight\logs
    goto :fim
)
if "%MODO%"=="desinstalar" (
    echo [OK] Mothlight desinstalado. O Discord voltou ao original.
) else (
    echo [OK] Concluido. Abra o Discord e ative Mothlight em Configuracoes ^> Plugins.
)
echo.
pause
exit /b 0

rem ---------- localiza um Python 3 utilizavel ----------
:acha_python
set "PY="
set "PYA="
py -3 --version >nul 2>&1
if not errorlevel 1 (
    set "PY=py"
    set "PYA=-3"
    exit /b 0
)
python --version >nul 2>&1
if not errorlevel 1 (
    set "PY=python"
    exit /b 0
)
for %%D in ("%LOCALAPPDATA%\Programs\Python" "%ProgramFiles%") do (
    for /f "delims=" %%P in ('dir /b /ad "%%~D\Python3*" 2^>nul') do (
        if exist "%%~D\%%P\python.exe" set "PY=%%~D\%%P\python.exe"
    )
)
exit /b 0

:fim
echo.
pause
exit /b 1
