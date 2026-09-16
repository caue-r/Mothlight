#!/usr/bin/env python3
"""Instalador do Mothlight para Windows x64.

Uso:
    py instalar_yanineko.py                      instala
    py instalar_yanineko.py --modo reinstalar    recompila e reinjeta, preservando o login Proton
    py instalar_yanineko.py --modo desinstalar   remove tudo, inclusive o login Proton
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
import zipfile
from pathlib import Path

# A saida do pnpm/git traz caracteres fora da codepage ANSI do Windows (✓ e
# afins). Sem isto, o print() aborta a instalacao com UnicodeEncodeError sempre
# que stdout nao for um console em UTF-8 -- redirecionado, em pipe ou num
# console que nao passou por chcp 65001.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

REPO = "caue-r/Mothlight"
PLUGIN_BRANCH = "main"
# Mod alvo da instalacao. Troque para "vencord" para voltar ao Vencord.
MOD = "equicord"
MODS = {
    "vencord": {"name": "Vencord", "repo": "https://github.com/Vendicated/Vencord.git", "branch": "main"},
    "equicord": {"name": "Equicord", "repo": "https://github.com/Equicord/Equicord.git", "branch": "main"},
}
MOD_NAME = MODS[MOD]["name"]
MOD_REPO = MODS[MOD]["repo"]
MOD_BRANCH = MODS[MOD]["branch"]
PNPM_VERSION = "11.9.0"
REQUIRED = [
    "manifest.json", "index.tsx", "native.ts", "stability.ts",
    "vpn-controller.ts", "vpn-proton.ts", "vpn-types.ts", "vpn-windows.ts",
]


def log(message: str = ""):
    print(message, flush=True)
    if LOGGER:
        LOGGER.write(message + "\n")
        LOGGER.flush()


def step(message: str):
    log("\n" + message)


def fail(message: str):
    raise RuntimeError(message)


def run(command: list[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    log("$ " + " ".join(f'"{x}"' if " " in x else x for x in command))
    try:
        result = subprocess.run(
            command, cwd=str(cwd) if cwd else None, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            encoding="utf-8", errors="replace", shell=False,
        )
    except FileNotFoundError:
        fail(f"Comando não encontrado: {command[0]}")
    if result.stdout:
        for line in result.stdout.rstrip().splitlines():
            log(line)
    if check and result.returncode != 0:
        fail(f"Comando falhou com código {result.returncode}: {command[0]}")
    return result


def download(url: str, target: Path, attempts: int = 3):
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + ".part")
    headers = {"User-Agent": "Mothlight-installer/1.0"}
    for attempt in range(1, attempts + 1):
        try:
            log(f"Download ({attempt}/{attempts}): {url}")
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=600) as response, part.open("wb") as output:
                shutil.copyfileobj(response, output, length=1024 * 1024)
            if part.stat().st_size < 1024:
                raise RuntimeError("arquivo baixado é pequeno demais")
            part.replace(target)
            return
        except Exception as exc:
            part.unlink(missing_ok=True)
            if attempt == attempts:
                fail(f"Falha ao baixar {url}: {exc}")
            time.sleep(attempt * 2)


def extract_zip(archive: Path, destination: Path):
    destination.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive) as zf:
            bad = zf.testzip()
            if bad:
                fail(f"ZIP corrompido; primeiro arquivo inválido: {bad}")
            zf.extractall(destination)
    except zipfile.BadZipFile as exc:
        fail(f"ZIP inválido: {exc}")


def prepend_path(path: Path):
    os.environ["PATH"] = str(path) + os.pathsep + os.environ.get("PATH", "")


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def install_git(tools: Path):
    if command_exists("git"):
        log("Git já disponível: " + run(["git", "--version"]).stdout.strip())
        return
    step("[1/8] Instalando Git portátil")
    zip_path = tools / "mingit.zip"
    git_dir = tools / "git"
    try:
        request = urllib.request.Request(
            "https://api.github.com/repos/git-for-windows/git/releases/latest",
            headers={"User-Agent": "Mothlight-installer/1.0"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            release = json.load(response)
        assets = [a for a in release.get("assets", []) if re.match(r"^MinGit-.*-64-bit\.zip$", a.get("name", ""))]
        if not assets:
            fail("A API do Git não retornou MinGit x64.")
        url = assets[0]["browser_download_url"]
    except Exception as exc:
        log(f"API do Git indisponível ({exc}); usando fallback fixo.")
        url = "https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/MinGit-2.51.0-64-bit.zip"
    download(url, zip_path)
    shutil.rmtree(git_dir, ignore_errors=True)
    extract_zip(zip_path, git_dir)
    git_exe = git_dir / "cmd" / "git.exe"
    if not git_exe.exists():
        fail("Git portátil foi extraído, mas git.exe não foi encontrado.")
    prepend_path(git_exe.parent)
    log("OK: " + run(["git", "--version"]).stdout.strip())


def install_node(tools: Path):
    if command_exists("node"):
        version = run(["node", "--version"]).stdout.strip()
        match = re.match(r"v(\d+)", version)
        if match and int(match.group(1)) >= 22:
            log("Node.js já disponível: " + version)
            return
    step("[2/8] Instalando Node.js 22 portátil")
    arch = "x64" if sys.maxsize > 2**32 else "x86"
    request = urllib.request.Request("https://nodejs.org/dist/index.json", headers={"User-Agent": "Mothlight-installer/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        releases = json.load(response)
    release = next((r for r in releases if r.get("version", "").startswith("v22.") and f"win-{arch}-zip" in r.get("files", [])), None)
    if not release:
        fail(f"Não encontrei Node.js 22 para win-{arch}.")
    version = release["version"]
    archive = tools / "node.zip"
    node_dir = tools / "node"
    download(f"https://nodejs.org/dist/{version}/node-{version}-win-{arch}.zip", archive)
    shutil.rmtree(node_dir, ignore_errors=True)
    extract_zip(archive, node_dir)
    folders = [p for p in node_dir.iterdir() if p.is_dir()]
    if not folders:
        fail("Node.js portátil não foi extraído corretamente.")
    prepend_path(folders[0])
    log(f"OK: {run(['node', '--version']).stdout.strip()} / npm {run(['npm', '--version']).stdout.strip()}")


def install_pnpm(tools: Path):
    step(f"[3/8] Preparando pnpm {PNPM_VERSION}")
    corepack = shutil.which("corepack")
    if not corepack:
        fail("Corepack não foi encontrado junto do Node.js.")
    os.environ["COREPACK_HOME"] = str(tools / "corepack")
    run([corepack, "enable"])
    run([corepack, "prepare", f"pnpm@{PNPM_VERSION}", "--activate"])
    pnpm = shutil.which("pnpm")
    if not pnpm:
        fail("pnpm não foi ativado pelo Corepack.")
    log("OK: " + run([pnpm, "--version"]).stdout.strip())


def download_plugin(work: Path, script_dir: Path) -> Path:
    step("[4/8] Baixando o plugin Mothlight")
    archive = work / "mothlight.zip"
    extracted = work / "mothlight"
    download(f"https://github.com/{REPO}/archive/refs/heads/{PLUGIN_BRANCH}.zip", archive)
    extract_zip(archive, extracted)
    expected = REPO.split("/")[-1] + "-"
    roots = [p for p in extracted.iterdir() if p.is_dir()]
    match = [p for p in roots if p.name.startswith(expected)] or roots
    if len(match) != 1:
        fail(f"ZIP do plugin não contém uma única pasta raiz: {sorted(p.name for p in roots)}")
    source = match[0]
    for name in REQUIRED:
        if not (source / name).is_file():
            fail(f"Arquivo obrigatório ausente no plugin: {name}")
    binary = source / "bin" / "win32-x64" / "proton-confgen.exe"
    if not binary.is_file() or binary.stat().st_size < 4096:
        fail("proton-confgen.exe ausente ou inválido.")
    for name in REQUIRED:
        shutil.copy2(source / name, script_dir / name)
    destination_bin = script_dir / "bin" / "win32-x64"
    destination_bin.mkdir(parents=True, exist_ok=True)
    shutil.copy2(binary, destination_bin / binary.name)
    log("OK: arquivos do plugin e binário validados")
    return script_dir


def close_discord():
    for process in ("Discord", "Update"):
        subprocess.run(["taskkill", "/F", "/IM", process + ".exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(3)


def force_rmtree(target: Path) -> bool:
    """Remove a arvore mesmo com arquivos somente-leitura.

    O git grava os objetos de .git/objects com modo 0444. O shutil.rmtree para
    neles no Windows com PermissionError (WinError 5) e deixa para tras um .git
    pela metade -- que depois passa em qualquer checagem de existencia e faz o
    git fetch morrer com "not a git repository". Nao e arquivo preso por
    processo: o atributo esta no disco e sobrevive a reinicializacao.
    """
    def destrava(func, path, _erro):
        try:
            os.chmod(path, stat.S_IWRITE)
            func(path)
        except Exception:
            pass

    # O parametro onerror virou onexc no Python 3.12; os dois recebem 3 args.
    argumento = {"onexc": destrava} if sys.version_info >= (3, 12) else {"onerror": destrava}
    try:
        shutil.rmtree(target, **argumento)
    except Exception:
        pass
    return not target.exists()


def remove_tree(target: Path):
    """Apaga de verdade, ou falha dizendo o porque."""
    if not target.exists():
        return
    if force_rmtree(target):
        log(f"removido: {target}")
        return
    # So agora vale suspeitar de arquivo aberto: o Discord patcheado carrega de
    # <mod>/dist/desktop e mantem esses arquivos em uso enquanto estiver aberto.
    log("sobrou arquivo em uso; fechando o Discord e tentando de novo")
    close_discord()
    if force_rmtree(target):
        log(f"removido: {target}")
        return
    # Ultimo recurso: o rd do Windows resolve casos que o Python nao alcanca.
    log("tentando pelo rd do Windows")
    subprocess.run(["cmd", "/c", "rd", "/s", "/q", str(target)], capture_output=True)
    if not target.exists():
        log(f"removido: {target}")
        return
    fail(f"Nao consegui apagar {target}. Feche o Discord e tente de novo.")


def is_git_repo(path: Path) -> bool:
    """Confirma com o proprio git, em vez de confiar na existencia de .git."""
    if not (path / ".git").exists():
        return False
    result = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"],
                            cwd=str(path), capture_output=True, text=True)
    return result.returncode == 0 and result.stdout.strip() == "true"


def prepare_mod(install_root: Path, plugin_source: Path):
    step(f"[5/8] Baixando ou atualizando o {MOD_NAME}")
    mod_dir = install_root / MOD_NAME
    if not is_git_repo(mod_dir):
        if mod_dir.exists():
            log(f"a copia anterior do {MOD_NAME} nao e um repositorio git valido; refazendo o clone")
            remove_tree(mod_dir)
        run(["git", "clone", "--depth", "1", MOD_REPO, str(mod_dir)], cwd=install_root)
    else:
        run(["git", "fetch", "--depth", "1", "origin", MOD_BRANCH], cwd=mod_dir)
        run(["git", "reset", "--hard", f"origin/{MOD_BRANCH}"], cwd=mod_dir)
        run(["git", "clean", "-fdx", "--exclude=node_modules"], cwd=mod_dir)
    plugin = mod_dir / "src" / "userplugins" / "Mothlight"
    shutil.rmtree(plugin, ignore_errors=True)
    (plugin / "bin" / "win32-x64").mkdir(parents=True, exist_ok=True)
    for name in REQUIRED:
        shutil.copy2(plugin_source / name, plugin / name)
    shutil.copy2(plugin_source / "bin" / "win32-x64" / "proton-confgen.exe", plugin / "bin" / "win32-x64")
    log(f"OK: {MOD_NAME} e plugin preparados")
    return mod_dir


def pnpm_for(mod_dir: Path) -> str:
    """Ativa a versao de pnpm que o repositorio declara em packageManager."""
    try:
        declared = json.loads((mod_dir / "package.json").read_text(encoding="utf-8")).get("packageManager", "")
    except Exception:
        declared = ""
    if declared.startswith("pnpm@"):
        wanted = declared.split("@", 1)[1]
        if wanted != PNPM_VERSION:
            corepack = shutil.which("corepack")
            if corepack:
                log(f"{MOD_NAME} exige pnpm {wanted}; ativando essa versao.")
                run([corepack, "prepare", f"pnpm@{wanted}", "--activate"])
    return shutil.which("pnpm") or "pnpm"


def build(mod_dir: Path, plugin_source: Path):
    step("[6/8] Instalando dependências e compilando")
    pnpm = pnpm_for(mod_dir)
    run([pnpm, "install", "--frozen-lockfile"], cwd=mod_dir)
    run([pnpm, "build"], cwd=mod_dir)
    # O Vencord emite dist/renderer.js; o Equicord separa por cliente e emite
    # dist/desktop/renderer.js. Aceitar os dois layouts.
    renderer = next((c for c in (
        mod_dir / "dist" / "desktop" / "renderer.js",
        mod_dir / "dist" / "renderer.js",
    ) if c.is_file()), None)
    if renderer is None:
        fail("O build nao gerou renderer.js em dist/ nem em dist/desktop/.")
    if "Mothlight" not in renderer.read_text(encoding="utf-8", errors="ignore"):
        fail("O plugin nao apareceu no renderer.js.")
    # O runtime resolve o binario a partir de __dirname do bundle carregado.
    origem = plugin_source / "bin" / "win32-x64" / "proton-confgen.exe"
    for base in {renderer.parent, mod_dir / "dist" / "desktop"}:
        destino = base / "bin" / "win32-x64"
        destino.mkdir(parents=True, exist_ok=True)
        shutil.copy2(origem, destino)
    log("OK: build validado e binário copiado")


def repair_discord():
    """Conserta o Discord deixado sem app.asar por um unpatch interrompido.

    O patch troca resources/app.asar por um stub e guarda o original como
    _app.asar. Se o injetor falha entre apagar um e restaurar o outro, o
    Discord fica sem app.asar e nao abre -- e o patch seguinte tambem falha,
    porque nao ha o que despatchear.
    """
    discord = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "Discord"
    for app in sorted(discord.glob("app-*")):
        stub = app / "resources" / "app.asar"
        original = app / "resources" / "_app.asar"
        if stub.exists() or not original.is_file():
            continue
        try:
            original.rename(stub)
            log(f"reparado: {app.name} estava sem app.asar; restaurado a partir de _app.asar")
        except Exception as exc:
            log(f"aviso: nao consegui restaurar {stub}: {exc}")


def describe_discord_state():
    """Despeja o estado de patch do Discord, para o log dizer o porque da falha.

    O injetor so imprime "Failed!". Sem estes dados nao da para distinguir
    Discord aberto, permissao negada, patch antigo em modules/ ou outro mod
    (BetterDiscord, OpenAsar) ocupando o lugar.
    """
    log("")
    log("--- estado do Discord ---")
    restantes = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Discord.exe"],
                               capture_output=True, text=True, errors="replace").stdout or ""
    log("processos Discord.exe ainda abertos: " + ("sim" if "Discord.exe" in restantes else "nao"))

    local_appdata = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    appdata = Path(os.environ.get("APPDATA", local_appdata))
    for nome in ("BetterDiscord", "Vencord", "Equicord"):
        for base in (appdata, local_appdata):
            if (base / nome).is_dir():
                log(f"outro mod presente no disco: {base / nome}")

    discord = local_appdata / "Discord"
    if not discord.is_dir():
        log(f"pasta do Discord nao existe: {discord}")
        return
    for app in sorted(discord.glob("app-*")):
        log(f"{app.name}:")
        for nome in ("app.asar", "_app.asar"):
            alvo = app / "resources" / nome
            if not alvo.exists():
                log(f"   {nome}: ausente")
            elif alvo.is_dir():
                log(f"   {nome}: PASTA (patch antigo por diretorio)")
            else:
                tamanho = alvo.stat().st_size
                marca = " (stub de patch)" if tamanho < 4096 else ""
                log(f"   {nome}: arquivo, {tamanho} bytes{marca}")
                if tamanho < 4096:
                    texto = alvo.read_bytes()[:2048].decode("utf-8", errors="ignore")
                    alvos = re.findall(r'require\("([^"]+)"\)', texto)
                    if alvos:
                        log(f"      aponta para: {alvos[0]}")
        modules = app / "modules"
        for core in sorted(modules.glob("discord_desktop_core*")) if modules.is_dir() else []:
            indice = core / "discord_desktop_core" / "index.js"
            if indice.is_file():
                conteudo = " ".join(indice.read_text(encoding="utf-8", errors="ignore").split())[:160]
                estado = "PATCHEADO (metodo antigo)" if "core.asar" not in conteudo else "vanilla"
                log(f"   {core.name}/index.js: {estado} -> {conteudo}")
    log("--- fim do estado ---")
    log("")


def inject(mod_dir: Path):
    step("[7/8] Fechando Discord e instalando no Discord Stable")
    close_discord()
    repair_discord()
    installer = mod_dir / "scripts" / "runInstaller.mjs"
    if not installer.is_file():
        fail(f"Injetor oficial do {MOD_NAME} não foi encontrado.")
    result = run(["node", str(installer), "--", "--install", "-branch", "stable"], cwd=mod_dir, check=False)
    combined = result.stdout or ""
    # O injetor imprime linhas informativas como "is already patched" e
    # "Unpatching" mesmo quando fracassa. A checagem antiga procurava
    # "patched|already" em qualquer lugar da saida e por isso dava sucesso em
    # cima de um "Failed!" -- a instalacao terminava dizendo CONCLUIDA com o
    # Discord sem patch nenhum. Agora o marcador de falha tem prioridade e o
    # sucesso precisa ser afirmado explicitamente.
    if re.search(r"❌|Failed!|Something went wrong", combined, re.I):
        describe_discord_state()
        fail("O injetor oficial reportou falha. O estado do Discord está logado acima; "
             "mande esse trecho junto ao relatar o problema.")
    if result.returncode != 0:
        describe_discord_state()
        fail(f"O injetor oficial saiu com código {result.returncode}.")
    if not re.search(r"Successfully patched", combined, re.I):
        describe_discord_state()
        fail("O injetor não confirmou o patch.")
    log("OK: injeção concluída")


def verify(mod_dir: Path) -> bool:
    """Confere o que da para conferir sem abrir o Discord.

    "Instalacao concluida" nao provava nada: o injetor podia reportar sucesso e
    o Discord continuar carregando outro mod. Aqui mostramos para onde cada
    instalacao do Discord esta apontando e se o plugin esta mesmo no bundle.
    """
    ok = True
    bundle = None
    for candidate in (mod_dir / "dist" / "desktop" / "renderer.js", mod_dir / "dist" / "renderer.js"):
        if candidate.is_file():
            bundle = candidate
            break
    if bundle is None:
        log("FALHA: nenhum renderer.js foi encontrado no dist.")
        return False
    if "Mothlight" in bundle.read_text(encoding="utf-8", errors="ignore"):
        log(f"OK: plugin presente em {bundle}")
    else:
        log(f"FALHA: o plugin nao esta em {bundle}")
        ok = False

    # O stub guarda o caminho como literal JS, com as barras escapadas
    # ("C:\\Users\\..."). Comparar sem normalizar acusava instalacao boa.
    def normaliza(texto: str) -> str:
        return re.sub(r"[\\/]+", "/", texto).lower()

    esperado = normaliza(str(mod_dir / "dist" / "desktop"))
    discord = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "Discord"
    encontrados = 0
    for app in sorted(discord.glob("app-*")):
        stub = app / "resources" / "app.asar"
        if not stub.is_file():
            continue
        encontrados += 1
        alvo = stub.read_bytes()[:4096].decode("utf-8", errors="ignore")
        if esperado in normaliza(alvo):
            log(f"OK: {app.name} aponta para o Equicord do Mothlight")
        elif "require(" in alvo:
            log(f"ATENCAO: {app.name} esta patcheado, mas para outro lugar. Outro mod pode estar instalado por cima.")
            ok = False
        else:
            log(f"FALHA: {app.name} nao esta patcheado.")
            ok = False
    if not encontrados:
        pastas = sorted(discord.glob("app-*"))
        quebrados = [a.name for a in pastas if not (a / "resources" / "app.asar").exists()]
        if quebrados:
            log(f"FALHA: {', '.join(quebrados)} esta sem resources/app.asar. "
                "O Discord nao vai abrir ate isso ser restaurado.")
        elif pastas:
            log(f"FALHA: nenhuma das pastas {', '.join(a.name for a in pastas)} tem um app.asar utilizavel.")
        else:
            log(f"FALHA: nenhuma instalacao do Discord encontrada em {discord}.")
        ok = False
    return ok


# Nomes que o plugin ja usou em settings.json e como raiz de dados.
PLUGIN_SETTINGS_KEYS = ("Mothlight", "LefferzinBypass", "GoLiveBypass")
VPN_DATA_DIR_NAME = "GoLiveBypass"
LEGACY_ROOT_NAMES = ("LefferzinBypass",)


def settings_files() -> list[Path]:
    """settings.json do Vencord e do Equicord, nos dois layouts conhecidos."""
    found = []
    for var in ("APPDATA", "LOCALAPPDATA"):
        base = os.environ.get(var)
        if not base:
            continue
        for mod in ("Vencord", "Equicord"):
            for rel in ("settings/settings.json", "settings.json"):
                path = Path(base) / mod / rel
                if path.is_file() and path not in found:
                    found.append(path)
    return found


def clean_plugin_settings():
    """Remove so as chaves do plugin, preservando os demais plugins do usuario."""
    for path in settings_files():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            log(f"aviso: nao consegui ler {path}")
            continue
        plugins = data.get("plugins")
        if not isinstance(plugins, dict):
            continue
        removed = [key for key in PLUGIN_SETTINGS_KEYS if key in plugins]
        if not removed:
            continue
        for key in removed:
            del plugins[key]
        try:
            path.write_text(json.dumps(data, indent=4, ensure_ascii=False), encoding="utf-8")
            log(f"chaves removidas em {path}: {', '.join(removed)} ({len(plugins)} plugins preservados)")
        except Exception as exc:
            log(f"aviso: nao consegui gravar {path}: {exc}")


def unpatch_discord(mod_dir: Path):
    """Despatcheia pelo injetor oficial; se nao der, restaura o app.asar na mao."""
    installer = mod_dir / "scripts" / "runInstaller.mjs"
    if installer.is_file() and shutil.which("node"):
        result = run(["node", str(installer), "--", "--uninstall", "-branch", "stable"], cwd=mod_dir, check=False)
        if result.returncode == 0:
            log("OK: Discord despatcheado pelo injetor oficial")
            return
        log("o injetor oficial falhou; restaurando o app.asar manualmente")
    # O patch atual troca resources/app.asar por um stub e guarda o original
    # como _app.asar. Desfazer isso nao depende de node nem do clone do mod.
    restored = 0
    discord = Path(os.environ.get("LOCALAPPDATA", "")) / "Discord"
    for app in sorted(discord.glob("app-*")):
        original = app / "resources" / "_app.asar"
        stub = app / "resources" / "app.asar"
        if not original.is_file():
            continue
        try:
            if stub.exists():
                stub.unlink()
            original.rename(stub)
            restored += 1
        except Exception as exc:
            log(f"aviso: nao consegui restaurar {stub}: {exc}")
    log(f"OK: app.asar restaurado em {restored} pasta(s) do Discord" if restored else "Discord ja estava sem patch")


def wiresock_uninstall_commands() -> list[str]:
    """Le no registro como desinstalar o WireSock em modo silencioso."""
    import winreg

    commands: list[str] = []
    bases = (
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    )
    for base in bases:
        try:
            root_key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base)
        except OSError:
            continue
        with root_key:
            for index in range(winreg.QueryInfoKey(root_key)[0]):
                try:
                    with winreg.OpenKey(root_key, winreg.EnumKey(root_key, index)) as entry:
                        display = str(winreg.QueryValueEx(entry, "DisplayName")[0])
                        if "wiresock" not in display.lower():
                            continue
                        try:
                            quiet = str(winreg.QueryValueEx(entry, "QuietUninstallString")[0]).strip()
                        except OSError:
                            quiet = ""
                        raw = quiet or str(winreg.QueryValueEx(entry, "UninstallString")[0])
                except OSError:
                    continue
                text = " ".join(raw.split())
                if quiet:
                    commands.append(text)
                    continue
                product = re.search(r"\{[0-9A-Fa-f-]{36}\}", text)
                if text.lower().startswith("msiexec") and product:
                    commands.append(f"msiexec.exe /x {product.group(0)} /quiet /norestart")
                else:
                    commands.append(f"{text} /quiet /norestart")
    # O desinstalador do bundle (.exe) remove tudo; deixe-o na frente do msiexec.
    commands.sort(key=lambda value: value.lower().startswith("msiexec"))
    seen: list[str] = []
    for command in commands:
        if command not in seen:
            seen.append(command)
    return seen


def remove_wiresock():
    step("Removendo o WireSock")
    for name in ("wiresock-client-service", "wiresock-pro-client-service"):
        subprocess.run(["sc.exe", "stop", name], capture_output=True, text=True)
        result = subprocess.run(["sc.exe", "delete", name], capture_output=True, text=True)
        if result.returncode == 0:
            log(f"servico removido: {name}")
    for command in wiresock_uninstall_commands():
        log("$ " + command)
        result = subprocess.run(command, shell=True, capture_output=True, text=True)
        log(f"  codigo de saida {result.returncode}")
    log("OK: WireSock removido")


def remove_data(root: Path, keep_vpn_data: bool):
    step("Apagando dados do plugin")
    local_appdata = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    targets = [root] + [local_appdata / name for name in LEGACY_ROOT_NAMES]
    if keep_vpn_data:
        log(f"preservando o login Proton e o perfil em {local_appdata / VPN_DATA_DIR_NAME}")
    else:
        targets.append(local_appdata / VPN_DATA_DIR_NAME)
    for target in targets:
        if not target.exists():
            continue
        shutil.rmtree(target, ignore_errors=True)
        log(("removido: " if not target.exists() else "removido parcialmente (arquivo em uso): ") + str(target))


def uninstall(root: Path) -> int:
    unpatch_discord(root / MOD_NAME)
    remove_wiresock()
    clean_plugin_settings()
    remove_data(root, keep_vpn_data=False)
    log("")
    log("DESINSTALACAO CONCLUIDA.")
    log("O Discord volta ao estado original na proxima vez que abrir.")
    return 0


LOGGER = None

def main(argv: list[str] | None = None) -> int:
    global LOGGER
    parser = argparse.ArgumentParser(description="Instalador do Mothlight para Windows x64.")
    parser.add_argument("--modo", choices=("instalar", "reinstalar", "desinstalar"), default="instalar")
    parser.add_argument("--sem-pausa", dest="sem_pausa", action="store_true",
                        help="Nao espera Enter no fim (o .bat cuida da pausa)")
    args = parser.parse_args(argv)

    if os.name != "nt":
        print("ERRO: este script foi feito para Windows.")
        return 1
    if sys.maxsize <= 2**32:
        print("ERRO: o projeto exige Windows 64-bit.")
        return 1
    local_appdata = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    root = local_appdata / "Mothlight"
    tools = root / "tools"
    # Na desinstalacao a raiz inteira sera apagada, entao o log nao pode morar
    # dentro dela -- o arquivo aberto impediria a remocao da pasta.
    if args.modo == "desinstalar":
        logs = Path(tempfile.gettempdir()) / "mothlight-logs"
    else:
        logs = root / "logs"
        root.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    log_path = logs / f"{args.modo}-{time.strftime('%Y%m%d-%H%M%S')}.log"
    LOGGER = log_path.open("w", encoding="utf-8")
    work = Path(tempfile.mkdtemp(prefix="Mothlight-"))
    script_dir = Path(__file__).resolve().parent
    log("=" * 54)
    log(f" Mothlight - {args.modo.capitalize()}")
    log("=" * 54)
    log(f"Log: {log_path}")
    try:
        if args.modo == "desinstalar":
            return uninstall(root)
        if args.modo == "reinstalar":
            # Recompila do zero, mas preserva o login Proton e o perfil da VPN.
            previous = root / MOD_NAME
            if previous.exists():
                step(f"Apagando o clone anterior do {MOD_NAME}")
                # Fechar antes de apagar: o Discord patcheado mantem arquivos do
                # dist abertos e uma remocao parcial corrompe o clone.
                close_discord()
                remove_tree(previous)
            clean_plugin_settings()
        install_git(tools)
        install_node(tools)
        install_pnpm(tools)
        plugin_source = download_plugin(work, script_dir)
        mod_dir = prepare_mod(root, plugin_source)
        build(mod_dir, plugin_source)
        inject(mod_dir)
        step("[8/8] Conferindo o resultado")
        if not verify(mod_dir):
            fail("A instalação terminou, mas a verificação final não passou. Veja as linhas acima.")
        log("")
        log("INSTALAÇÃO CONCLUÍDA.")
        log("Abra o Discord e ative Mothlight em Configurações > Plugins.")
        return 0
    except Exception as exc:
        log(f"\n{args.modo.upper()} FALHOU: {exc}")
        log(f"Log completo: {log_path}")
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)
        if LOGGER:
            LOGGER.close()


if __name__ == "__main__":
    code = main()
    if "--sem-pausa" not in sys.argv:
        try:
            input("Pressione Enter para fechar...")
        except EOFError:
            pass
    raise SystemExit(code)
