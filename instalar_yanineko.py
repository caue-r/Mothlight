#!/usr/bin/env python3
"""Instalador automático do YaniNeko/Vencord para Windows x64.
Uso: py instalar_yanineko.py
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
import zipfile
from pathlib import Path

REPO = "Mockerz/YaniNeko"
PLUGIN_BRANCH = "main"
VENCORD_REPO = "https://github.com/Vendicated/Vencord.git"
PNPM_VERSION = "11.9.0"
REQUIRED = [
    "manifest.json", "index.tsx", "native.ts", "presence.ts", "stability.ts",
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
    headers = {"User-Agent": "YaniNeko-installer/1.0"}
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
            headers={"User-Agent": "YaniNeko-installer/1.0"},
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
    request = urllib.request.Request("https://nodejs.org/dist/index.json", headers={"User-Agent": "YaniNeko-installer/1.0"})
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
    step("[4/8] Baixando o plugin YaniNeko")
    archive = work / "yanineko.zip"
    extracted = work / "yanineko"
    download(f"https://github.com/{REPO}/archive/refs/heads/{PLUGIN_BRANCH}.zip", archive)
    extract_zip(archive, extracted)
    roots = [p for p in extracted.iterdir() if p.is_dir() and p.name.startswith("YaniNeko-")]
    if not roots:
        fail("ZIP do plugin não contém a pasta YaniNeko esperada.")
    source = roots[0]
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


def prepare_vencord(install_root: Path, plugin_source: Path):
    step("[5/8] Baixando ou atualizando o Vencord")
    vencord = install_root / "Vencord"
    if not (vencord / ".git").is_dir():
        shutil.rmtree(vencord, ignore_errors=True)
        run(["git", "clone", "--depth", "1", VENCORD_REPO, str(vencord)], cwd=install_root)
    else:
        run(["git", "fetch", "--depth", "1", "origin", "main"], cwd=vencord)
        run(["git", "reset", "--hard", "origin/main"], cwd=vencord)
        run(["git", "clean", "-fdx", "--exclude=node_modules"], cwd=vencord)
    plugin = vencord / "src" / "userplugins" / "LefferzinBypass"
    shutil.rmtree(plugin, ignore_errors=True)
    (plugin / "bin" / "win32-x64").mkdir(parents=True, exist_ok=True)
    for name in REQUIRED:
        shutil.copy2(plugin_source / name, plugin / name)
    shutil.copy2(plugin_source / "bin" / "win32-x64" / "proton-confgen.exe", plugin / "bin" / "win32-x64")
    log("OK: Vencord e plugin preparados")
    return vencord


def build(vencord: Path, plugin_source: Path):
    step("[6/8] Instalando dependências e compilando")
    pnpm = shutil.which("pnpm") or "pnpm"
    run([pnpm, "install", "--frozen-lockfile"], cwd=vencord)
    run([pnpm, "build"], cwd=vencord)
    renderer = vencord / "dist" / "renderer.js"
    if not renderer.is_file():
        fail("O build não gerou dist\\renderer.js.")
    if "LefferzinBypass" not in renderer.read_text(encoding="utf-8", errors="ignore"):
        fail("O plugin não apareceu no renderer.js.")
    dist_bin = vencord / "dist" / "desktop" / "bin" / "win32-x64"
    dist_bin.mkdir(parents=True, exist_ok=True)
    shutil.copy2(plugin_source / "bin" / "win32-x64" / "proton-confgen.exe", dist_bin)
    log("OK: build validado e binário copiado")


def inject(vencord: Path):
    step("[7/8] Fechando Discord e instalando no Discord Stable")
    for process in ("Discord", "Update"):
        subprocess.run(["taskkill", "/F", "/IM", process + ".exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(3)
    installer = vencord / "scripts" / "runInstaller.mjs"
    if not installer.is_file():
        fail("Injetor oficial do Vencord não foi encontrado.")
    result = run(["node", str(installer), "--", "--install", "-branch", "stable"], cwd=vencord, check=False)
    combined = result.stdout or ""
    if result.returncode != 0 or not re.search(r"success|installed|patched|already", combined, re.I):
        fail("A injeção não foi confirmada pelo instalador oficial.")
    log("OK: injeção concluída")


LOGGER = None

def main() -> int:
    global LOGGER
    if os.name != "nt":
        print("ERRO: este script foi feito para Windows.")
        return 1
    if sys.maxsize <= 2**32:
        print("ERRO: o projeto exige Windows 64-bit.")
        return 1
    local_appdata = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    root = local_appdata / "LefferzinBypass"
    tools = root / "tools"
    logs = root / "logs"
    root.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    log_path = logs / f"install-{time.strftime('%Y%m%d-%H%M%S')}.log"
    LOGGER = log_path.open("w", encoding="utf-8")
    work = Path(tempfile.mkdtemp(prefix="YaniNeko-"))
    script_dir = Path(__file__).resolve().parent
    log("=" * 54)
    log(" YaniNeko - Instalador Python automático")
    log("=" * 54)
    log(f"Log: {log_path}")
    try:
        install_git(tools)
        install_node(tools)
        install_pnpm(tools)
        plugin_source = download_plugin(work, script_dir)
        vencord = prepare_vencord(root, plugin_source)
        build(vencord, plugin_source)
        inject(vencord)
        step("[8/8] Finalização")
        log("INSTALAÇÃO CONCLUÍDA.")
        log("Abra o Discord e ative LefferzinBypass em Configurações > Plugins.")
        return 0
    except Exception as exc:
        log(f"\nINSTALAÇÃO FALHOU: {exc}")
        log(f"Log completo: {log_path}")
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)
        if LOGGER:
            LOGGER.close()


if __name__ == "__main__":
    code = main()
    input("Pressione Enter para fechar...")
    raise SystemExit(code)
