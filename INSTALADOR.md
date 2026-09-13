# Instalador automático do YaniNeko

O arquivo `0-INSTALAR-VENCORD.bat` é o ponto de entrada recomendado no **Windows 10/11 x64**. Ele executa o instalador PowerShell local; se o arquivo não estiver presente, baixa uma cópia atualizada da branch `main`.

## O que ele faz

1. Cria uma pasta persistente em `%LOCALAPPDATA%\LefferzinBypass`.
2. Instala Git portátil caso Git não esteja disponível.
3. Instala Node.js 22 portátil caso a versão existente seja antiga ou ausente.
4. Ativa exatamente o pnpm 11.9.0, versão declarada pelo Vencord atual.
5. Baixa o plugin e o binário `proton-confgen.exe` diretamente do GitHub.
6. Baixa ou atualiza o Vencord em uma pasta persistente.
7. Copia o plugin para `src/userplugins`, instala dependências, compila e valida a presença do plugin no `dist/renderer.js`.
8. Fecha o Discord e chama o instalador oficial do Vencord para a branch Stable.
9. Grava um log completo em `%LOCALAPPDATA%\LefferzinBypass\logs`.

O processo é repetível: executar novamente atualiza o Vencord e substitui os arquivos do plugin sem depender de uma cópia antiga dentro da pasta do instalador.

## Por que o instalador anterior falhava

O script anterior usava `SilentlyContinue` global, podia continuar depois de falhas de dependência, ativava uma versão flutuante do pnpm (`latest`), usava Node 20 apesar de o Vencord atual exigir Node 22 ou superior e tratava a saída do injetor de forma permissiva. A nova versão interrompe o processo no primeiro erro relevante, usa versões compatíveis, tenta downloads três vezes, valida os arquivos baixados e só informa sucesso quando o build e a injeção são confirmados.

## Uso avançado

Para executar diretamente e manter a janela fechando automaticamente:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\0-INSTALAR-VENCORD.ps1 -NoPause
```

Para apenas preparar e compilar, sem injetar no Discord:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\0-INSTALAR-VENCORD.ps1 -SkipInjection
```

O instalador precisa de acesso à internet para GitHub, Node.js e os pacotes do pnpm. O Windows Defender ou outro antivírus pode inspecionar o binário do plugin; isso não deve ser desativado automaticamente. O uso de modificações do cliente pode contrariar os Termos de Serviço do Discord.

## Diagnóstico

Se algo falhar, copie o arquivo de log indicado no final da janela. O script não tenta esconder erros e não considera a instalação concluída quando o build ou a injeção falham.
