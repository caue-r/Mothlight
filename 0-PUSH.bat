@echo off
chcp 65001 >nul
title LefferzinBypass - Git Push Rapido
color 0A

cd /d "%~dp0"

echo ======================================================
echo   LefferzinBypass - Push Rapido
echo ======================================================
echo.

git status
echo.
echo ------------------------------------------------------
echo   Adicionando arquivos...
echo ------------------------------------------------------
git add -A
if %errorlevel% neq 0 (
    echo [ERRO] Falha no git add.
    goto :fim
)

echo.
echo ------------------------------------------------------
echo   Commitando...
echo ------------------------------------------------------
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set "dt=%%I"
set "ts=%dt:~0,4%-%dt:~4,2%-%dt:~6,2% %dt:~8,2%:%dt:~10,2%"
git commit -m "Ajustes locais %ts%"
if %errorlevel% neq 0 (
    echo.
    echo [INFO] Nada novo para commitar.
)

echo.
echo ------------------------------------------------------
echo   Enviando para GitHub...
echo ------------------------------------------------------
git push
if %errorlevel% equ 0 (
    echo.
    echo [OK] Push enviado com sucesso.
) else (
    echo.
    echo [ERRO] Falha no push.
)

:fim
echo.
pause
