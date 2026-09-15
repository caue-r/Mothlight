#!/usr/bin/env python3
"""Instala os fontes locais do Mothlight no Discord Stable (Windows x64)."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
REQUIRED = (
    "manifest.json", "index.tsx", "native.ts", "stability.ts",
    "vpn-controller.ts", "vpn-proton.ts", "vpn-types.ts", "vpn-windows.ts",
    "bin/win32-x64/proton-confgen.exe",
)
LOG = None


def log(message: str):
    print(message, flush=True)
    if LOG:
        LOG.write(message + "\n")
        LOG.flush()


def run(command: list[str], cwd: Path, env=None) -> str:
    log("$ " + subprocess.list2cmdline(command))
    lines = []
    with subprocess.Popen(command, cwd=cwd, env=env, shell=False,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, encoding="utf-8", errors="replace") as child:
        for line in child.stdout:
            log(line.rstrip())
            lines.append(line)
        code = child.wait()
    if code:
        raise RuntimeError(f"Comando falhou (código {code}): {command[0]}")
    return "".join(lines)


def validate_source(source: Path) -> dict[str, str]:
    hashes = {}
    for name in REQUIRED:
        file = source / name
        if not file.is_file() or file.stat().st_size == 0:
            raise RuntimeError(f"Arquivo local ausente ou vazio: {file}")
        hashes[name] = hashlib.sha256(file.read_bytes()).hexdigest()
    binary = source / REQUIRED[-1]
    with binary.open("rb") as stream:
        if stream.read(2) != b"MZ" or binary.stat().st_size < 4096:
            raise RuntimeError(f"Executável local inválido: {binary}")
    json.loads((source / "manifest.json").read_text(encoding="utf-8-sig"))
    return hashes


def contained(path: Path, root: Path) -> Path:
    resolved, base = path.resolve(), root.resolve()
    if resolved == base or base not in resolved.parents or path.is_symlink() or getattr(path, "is_junction", lambda: False)():
        raise RuntimeError(f"Destino inesperado ou redirecionado: {path}")
    return resolved


def stage_plugin(source: Path, vencord: Path, backup: Path, hashes: dict[str, str]) -> Path:
    plugins = contained(vencord / "src/userplugins", vencord)
    plugins.mkdir(parents=True, exist_ok=True)
    target = contained(plugins / "Mothlight", vencord)
    if target == source.resolve() or target in source.resolve().parents:
        raise RuntimeError("A pasta de origem não pode ser a cópia de destino do plugin.")
    stage = contained(plugins / (".mothlight-stage-" + uuid.uuid4().hex), vencord)
    stage.mkdir()
    try:
        for name in REQUIRED:
            dest = stage / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / name, dest)
        for asset in source.iterdir():
            if asset.is_file() and asset.suffix.lower() in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
                shutil.copy2(asset, stage / asset.name)
        if validate_source(stage) != hashes:
            raise RuntimeError("Os fontes mudaram durante a cópia. Execute novamente.")
        if target.exists():
            # O Vencord pode estar em outra unidade (--vencord-dir).
            shutil.copytree(target, backup / "plugin")
            shutil.rmtree(contained(target, vencord))
        try:
            stage.rename(target)
        except Exception:
            if (backup / "plugin").exists():
                shutil.copytree(backup / "plugin", target)
            raise
    finally:
        if stage.exists():
            shutil.rmtree(contained(stage, vencord))
    return target


def ensure_dependencies(node: str, vencord: Path, root: Path, force: bool):
    if not force and (vencord / "node_modules/esbuild").exists():
        log("Reutilizando as dependências locais. Use --install-deps para reinstalar.")
        return
    corepack = Path(node).resolve().parent / "node_modules/corepack/dist/corepack.js"
    if not corepack.is_file():
        raise RuntimeError("Corepack ausente. Prepare as dependências do Vencord com pnpm antes de continuar.")
    package = json.loads((vencord / "package.json").read_text(encoding="utf-8"))
    manager = package.get("packageManager", "")
    if not re.fullmatch(r"pnpm@\d+\.\d+\.\d+(?:\+sha\d+\.[a-fA-F0-9]+)?", manager):
        raise RuntimeError("packageManager do Vencord não declara uma versão exata do pnpm.")
    env = os.environ.copy()
    env["COREPACK_HOME"] = str(root / "tools/corepack")
    env["COREPACK_ENABLE_DOWNLOAD_PROMPT"] = "0"
    run([node, str(corepack), "pnpm", "install", "--frozen-lockfile"], vencord, env)


def ensure_installer(vencord: Path) -> Path:
    target = contained(vencord / "dist/Installer/VencordInstallerCli.exe", vencord)
    if not target.is_file():
        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_suffix(".download")
        request = urllib.request.Request(
            "https://github.com/Vencord/Installer/releases/latest/download/VencordInstallerCli.exe",
            headers={"User-Agent": "Mothlight-local-installer"},
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response, part.open("wb") as output:
                shutil.copyfileobj(response, output)
            with part.open("rb") as stream:
                if stream.read(2) != b"MZ":
                    raise RuntimeError("Download do instalador oficial inválido.")
            part.replace(target)
        finally:
            part.unlink(missing_ok=True)
    return target


def main(argv=None) -> int:
    global LOG
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-only", action="store_true", help="Compila sem fechar ou instalar no Discord")
    parser.add_argument("--check", action="store_true", help="Valida a origem e mostra os caminhos, sem alterações")
    parser.add_argument("--install-deps", action="store_true", help="Executa pnpm install mesmo com dependências existentes")
    parser.add_argument("--vencord-dir", type=Path, help="Pasta de uma cópia local do Vencord")
    parser.add_argument("--no-pause", action="store_true", help="Não espera Enter ao terminar")
    args = parser.parse_args(argv)
    root = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "Mothlight"
    vencord = (args.vencord_dir or root / "Vencord").resolve()
    try:
        hashes = validate_source(SOURCE)
        log(f"Origem LOCAL: {SOURCE}\nVencord: {vencord}\nArquivos validados: {len(hashes)}")
        if args.check:
            return 0
        if os.name != "nt" or platform.machine().lower() not in ("amd64", "x86_64"):
            raise RuntimeError("Este instalador exige Windows x64.")
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js 22 ou superior não foi encontrado no PATH.")
        logs = root / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
        log_path = logs / f"install-local-{stamp}.log"
        LOG = log_path.open("w", encoding="utf-8")
        log(f"Log: {log_path}\nOrigem: {SOURCE}\nVencord: {vencord}")
        version = run([node, "--version"], SOURCE).strip()
        if not re.fullmatch(r"v\d+\.\d+\.\d+", version) or int(version.split('.')[0][1:]) < 22:
            raise RuntimeError("Node.js 22 ou superior é necessário.")
        if not vencord.exists():
            git = shutil.which("git")
            if not git:
                raise RuntimeError("Instale o Git ou informe --vencord-dir com uma cópia existente.")
            vencord.parent.mkdir(parents=True, exist_ok=True)
            run([git, "clone", "--depth", "1", "https://github.com/Vendicated/Vencord.git", str(vencord)], vencord.parent)
        for name in ("package.json", "scripts/build/build.mjs", "scripts/suppressExperimentalWarnings.js"):
            if not (vencord / name).is_file():
                raise RuntimeError(f"Cópia do Vencord incompleta: {vencord / name}")
        ensure_dependencies(node, vencord, root, args.install_deps)
        backup = root / "backups" / f"local-{stamp}"
        backup.mkdir(parents=True)
        dist = contained(vencord / "dist", vencord)
        had_dist = dist.exists()
        if had_dist:
            shutil.copytree(dist, backup / "dist")
        log(f"Backup: {backup}")
        target = stage_plugin(SOURCE, vencord, backup, hashes)
        try:
            run([node, "--require=./scripts/suppressExperimentalWarnings.js", "scripts/build/build.mjs"], vencord)
            for filename in ("renderer.js", "patcher.js", "preload.js"):
                artifact = dist / filename
                if not artifact.is_file() or artifact.stat().st_size == 0:
                    raise RuntimeError(f"Build incompleto: {artifact}")
            if "Mothlight" not in (dist / "renderer.js").read_text(encoding="utf-8"):
                raise RuntimeError("O build não contém Mothlight.")
            for folder in (dist / "bin/win32-x64", dist / "desktop/bin/win32-x64"):
                folder.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target / REQUIRED[-1], folder / "proton-confgen.exe")
            (backup / "source-hashes.json").write_text(json.dumps(hashes, indent=2), encoding="utf-8")
        except BaseException:
            log("Build falhou; restaurando a cópia anterior do plugin e dist.")
            shutil.rmtree(contained(target, vencord))
            if (backup / "plugin").exists():
                shutil.copytree(backup / "plugin", target)
            if dist.exists():
                shutil.rmtree(contained(dist, vencord))
            if had_dist:
                shutil.copytree(backup / "dist", dist)
            raise
        if args.build_only:
            log(f"BUILD LOCAL CONCLUÍDO: {dist}. Discord não foi fechado nem injetado.")
            return 0
        installer = ensure_installer(vencord)
        log("Build validado. Fechando Discord Stable para instalar a versão local...")
        # Não encerra Update.exe, usado também por outros aplicativos.
        subprocess.run(["taskkill.exe", "/F", "/IM", "Discord.exe"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=False)
        time.sleep(2)
        env = os.environ.copy()
        env.update(VENCORD_USER_DATA_DIR=str(vencord), VENCORD_DEV_INSTALL="1")
        output = run([str(installer), "-install", "-branch", "stable"], vencord, env)
        if re.search(r"\bERROR\b|\bFATAL\b", output, re.I) or not re.search(r"successfully|\bsuccess\b|\binstalled\b|\bpatched\b", output, re.I):
            raise RuntimeError("O instalador oficial não confirmou a instalação. Consulte o log.")
        log("INSTALAÇÃO LOCAL CONCLUÍDA. Abra o Discord e ative Mothlight em Plugins.")
        return 0
    except (Exception, KeyboardInterrupt) as error:
        log(f"ERRO: {error or 'Operação interrompida'}")
        return 1
    finally:
        if LOG:
            LOG.close()
            LOG = None
        if not args.no_pause and not args.check and sys.stdin.isatty():
            try:
                input("Pressione Enter para fechar...")
            except (EOFError, KeyboardInterrupt):
                pass


if __name__ == "__main__":
    raise SystemExit(main())
