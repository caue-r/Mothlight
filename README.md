# Mothlight

Userplugin do Equicord que devolve o Go Live e a câmera em contas atingidas pelo bloqueio de vídeo do Discord, e roteia somente o processo do Discord por um túnel WireGuard da ProtonVPN.

Fork de [Mockerz/YaniNeko](https://github.com/Mockerz/YaniNeko).

## O que faz

- Neutraliza o experimento `2026-08-video-guard`, que desativa Go Live e câmera na conta.
- Permite fixar a região dos servidores de voz e de transmissão, em vez de aceitar a escolha automática do Discord.
- Sobe um túnel WireGuard via ProtonVPN restrito ao executável do Discord (`AllowedApps`). O resto do computador continua na rede normal.
- Escolhe a rota Proton por carga e latência, e reavalia a cada 90 minutos, trocando de servidor sem derrubar a conexão.
- Avisa quando o Discord diz que você está transmitindo mas nenhuma conexão real subiu em 32s (o erro 2001).

## Requisitos

- Windows 10 ou 11, 64-bit
- Discord Stable
- Python 3 no PATH, apenas para instalar
- Conta ProtonVPN (a gratuita funciona)

## Instalação

Baixe o `1-INSTALAR.bat` do [último release](https://github.com/caue-r/Mothlight/releases/latest) e execute. Ele abre um menu com três opções:

| Opção | O que faz |
| --- | --- |
| **1 Instalar** | Instala o que faltar, compila o Equicord com o plugin e injeta no Discord Stable |
| **2 Reinstalar** | Apaga o build anterior, recompila do zero e reinjeta. **Preserva o login Proton** |
| **3 Desinstalar** | Despatcheia o Discord, remove o WireSock do sistema e apaga todos os dados, **inclusive o login Proton**. Pede confirmação |

Não é preciso preparar nada antes: se o Python 3 não estiver no sistema, o `.bat` o instala sozinho (winget, com o instalador oficial do python.org como reserva). Git, Node e pnpm são instalados em `%LOCALAPPDATA%\Mothlight\tools` e não mexem no resto da máquina. O Discord é fechado durante o processo.

Depois, abra o Discord e ative **Mothlight** em Configurações > Plugins.

O `.bat` sempre puxa o estado atual da branch `main`, não o código congelado na tag do release.

Se preferir a linha de comando, o instalador aceita os mesmos modos:

```
py instalar_yanineko.py --modo instalar
py instalar_yanineko.py --modo reinstalar
py instalar_yanineko.py --modo desinstalar
```

### A partir dos fontes locais

```
py instalar_local.py
```

Opções: `--check` (valida e mostra os caminhos, sem alterar nada), `--vencord-dir` (usa uma cópia local do Vencord), `--install-deps`, `--no-pause`.

Atenção: este é o caminho de desenvolvimento e ainda instala no **Vencord**, não no Equicord. Ele também não tem os modos de reinstalar e desinstalar. Para uso normal, prefira o `1-INSTALAR.bat`.

## Uso

1. Configurações > Plugins > Mothlight.
2. Preencha usuário e senha da Proton e entre. 2FA e captcha são pedidos quando necessário.
3. Otimizar rota.
4. Start Bypass.

O Windows vai pedir elevação: instalar o WireSock SDK e criar ou iniciar o serviço exigem administrador. O Discord em si não precisa rodar como administrador.

## Configurações

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `protonUsername` | vazio | Login da Proton |
| `protonCountry` | vazio | Países preferidos, códigos de 2 letras separados por vírgula (`BR,US,NL`). Vazio escolhe automaticamente |
| `protonFreeOnly` | ligado | Usar apenas servidores gratuitos. Desligue em contas Plus/Unlimited |
| `protonAutoPing` | ligado | Priorizar menor latência |
| `voiceRegion` | automático | Região fixa para chamadas de voz |
| `streamRegion` | automático | Região fixa para Go Live |

## Comando

`/golivebypass` copia um diagnóstico para a área de transferência e mostra uma versão resumida na conversa, visível apenas para você.

## Onde ficam os dados

| Caminho | Conteúdo |
| --- | --- |
| `%LOCALAPPDATA%\GoLiveBypass\plugin-vpn` | Perfil WireGuard, sessão Proton, snapshot de rota, `plugin-vpn.log` |
| `%LOCALAPPDATA%\Mothlight` | Raiz da instalação: clone do Equicord, `tools`, `logs` |

O WireSock SDK 3.4.8.1 é baixado de `wiresock.net` e verificado por SHA-256 antes de instalar.

## Problemas

Para a maioria dos casos, use a opção **2 Reinstalar** do `1-INSTALAR.bat`: ela recompila tudo do zero sem te fazer entrar de novo na Proton.

`0-LIMPAR-WIRESOCK.bat` (pede administrador) é o martelo: encerra o túnel, remove os serviços do WireSock, apaga os perfis, a sessão Proton e as configurações do plugin, sem desinstalar o plugin.

A limpeza do WireSock é **global**: ela derruba o WireSock de outros aplicativos e plugins, não só o deste. A instalação do Equicord não é afetada.

Os instaladores não pedem elevação. O UAC aparece só na primeira ativação do bypass, para instalar o WireSock SDK e criar o serviço, e na desinstalação, para removê-los.

## Estrutura

| Arquivo | Papel |
| --- | --- |
| `index.tsx` | Renderer: patches, painel da VPN, configurações, comando, watcher de transmissão |
| `native.ts` | Processo main do Electron: handlers IPC, log em arquivo, fluxo do captcha |
| `vpn-controller.ts` | Máquina de estados da VPN, posse do WireSock, watchdog, snapshot de rota |
| `vpn-windows.ts` | WireSock e Windows: instalação, serviços, rotas, DNS, ping |
| `vpn-proton.ts` | Ponte para o `proton-confgen.exe`: login, plano, listagem e seleção de servidores |
| `vpn-types.ts` | Contratos e validação, sem dependência de Electron ou Node |
| `stability.ts` | Regras puras de detecção de transmissão fantasma |
| `instalar_yanineko.py` | Instalador que baixa o plugin deste repositório |
| `instalar_local.py` | Instalador a partir dos fontes locais |

## Aviso

Modificar o cliente do Discord contraria os Termos de Serviço. Use por sua conta e risco.

## Licença

GPL-3.0-or-later, conforme os cabeçalhos dos fontes, herdado do Vencord. O repositório não inclui um arquivo `LICENSE`.
