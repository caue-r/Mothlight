import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import https from "https";
import net from "net";
import { promises as dns } from "dns";
import { execFile, execFileSync } from "child_process";

import {
    VPN_SERVICE_NAMES,
    formatAllowedApps,
    safeDiagnosticDetail,
    sanitizeWireGuardConfig,
    validateWireGuardConfig,
    type WireGuardConfigValidation,
} from "./vpn-types";

export const WIRESOCK_VERSION = "3.4.8.1";
const WIRESOCK_DOWNLOAD = "https://wiresock.net/_api/download-release.php?product=wiresock-secure-connect-sdk&platform=x64&version=3.4.8.1&channel=winget";
const WIRESOCK_INSTALLER_SHA256 = "abfeebdc645de36b95fabbed00c7fdb0bf4d0c68c5518608450619c61876d33e";
const WIRESOCK_DRIVER_NAMES = ["ndiswg", "NDISRD"] as const;
const WIRESOCK_EXECUTABLE = "wiresock-client.exe";
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

export type WireSockLogger = (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;

export interface WireSockCandidate {
    executable: string;
    booster: string;
    executableVersion: string;
    boosterVersion: string;
}

export interface WireSockInspection {
    active: boolean;
    owned: boolean;
    services: string[];
    registeredServices: string[];
    foreignRegisteredServices: string[];
    processIds: number[];
    reason: string | null;
}

export interface WireSockCleanupResult {
    stopped: boolean;
    servicesResidual: string[];
    processResidual: number[];
    networkLockReset: boolean;
    dnsCleared: boolean;
    dnsFlushed: boolean;
    error?: string;
}

export interface WireSockStartResult {
    executable: string;
    configPath: string;
    allowedApps: string;
}

export interface WindowsNetworkDiagnostic {
    ok: boolean;
    dnsOk: boolean;
    httpsOk: boolean;
    detail: string;
}

function logError(error: unknown): string {
    const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown; code?: unknown } | null;
    return safeDiagnosticDetail(value?.stderr || value?.stdout || value?.message || error, 500);
}

function isWindows(): boolean {
    return process.platform === "win32";
}

function quotePowerShell(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function normalizedPath(value: string): string {
    return value.trim().replace(/^"|"$/g, "").replace(/[\\/]+/g, "\\").toLowerCase();
}

function containsConfig(commandLine: string | null, configPath: string): boolean {
    if (!commandLine) return false;
    return normalizedPath(commandLine).includes(normalizedPath(configPath));
}

function serviceExists(name: string): boolean {
    if (!isWindows()) return false;
    try {
        execFileSync("sc.exe", ["query", name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 5000 });
        return true;
    } catch (error) {
        const code = Number((error as { status?: unknown })?.status);
        if (code === 1060) return false;
        const value = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
        const output = `${String(value.stdout ?? "")} ${String(value.stderr ?? "")} ${String(value.message ?? "")}`.toLowerCase();
        // Em algumas versões do Windows o wrapper do Node não expõe
        // status=1060, mas o sc.exe ainda informa que o serviço não existe.
        if (/1060|does not exist|não existe|service name is invalid|nome do serviço inválido/.test(output)) return false;
        // Alguns wrappers retornam erro sem stdout/stderr útil. Nesse caso,
        // Get-Service distingue um nome inexistente de uma falha real de
        // permissão sem depender do idioma/localização do sc.exe.
        try {
            const probe = `$s=Get-Service -Name '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue; if($s){'EXISTS'}`;
            const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
                encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000,
            }).trim();
            if (!result) return false;
            if (result.includes("EXISTS")) return true;
        } catch { /* falha real: postura conservadora abaixo */ }
        // Para erros reais de permissão/execução, manter a postura segura e
        // considerar que pode existir, evitando sobrescrever um serviço sem
        // conseguir inspecioná-lo.
        return true;
    }
}

function serviceRunning(name: string): boolean {
    if (!isWindows()) return false;
    try {
        const output = execFileSync("sc.exe", ["query", name], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000,
        });
        return /STATE\s*:\s*\d+\s+RUNNING/i.test(output);
    } catch {
        return false;
    }
}

function serviceCommand(name: string): string | null {
    if (!isWindows() || !serviceExists(name)) return null;
    try {
        const script = `$s=Get-CimInstance Win32_Service -Filter "Name='${name.replace(/'/g, "''")}'"; if($s){$s.PathName}`;
        const cimPath = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000,
        }).trim();
        if (cimPath) return cimPath;
    } catch {
        // O fallback sc.exe qc abaixo pode expor o comando sem CIM/WMI.
    }
    try {
        const output = execFileSync("sc.exe", ["qc", name], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000,
        });
        const line = output.split(/\r?\n/).find(row => /BINARY_PATH_NAME|BIN.RIO|PATH_NAME/i.test(row));
        return line ? (line.split(":").slice(1).join(":").trim() || null) : null;
    } catch {
        return null;
    }
}

function assertPluginServiceSlot(configPath: string): void {
    const name = VPN_SERVICE_NAMES[0];
    if (!serviceExists(name)) return;
    // O instalador do SDK pode registrar o serviço antes de o plugin aplicar
    // seu perfil. Um serviço parado não possui túnel nem sessão para proteger;
    // ele pode ser reconfigurado abaixo. Serviço em execução continua sendo
    // tratado como externo se o perfil não for explicitamente o nosso.
    if (!serviceRunning(name)) return;
    const command = serviceCommand(name);
    if (!command || !containsConfig(command, configPath))
        throw new Error("O serviço WireSock já está registrado com outro perfil (possivelmente pela GUI ou por outro plugin). Desative-o antes de usar a VPN do plugin.");
}

function runningWireSockProcesses(): Array<{ pid: number; commandLine: string | null }> {
    if (!isWindows()) return [];
    try {
        const script = "$p=Get-CimInstance Win32_Process -Filter \"Name='wiresock-client.exe'\" | ForEach-Object { [PSCustomObject]@{pid=[int]$_.ProcessId; commandLine=$_.CommandLine} }; $p | ConvertTo-Json -Compress";
        const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000,
        }).trim();
        if (!output) return [];
        const parsed = JSON.parse(output) as unknown;
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return rows.flatMap(row => {
            if (row === null || typeof row !== "object") return [];
            const value = row as { pid?: unknown; commandLine?: unknown };
            const pid = Number(value.pid);
            if (!Number.isInteger(pid) || pid <= 0) return [];
            return [{ pid, commandLine: typeof value.commandLine === "string" ? value.commandLine : null }];
        });
    } catch {
        return [];
    }
}

export function inspectWireSock(configPath?: string): WireSockInspection {
    if (!isWindows()) return {
        active: false,
        owned: false,
        services: [],
        registeredServices: [],
        foreignRegisteredServices: [],
        processIds: [],
        reason: null,
    };
    const registeredServices = VPN_SERVICE_NAMES.filter(serviceExists);
    const foreignRegisteredServices = configPath
        ? registeredServices.filter(name => !containsConfig(serviceCommand(name), configPath))
        : registeredServices;
    const services = VPN_SERVICE_NAMES.filter(serviceRunning);
    const processes = runningWireSockProcesses();
    const processIds = processes.map(process => process.pid);
    const active = services.length > 0 || processes.length > 0;
    if (!active) return {
        active: false,
        owned: false,
        services: [],
        registeredServices,
        foreignRegisteredServices,
        processIds: [],
        reason: foreignRegisteredServices.length > 0
            ? "Um serviço WireSock está registrado com outro perfil, GUI ou plugin."
            : null,
    };
    if (!configPath) return {
        active,
        owned: false,
        services,
        registeredServices,
        foreignRegisteredServices,
        processIds,
        reason: "WireSock já está ativo fora do perfil do plugin.",
    };

    const ownService = services.filter(name => containsConfig(serviceCommand(name), configPath));
    const ownProcess = processes.filter(process => containsConfig(process.commandLine, configPath));
    const explicitForeignService = services.filter(name => {
        const cmd = serviceCommand(name);
        if (!cmd) return false;
        return !containsConfig(cmd, configPath);
    });
    // WMI/CIM frequentemente não devolve CommandLine para um processo de
    // serviço quando o Discord não está elevado. Linha ausente é desconhecida,
    // não evidência de outro perfil. Só um caminho explicitamente diferente
    // deve transformar o estado em conflito.
    const hasExplicitForeignProcess = processes.some(process => Boolean(process.commandLine) && !containsConfig(process.commandLine, configPath));
    const ownedByPositiveProof = (ownService.length > 0 || ownProcess.length > 0)
        && explicitForeignService.length === 0
        && !hasExplicitForeignProcess
        && foreignRegisteredServices.length === 0;
    // Postura conservadora por exclusão: se NÃO temos nenhuma evidência
    // explícita de coisa externa (nenhum serviço com perfil diferente
    // confirmado, nenhum processo estranho confirmado, zero serviços
    // registrados em slots que não são os nossos), assumimos ownership
    // para evitar o bug do "falso externo" quando o WMI demora para
    // devolver CommandLine logo após o start do serviço.
    const ownedByExclusion = !ownedByPositiveProof
        && explicitForeignService.length === 0
        && !hasExplicitForeignProcess
        && foreignRegisteredServices.length === 0
        && registeredServices.every(name => VPN_SERVICE_NAMES.includes(name as typeof VPN_SERVICE_NAMES[number]));
    if (ownedByPositiveProof || ownedByExclusion)
        return { active, owned: true, services, registeredServices, foreignRegisteredServices, processIds, reason: null };
    return {
        active,
        owned: false,
        services,
        registeredServices,
        foreignRegisteredServices,
        processIds,
        reason: ownService.length > 0 || ownProcess.length > 0
            ? foreignRegisteredServices.length > 0 || explicitForeignService.length > 0
                ? "WireSock próprio e um serviço externo foram detectados ao mesmo tempo; a operação foi bloqueada."
                : "WireSock próprio e externo foram detectados ao mesmo tempo; a operação foi bloqueada."
            : "WireSock já está ativo por outro perfil, pela GUI ou por outro plugin.",
    };
}

export function wireSockSearchRoots(env: NodeJS.ProcessEnv = process.env): string[] {
    const programFiles = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files"]
        .filter((value): value is string => Boolean(value));
    const roots = new Set<string>();
    for (const directory of programFiles) roots.add(path.join(directory, "WireSock Secure Connect"));
    if (env.LOCALAPPDATA) roots.add(path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages"));
    return [...roots];
}

function pairIfPresent(executable: string): { executable: string; booster: string } | null {
    const booster = path.join(path.dirname(executable), "wgbooster.dll");
    return fs.existsSync(executable) && fs.existsSync(booster) ? { executable, booster } : null;
}

function candidatePairs(env: NodeJS.ProcessEnv = process.env): Array<{ executable: string; booster: string }> {
    const pairs: Array<{ executable: string; booster: string }> = [];
    const seen = new Set<string>();
    const add = (executable: string) => {
        const pair = pairIfPresent(executable);
        const key = executable.toLowerCase();
        if (pair && !seen.has(key)) {
            seen.add(key);
            pairs.push(pair);
        }
    };
    for (const root of wireSockSearchRoots(env)) {
        for (const relative of [WIRESOCK_EXECUTABLE, path.join("sdk", WIRESOCK_EXECUTABLE)]) add(path.join(root, relative));
        if (!/Packages$/i.test(root)) continue;
        try {
            for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
                if (!entry.isDirectory() || !/wiresock|ntkernel\.wiresock/i.test(entry.name)) continue;
                const packageRoot = path.join(root, entry.name);
                for (const layout of [packageRoot, path.join(packageRoot, "x64")]) {
                    add(path.join(layout, WIRESOCK_EXECUTABLE));
                    add(path.join(layout, "sdk", WIRESOCK_EXECUTABLE));
                }
            }
        } catch {}
    }
    return pairs;
}

function versionOf(file: string): string | null {
    try {
        const script = `(Get-Item -LiteralPath ${quotePowerShell(file)}).VersionInfo.FileVersion`;
        const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000,
        }).trim();
        return /^\d+\.\d+\.\d+\.\d+$/.test(output) ? output : null;
    } catch {
        return null;
    }
}

function compareVersions(left: string, right: string): number {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let i = 0; i < 4; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) ? 1 : -1;
    }
    return 0;
}

export function selectWireSockCandidate(candidates: WireSockCandidate[]): WireSockCandidate | null {
    return candidates
        .filter(candidate => compareVersions(candidate.executableVersion, WIRESOCK_VERSION) >= 0)
        .filter(candidate => compareVersions(candidate.boosterVersion, WIRESOCK_VERSION) >= 0)
        .filter(candidate => candidate.executableVersion === candidate.boosterVersion)
        .sort((a, b) => compareVersions(b.executableVersion, a.executableVersion))[0] ?? null;
}

export function findWireSockCandidate(env: NodeJS.ProcessEnv = process.env): WireSockCandidate | null {
    if (!isWindows()) return null;
    const candidates = candidatePairs(env).flatMap(pair => {
        const executableVersion = versionOf(pair.executable);
        const boosterVersion = versionOf(pair.booster);
        return executableVersion && boosterVersion
            ? [{ ...pair, executableVersion, boosterVersion }]
            : [];
    });
    return selectWireSockCandidate(candidates);
}

function downloadInstaller(target: string, url = WIRESOCK_DOWNLOAD, redirects = 0): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "https:" || !/(^|\.)wiresock\.net$/i.test(parsed.hostname)) {
                reject(new Error("Redirecionamento para host não autorizado do instalador WireSock."));
                return;
            }
        } catch {
            reject(new Error("URL oficial do WireSock inválida."));
            return;
        }
        const request = https.get(url, response => {
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                if (redirects >= 3) { reject(new Error("Muitos redirecionamentos no instalador WireSock.")); return; }
                // O endpoint oficial pode apontar para o CDN do próprio wiresock.net.
                const next = new URL(response.headers.location, url).toString();
                void downloadInstaller(target, next, redirects + 1).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`Download WireSock retornou HTTP ${response.statusCode ?? "desconhecido"}.`));
                return;
            }
            const output = fs.createWriteStream(target, { flags: "wx" });
            let total = 0;
            let done = false;
            const fail = (error: Error) => {
                if (done) return;
                done = true;
                response.destroy();
                output.destroy();
                reject(error);
            };
            response.on("data", (chunk: Buffer) => {
                total += chunk.length;
                if (total > MAX_DOWNLOAD_BYTES) fail(new Error("O instalador WireSock excede o limite de tamanho."));
            });
            response.once("error", fail);
            output.once("error", fail);
            response.pipe(output);
            output.once("finish", () => output.close(error => {
                if (error) fail(error);
                else if (!done) {
                    done = true;
                    resolve();
                }
            }));
        });
        request.setTimeout(120_000, () => request.destroy(new Error("Timeout ao baixar o instalador WireSock.")));
        request.once("error", reject);
    });
}

function sha256(file: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runElevatedInstaller(installer: string): Promise<void> {
    const command = `try { $p=Start-Process -FilePath ${quotePowerShell(installer)} -ArgumentList @('/quiet','/norestart') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; if($null -eq $p){ exit 1223 }; exit [int]$p.ExitCode } catch { if($_.Exception.NativeErrorCode -eq 1223){ exit 1223 }; Write-Error $_; exit 1 }`;
    return new Promise((resolve, reject) => {
        const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
            windowsHide: true,
            timeout: 120_000,
        }, error => error ? reject(error) : resolve());
        child.once("error", reject);
    });
}

let installInFlight: Promise<string> | null = null;

export function ensureWireSockInstalled(log: WireSockLogger): Promise<string> {
    installInFlight ??= ensureWireSockInstalledOnce(log).finally(() => { installInFlight = null; });
    return installInFlight;
}

async function ensureWireSockInstalledOnce(log: WireSockLogger): Promise<string> {
    if (!isWindows()) throw new Error("A VPN do plugin nesta versão exige Windows x64.");
    if (process.arch !== "x64") throw new Error("A VPN do plugin nesta versão exige Windows x64.");
    const existing = findWireSockCandidate();
    if (existing) {
        log("info", "WireSock SDK compatível encontrado", { version: existing.executableVersion });
        return existing.executable;
    }

    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "golive-plugin-wiresock-"));
    const installer = path.join(temporary, "wiresock-sdk.exe");
    try {
        log("info", "baixando instalador oficial do WireSock", { version: WIRESOCK_VERSION });
        await downloadInstaller(installer);
        if (sha256(installer).toLowerCase() !== WIRESOCK_INSTALLER_SHA256)
            throw new Error("Hash do instalador WireSock não corresponde ao release oficial fixado.");
        log("info", "instalando WireSock com elevação do Windows");
        await runElevatedInstaller(installer);
        const installed = findWireSockCandidate();
        if (!installed) throw new Error("O instalador WireSock terminou, mas não deixou uma instalação SDK compatível.");
        return installed.executable;
    } catch (error) {
        const code = Number((error as { code?: unknown })?.code);
        if (code === 1223) throw new Error("A instalação do WireSock foi cancelada pelo usuário.");
        throw new Error(`Não foi possível preparar o WireSock: ${logError(error)}`);
    } finally {
        await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
}

export function validateWireGuardProfile(raw: string): WireGuardConfigValidation {
    return validateWireGuardConfig(raw);
}

function serviceScript(executable: string, configPath: string): string {
    const expected = `"${executable}" service -config "${configPath}" -log-level info -network-lock disabled`;
    return `$ErrorActionPreference='Stop'
try {
  $name='wiresock-client-service'
  $expected=${quotePowerShell(expected)}
  $config=${quotePowerShell(configPath)}
  $service=Get-Service -Name $name -ErrorAction SilentlyContinue
  $info=Get-CimInstance Win32_Service -Filter "Name='$name'"
  if($info -and $service -and $service.Status -ne 'Stopped' -and (-not $info.PathName -or $info.PathName.IndexOf($config,[System.StringComparison]::OrdinalIgnoreCase) -lt 0)){ throw 'O serviço WireSock já está registrado com outro perfil' }
  if($service -and $service.Status -ne 'Stopped') { Stop-Service -Name $name -Force; $service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(20)) }
  if(-not $service) {
    & ${quotePowerShell(executable)} install -start-type 3 -config ${quotePowerShell(configPath)} -log-level info -network-lock disabled
    if($LASTEXITCODE -ne 0){ throw 'Falha ao instalar o serviço WireSock' }
  }
  $info=Get-CimInstance Win32_Service -Filter "Name='$name'"
  if(-not $info){ throw 'Serviço WireSock não encontrado após instalação' }
  $change=Invoke-CimMethod -InputObject $info -MethodName Change -Arguments @{PathName=$expected;StartMode='Manual'}
  if($change.ReturnValue -ne 0){ throw "Falha ao atualizar o perfil do serviço: $($change.ReturnValue)" }
  $actual=Get-CimInstance Win32_Service -Filter "Name='$name'"
  if($actual.PathName -cne $expected){ throw 'O serviço WireSock permaneceu com outra configuração' }
  Start-Service -Name $name
  (Get-Service -Name $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(20))
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
}

function elevatedPowerShellArgs(script: string): string[] {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const wrapper = `$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){ & powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}; exit $LASTEXITCODE }
$child=Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encoded}'
exit $child.ExitCode`;
    return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(wrapper, "utf16le").toString("base64")];
}

export async function startWireSockService(
    configPath: string,
    rawConfig: string,
    allowedAppPaths: string[],
    log: WireSockLogger,
): Promise<WireSockStartResult> {
    if (!isWindows() || process.arch !== "x64") throw new Error("A VPN do plugin nesta versão exige Windows x64.");
    const allowedApps = formatAllowedApps(allowedAppPaths);
    const validation = validateWireGuardProfile(rawConfig);
    if (!validation.valid) throw new Error(validation.error);

    const current = inspectWireSock(configPath);
    if (current.active && !current.owned) throw new Error(current.reason || "WireSock externo já está ativo.");
    assertPluginServiceSlot(configPath);
    const executable = await ensureWireSockInstalled(log);
    // A instalação do SDK pode demorar e outro plugin/GUI pode registrar o
    // slot nesse intervalo. Reinspecione imediatamente antes de escrever e
    // iniciar o serviço; o script elevado também repete essa proteção.
    const beforeStart = inspectWireSock(configPath);
    if (beforeStart.active && !beforeStart.owned) throw new Error(beforeStart.reason || "WireSock externo já está ativo.");
    const target = path.resolve(configPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const sanitized = sanitizeWireGuardConfig(rawConfig, allowedApps);
    const staging = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(staging, sanitized, "utf8");
    fs.renameSync(staging, target);

    try {
        execFileSync("powershell.exe", elevatedPowerShellArgs(serviceScript(executable, target)), {
            windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
        });
    } catch (error) {
        try { fs.rmSync(staging, { force: true }); } catch {}
        log("error", "falha ao iniciar o serviço WireSock", { erro: logError(error) });
        throw new Error("Não foi possível configurar/iniciar o serviço WireSock. Confira a permissão de administrador e os logs.");
    }

    let inspection: WireSockInspection | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
        await wait(attempt < 3 ? 500 : 900);
        inspection = inspectWireSock(target);
        if (inspection.active && inspection.owned) break;
        log("warn", "aguardando WireSock confirmar perfil próprio após ativação", { tentativa: attempt + 1, active: inspection.active, owned: inspection.owned, motivo: inspection.reason });
    }
    // Último recurso: se ao menos o serviço está ativo e não há conflito
    // EXPLÍCITO com nada externo, aceitamos como sucesso (evita falso
    // negativo em máquinas onde WMI/CIM demora muito mais que o normal).
    if (!inspection || !inspection.active) {
        log("error", "WireSock não ficou ativo após a ativação", { motivo: inspection?.reason || "serviço ausente" });
        throw new Error("O serviço WireSock não ficou ativo após a ativação. Rode 0-LIMPAR-WIRESOCK.bat e tente novamente.");
    }
    if (!inspection.owned) {
        const hasConflict = inspection.foreignRegisteredServices.length > 0
            || inspection.reason?.includes("externo")
            || inspection.reason?.includes("outro perfil");
        if (hasConflict) {
            log("error", "WireSock não confirmou ownership e há conflito externo detectado", { motivo: inspection.reason });
            throw new Error(`WireSock em conflito: ${inspection.reason || "serviço externo"}. Feche a GUI do WireSock/Outro plugin e tente novamente.`);
        }
        log("warn", "WireSock ativo mas ownership não confirmado por WMI; prosseguindo por exclusão (sem conflito detectado)", { services: inspection.services, processIds: inspection.processIds });
    }
    clearWireSockDns(log);
    log("info", "serviço WireSock ativo com filtro por aplicativo", { config: target, allowedApps });
    return { executable, configPath: target, allowedApps };
}

function runAsAdministrator(file: string, args: string[], log: WireSockLogger): boolean {
    try {
        execFileSync(file, args, { stdio: "ignore", windowsHide: true, timeout: 30_000 });
        return true;
    } catch {
        try {
            const argumentList = args.map(arg => quotePowerShell(arg)).join(",");
            const script = `$p=Start-Process -FilePath ${quotePowerShell(file)} -ArgumentList @(${argumentList}) -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
            execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
                stdio: "ignore", windowsHide: false, timeout: 30_000,
            });
            return true;
        } catch (error) {
            log("warn", "operação elevada do WireSock falhou", { erro: logError(error) });
            return false;
        }
    }
}

function resetNetworkLock(executable: string, log: WireSockLogger): boolean {
    if (runAsAdministrator(executable, ["reset-network-lock"], log)) return true;
    return false;
}

export function clearWireSockDns(log: WireSockLogger): boolean {
    if (!isWindows()) return true;
    try {
        const script = "Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -match 'ProTUN|WireSock' -or $_.InterfaceDescription -match 'ProTUN|WireSock' } | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ResetServerAddresses -ErrorAction SilentlyContinue }";
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
        return true;
    } catch (error) {
        log("warn", "não consegui limpar DNS do adaptador WireSock", { erro: logError(error) });
        return false;
    }
}

function killOwnProcesses(processIds: number[], log: WireSockLogger): void {
    for (const pid of processIds) {
        if (!runAsAdministrator("taskkill.exe", ["/F", "/T", "/PID", String(pid)], log))
            log("warn", "não consegui encerrar processo WireSock próprio", { pid });
    }
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function waitSync(ms: number): void {
    const start = Date.now();
    while (Date.now() - start < ms) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(50, ms));
    }
}

export async function stopOwnedWireSock(configPath: string, log: WireSockLogger): Promise<WireSockCleanupResult> {
    if (!isWindows()) return { stopped: true, servicesResidual: [], processResidual: [], networkLockReset: false, dnsCleared: false, dnsFlushed: false };
    const initial = inspectWireSock(configPath);
    if (initial.foreignRegisteredServices.length > 0) {
        const error = initial.reason || "Serviço WireSock externo registrado";
        log("warn", "limpeza recusada para preservar serviço WireSock externo", { motivo: error });
        return { stopped: false, servicesResidual: initial.services, processResidual: initial.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
    }
    if (initial.active && !initial.owned) {
        const error = initial.reason || "WireSock externo detectado";
        log("warn", "limpeza recusada para preservar WireSock externo", { motivo: error });
        return { stopped: false, servicesResidual: initial.services, processResidual: initial.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
    }

    for (const name of initial.services) {
        if (containsConfig(serviceCommand(name), configPath)) {
            if (!runAsAdministrator("sc.exe", ["stop", name], log))
                log("warn", "não consegui solicitar parada do serviço WireSock próprio", { servico: name });
        }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
        await wait(500);
        const current = inspectWireSock(configPath);
        if (!current.active) break;
        if (!current.owned) {
            const error = current.reason || "WireSock externo apareceu durante a limpeza";
            log("error", "limpeza interrompida ao detectar WireSock externo", { motivo: error });
            return { stopped: false, servicesResidual: current.services, processResidual: current.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
        }
        killOwnProcesses(current.processIds, log);
    }

    const executable = findWireSockCandidate()?.executable;
    // O lock de rede pertence à instância que acabamos de confirmar como nossa.
    // Resetá-lo mesmo depois de o processo sumir fecha o caso de parada tardia.
    const networkLockReset = executable ? resetNetworkLock(executable, log) : false;
    const dnsCleared = clearWireSockDns(log);
    let dnsFlushed = false;
    try {
        execFileSync("ipconfig.exe", ["/flushdns"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
        dnsFlushed = true;
    } catch (error) {
        log("warn", "flushdns falhou", { erro: logError(error) });
    }
    const residual = inspectWireSock(configPath);
    // O serviço criado pelo plugin usa -network-lock disabled. Portanto, a
    // falha ao executar reset-network-lock não significa que a VPN continua
    // ativa; exigir esse retorno no primeiro uso colocava o estado em
    // recovery_required mesmo com serviço e processo já encerrados.
    const stopped = !residual.active;
    if (stopped) log("info", "WireSock próprio e processo verificados como parados", { networkLockReset });
    else if (residual.active) log("error", "limpeza deixou resíduo WireSock próprio", { services: residual.services, pids: residual.processIds });
    else log("error", "processo WireSock parou, mas o network-lock não foi confirmado como restaurado");
    return {
        stopped,
        servicesResidual: residual.services,
        processResidual: residual.processIds,
        networkLockReset,
        dnsCleared,
        dnsFlushed,
        ...(stopped ? {} : { error: "O WireSock próprio ainda permanece ativo." }),
    };
}

function isWireSockProcessAliveGlobal(): boolean {
    if (!isWindows()) return false;
    try {
        const output = execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq wiresock-client.exe"], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000,
        });
        return output.toLowerCase().includes("wiresock-client.exe");
    } catch {
        return false;
    }
}

function isWireSockActiveGlobal(): boolean {
    if (!isWindows()) return false;
    return VPN_SERVICE_NAMES.some(serviceRunning) || isWireSockProcessAliveGlobal();
}

function stopAllWireSockServicesOnce(log: WireSockLogger): void {
    for (const name of VPN_SERVICE_NAMES) {
        if (!serviceRunning(name)) continue;
        if (!runAsAdministrator("sc.exe", ["stop", name], log))
            log("warn", "stopAllWireSockNuclear: sc stop falhou mesmo com elevacao", { servico: name });
    }
}

function killAllWireSockProcesses(log: WireSockLogger): void {
    if (!runAsAdministrator("taskkill.exe", ["/F", "/T", "/IM", "wiresock-client.exe"], log))
        log("warn", "stopAllWireSockNuclear: taskkill wiresock-client.exe falhou mesmo com elevacao");
}

function deleteAllWireSockServices(log: WireSockLogger): void {
    if (!isWindows()) return;
    for (const name of VPN_SERVICE_NAMES) {
        if (!serviceExists(name)) continue;
        if (serviceRunning(name)) {
            if (!runAsAdministrator("sc.exe", ["stop", name], log))
                log("warn", "deleteAllWireSockServices: sc stop falhou mesmo com elevacao", { servico: name });
            waitSync(2000);
        }
        if (!runAsAdministrator("sc.exe", ["delete", name], log))
            log("warn", "deleteAllWireSockServices: sc delete falhou mesmo com elevacao", { servico: name });
        waitSync(1500);
    }
}

export async function stopAllWireSockNuclear(log: WireSockLogger): Promise<WireSockCleanupResult> {
    if (!isWindows()) return { stopped: true, servicesResidual: [], processResidual: [], networkLockReset: false, dnsCleared: false, dnsFlushed: false };
    const initialActive = isWireSockActiveGlobal();
    let attempts = 0;
    let networkLockReset = false;
    let servicesResidual: string[] = [];
    let processResidual: number[] = [];

    for (let pass = 0; pass < 2; pass++) {
        attempts++;
        stopAllWireSockServicesOnce(log);
        killAllWireSockProcesses(log);
        for (let i = 0; i < 10 && isWireSockActiveGlobal(); i++) await wait(250);
        servicesResidual = VPN_SERVICE_NAMES.filter(serviceRunning);
        processResidual = runningWireSockProcesses().map(p => p.pid);
        if (servicesResidual.length === 0 && processResidual.length === 0) break;
        log("warn", "stopAllWireSockNuclear: residuo detectado, repetindo limpeza elevada", { pass: pass + 1, servicesResidual, pidsResiduais: processResidual });
        const executable = findWireSockCandidate()?.executable;
        if (executable) networkLockReset = resetNetworkLock(executable, log) || networkLockReset;
    }

    deleteAllWireSockServices(log);
    await wait(1500);

    servicesResidual = VPN_SERVICE_NAMES.filter(serviceRunning);
    processResidual = runningWireSockProcesses().map(p => p.pid);

    if (initialActive || servicesResidual.length > 0 || processResidual.length > 0) {
        const executable = findWireSockCandidate()?.executable;
        if (executable) networkLockReset = resetNetworkLock(executable, log) || networkLockReset;
    }

    const dnsCleared = clearWireSockDns(log);
    let dnsFlushed = false;
    try {
        execFileSync("ipconfig.exe", ["/flushdns"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
        dnsFlushed = true;
    } catch (error) {
        log("warn", "stopAllWireSockNuclear: flushdns falhou", { erro: logError(error) });
    }

    const servicesStillExist = VPN_SERVICE_NAMES.filter(serviceExists);
    if (servicesStillExist.length > 0) {
        log("warn", "stopAllWireSockNuclear: servicos WireSock ainda existem no SCM apos sc delete (reinicie o PC para remover completamente)", { servicos: servicesStillExist });
    }

    const residualActive = servicesResidual.length > 0 || processResidual.length > 0;
    const stopped = !residualActive;
    const resultado = {
        stopped,
        servicesResidual,
        processResidual,
        networkLockReset,
        dnsCleared,
        dnsFlushed,
        servicesDeleted: servicesStillExist.length === 0,
        ...(stopped ? {} : { error: "WireSock residual detectado apos limpeza nuclear." }),
    };
    if (stopped) log("info", "stopAllWireSockNuclear: servico, processo e lock verificados como parados");
    else log("error", "stopAllWireSockNuclear: limpeza deixou residuo", resultado);
    return resultado;
}

export function wipeWireSockHard(log: WireSockLogger): { stopped: boolean; servicesDeletedCount: number } {
    let deletedCount = 0;
    try {
        deleteAllWireSockServices(log);
        deletedCount = VPN_SERVICE_NAMES.filter(n => !serviceExists(n)).length;
        killAllWireSockProcesses(log);
        waitSync(2500);
        killAllWireSockProcesses(log);
        return { stopped: !isWireSockActiveGlobal(), servicesDeletedCount: deletedCount };
    } catch (error) {
        log("error", "wipeWireSockHard: falha na limpeza forcada", { erro: logError(error) });
        return { stopped: !isWireSockActiveGlobal(), servicesDeletedCount: deletedCount };
    }
}

function httpsCheck(url: string): Promise<boolean> {
    return new Promise(resolve => {
        const request = https.get(url, { timeout: 7000 }, response => {
            response.resume();
            response.once("end", () => resolve(true));
        });
        request.once("timeout", () => { request.destroy(); resolve(false); });
        request.once("error", () => resolve(false));
    });
}

export async function diagnoseWindowsNetwork(log: WireSockLogger): Promise<WindowsNetworkDiagnostic> {
    if (!isWindows()) return { ok: true, dnsOk: true, httpsOk: true, detail: "plataforma fora do escopo Windows" };
    const dnsOk = await Promise.all(["www.microsoft.com", "gateway.discord.gg", "updates.discord.com"].map(host => dns.lookup(host).then(() => true).catch(() => false))).then(results => results.every(Boolean));
    const httpsResults = await Promise.all([
        httpsCheck("https://www.microsoft.com/generate_204"),
        httpsCheck("https://discord.com/api/v9/gateway"),
        httpsCheck("https://updates.discord.com/"),
    ]);
    const httpsOk = httpsResults.some(Boolean);
    const result = { ok: dnsOk && httpsOk, dnsOk, httpsOk, detail: dnsOk && httpsOk ? "diagnóstico concluído" : "DNS/HTTPS apresentou falha" };
    log(result.ok ? "info" : "warn", "diagnóstico assíncrono da rede", { ...result, mode: "log-only" });
    return result;
}

export function routeProbeExecutablePath(directory: string): string {
    return path.join(directory, `.golive-route-probe-${process.pid}-${Date.now()}.exe`);
}

export function copyRouteProbe(source: string, target: string): void {
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("Helper de diagnóstico Proton não encontrado.");
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

export function removeRouteProbe(target: string): void {
    try { fs.rmSync(target, { force: true }); } catch {}
}

export function runRouteProbe(executable: string): Promise<Record<string, unknown> | null> {
    return new Promise(resolve => {
        execFile(executable, ["-route-probe"], { windowsHide: true, timeout: 12_000, encoding: "utf8" }, (_error, stdout) => {
            try {
                const parsed = JSON.parse(String(stdout).trim()) as unknown;
                return resolve(parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : null);
            } catch {
                return resolve(null);
            }
        });
    });
}

export function isWireSockPacketFilterDriverInstalled(): boolean {
    if (!isWindows()) return false;
    return WIRESOCK_DRIVER_NAMES.some(name => {
        try {
            const output = execFileSync("sc.exe", ["query", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000 });
            return !/\b1060\b/.test(output);
        } catch {
            return false;
        }
    });
}

export interface EndpointPingResult {
    host: string;
    port: number;
    pingMs: number;
}

export function pingEndpoint(host: string, port = 443, timeoutMs = 2500): Promise<EndpointPingResult | null> {
    return new Promise(resolve => {
        if (!host || !host.trim()) return resolve(null);
        const normalized = host.trim().toLowerCase();
        const start = Date.now();
        const socket = new net.Socket();
        let done = false;
        const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            try { socket.destroy(); } catch {}
            if (!ok) return resolve(null);
            const elapsed = Date.now() - start;
            if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > timeoutMs * 4) return resolve(null);
            resolve({ host: normalized, port, pingMs: elapsed });
        };
        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once("error", () => finish(false));
        socket.once("connect", () => finish(true));
        try { socket.connect(port, normalized); }
        catch { return resolve(null); }
    });
}

export function extractEndpointFromWireGuardConfig(raw: string): { host: string; port: number } | null {
    try {
        for (const line of String(raw || "").split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const match = /^\s*Endpoint\s*=\s*([^\s:]+)(?::(\d+))?/i.exec(trimmed);
            if (!match) continue;
            const host = match[1].trim();
            const port = match[2] ? parseInt(match[2], 10) : 443;
            if (!host) continue;
            return { host, port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 443 };
        }
        return null;
    } catch {
        return null;
    }
}
