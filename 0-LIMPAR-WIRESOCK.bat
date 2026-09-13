@echo off
chcp 65001 >nul
title GoLiveBypass - Limpar WireSock e dados salvos
color 0C
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -STA -Command ^
  "$ErrorActionPreference = 'SilentlyContinue'; foreach ($i in Get-ChildItem -LiteralPath '%~dp0' -Recurse -File -ErrorAction SilentlyContinue) { Unblock-File -LiteralPath $i.FullName -ErrorAction SilentlyContinue } if (Test-Path -LiteralPath '%~f0') { Unblock-File -LiteralPath '%~f0' -ErrorAction SilentlyContinue }" 2>nul

echo ======================================================
echo   GoLiveBypass - Limpeza completa WireSock/Proton
echo   (servicos, processos, perfis, login e cache)
echo ======================================================
echo.
echo ATENCAO: esta limpeza e GLOBAL para o WireSock e tambem
 echo apaga a sessao Proton e os perfis salvos do plugin.
echo Ela pode encerrar WireSock de outros aplicativos/plugins.
echo A instalacao persistente do Vencord NAO sera apagada.
echo.
choice /C SN /N /M "Continuar com a limpeza completa? [S/N]: "
if errorlevel 2 exit /b 0
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Solicitando privilegios de Administrador...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo [1/5] Parando servicos WireSock se existirem...
sc stop wiresock-client-service >nul 2>&1
sc stop wiresock-pro-client-service >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/5] Encerrando processos WireSock e auxiliares Proton...
taskkill /F /T /IM wiresock-client.exe >nul 2>&1
taskkill /F /T /IM proton-confgen.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo [3/5] Removendo servicos WireSock...
sc delete wiresock-client-service >nul 2>&1
sc delete wiresock-pro-client-service >nul 2>&1
timeout /t 2 /nobreak >nul

echo [4/5] Apagando perfis, login Proton, locks, logs e caches...
rem Dados atuais do controlador: %%LOCALAPPDATA%%\GoLiveBypass\plugin-vpn
if exist "%LOCALAPPDATA%\GoLiveBypass\plugin-vpn" rd /s /q "%LOCALAPPDATA%\GoLiveBypass\plugin-vpn"
rem Possiveis dados legados em AppData Roaming ou com nome antigo
if exist "%APPDATA%\GoLiveBypass\plugin-vpn" rd /s /q "%APPDATA%\GoLiveBypass\plugin-vpn"
if exist "%LOCALAPPDATA%\LefferzinBypass\plugin-vpn" rd /s /q "%LOCALAPPDATA%\LefferzinBypass\plugin-vpn"
if exist "%APPDATA%\LefferzinBypass\plugin-vpn" rd /s /q "%APPDATA%\LefferzinBypass\plugin-vpn"
rem Dados antigos que podiam ter sido salvos na pasta pai da GUI
for %%F in (wireguard.conf proton-session.json wireguard-client.conf optimized-profile.conf optimization-marker.json activation-state.json owner.lock migration-v1.json route-snapshot.json route-info.json plugin-vpn.log) do (
    del /q "%LOCALAPPDATA%\GoLiveBypass\%%F" >nul 2>&1
    del /q "%APPDATA%\GoLiveBypass\%%F" >nul 2>&1
    del /q "%LOCALAPPDATA%\LefferzinBypass\%%F" >nul 2>&1
    del /q "%APPDATA%\LefferzinBypass\%%F" >nul 2>&1
)

echo Limpando somente as configuracoes do LefferzinBypass no Vencord/Equicord...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$paths=@(\"$env:APPDATA\Vencord\settings.json\",\"$env:LOCALAPPDATA\Vencord\settings.json\",\"$env:APPDATA\Equicord\settings.json\",\"$env:LOCALAPPDATA\Equicord\settings.json\"); foreach($p in $paths){ if(Test-Path -LiteralPath $p){ try{ $j=Get-Content -LiteralPath $p -Raw | ConvertFrom-Json; if($j.plugins){ [void]$j.plugins.PSObject.Properties.Remove('LefferzinBypass'); [void]$j.plugins.PSObject.Properties.Remove('Lefferzin Bypass') }; $j | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $p -Encoding UTF8; Write-Host \"  configuracao limpa: $p\" } catch { Write-Host \"  aviso: nao consegui editar $p\" } } }"

echo [5/5] Limpando DNS e verificando residuos...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetAdapter -IncludeHidden | Where-Object { `$_.Name -match 'ProTUN|WireSock' -or `$_.InterfaceDescription -match 'ProTUN|WireSock' } | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex `$_.ifIndex -ResetServerAddresses -ErrorAction SilentlyContinue }" >nul 2>&1
ipconfig /flushdns >nul 2>&1

sc query wiresock-client-service >nul 2>&1
if %errorlevel% equ 0 (echo [AVISO] wiresock-client-service ainda existe. Reinicie o PC.) else (echo [OK] wiresock-client-service removido.)
sc query wiresock-pro-client-service >nul 2>&1
if %errorlevel% equ 0 (echo [AVISO] wiresock-pro-client-service ainda existe. Reinicie o PC.) else (echo [OK] wiresock-pro-client-service removido.)
if exist "%LOCALAPPDATA%\GoLiveBypass\plugin-vpn" (echo [AVISO] pasta de dados atual ainda existe.) else (echo [OK] dados atuais removidos.)

echo.
echo ======================================================
echo   LIMPEZA COMPLETA CONCLUIDA
echo   O Vencord persistente foi preservado.
echo   Abra o Discord e faca login Proton novamente.
echo ======================================================
echo.
pause
