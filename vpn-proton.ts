import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";

import { safeDiagnosticDetail } from "./vpn-types";

export type ProtonLoginErrorCode =
    | "INVALID_CREDENTIALS"
    | "TWO_FACTOR_REQUIRED"
    | "TWO_FACTOR_INVALID"
    | "CAPTCHA_REQUIRED"
    | "CAPTCHA_INVALID"
    | "CAPTCHA_CANCELLED"
    | "NETWORK_ERROR"
    | "TIMEOUT"
    | "MISSING_EXECUTABLE"
    | "SESSION_PERSISTENCE"
    | "CONFIGURATION_ERROR"
    | "UNKNOWN";

export interface ProtonLoginResult {
    success: boolean;
    username?: string;
    code?: ProtonLoginErrorCode;
    message?: string;
    error?: string;
    retryable?: boolean;
    captchaUrl?: string;
}

export type ProtonPlanStatus = "free" | "premium" | "unknown";

export interface ProtonPlanResult {
    success: boolean;
    status: ProtonPlanStatus;
    maxTier?: number;
    planName?: string;
    planTitle?: string;
    checkedAt?: string;
    error?: string;
}

export interface ProtonOptimizationProgress {
    phase: "ping" | "preparing" | "testing" | "finalizing" | "completed" | "failed" | "cancelled";
    total: number;
    tested: number;
    succeeded: number;
    server?: string;
    downloadMbps?: number;
    uploadMbps?: number;
    pingMs?: number;
    status?: "testing" | "success" | "failed";
}

export interface ProtonOptimizationResult {
    success: boolean;
    server?: string;
    country?: string;
    city?: string;
    tier?: string;
    load?: number;
    score?: number;
    pingMs?: number;
    downloadMbps?: number;
    uploadMbps?: number;
    speedTested?: number;
    speedSucceeded?: number;
    endpoint?: string;
    confFile?: string;
    error?: string;
}

export interface RunConfgenOptions {
    args: string[];
    exePath?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onProgress?: (progress: ProtonOptimizationProgress) => void;
    log?: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
}

export interface ConfgenResult {
    code: number | null;
    stdout: string;
    stderr: string;
    json?: Record<string, unknown>;
}

export const MEASUREMENT_CRITERION_VERSION = 5;
const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;
const GENERIC_PLAN_ERROR = "Não foi possível confirmar o plano Proton.";
// O proton-confgen mantém uma conexão durante a operação. Instâncias
// simultâneas podem ser recusadas pelo Proton como conexão duplicada.
let confgenQueue: Promise<unknown> = Promise.resolve();
const CONFGEN_LOCK_PATH = path.join(os.tmpdir(), "lefferzin-proton-confgen.lock");

async function acquireConfgenLock(): Promise<() => void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            const fd = fs.openSync(CONFGEN_LOCK_PATH, "wx");
            try {
                fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, "utf8");
                return () => {
                    try { fs.closeSync(fd); } catch {}
                    try { fs.rmSync(CONFGEN_LOCK_PATH, { force: true }); } catch {}
                };
            } catch (error) {
                try { fs.closeSync(fd); } catch {}
                try { fs.rmSync(CONFGEN_LOCK_PATH, { force: true }); } catch {}
                throw error;
            }
        } catch (error) {
            const code = (error as { code?: unknown })?.code;
            if (code !== "EEXIST") throw error;
            try {
                const age = Date.now() - fs.statSync(CONFGEN_LOCK_PATH).mtimeMs;
                if (age > 10 * 60_000) fs.rmSync(CONFGEN_LOCK_PATH, { force: true });
            } catch {}
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
    throw new Error("Outra operação Proton ainda está finalizando. Tente novamente em alguns segundos.");
}

function logError(error: unknown): string {
    return safeDiagnosticDetail(error, 500);
}

function abortError(): Error {
    const error = new Error("Operação Proton cancelada.");
    error.name = "AbortError";
    return error;
}

function candidatePaths(): string[] {
    const exeName = process.platform === "win32" ? "proton-confgen.exe" : "proton-confgen";
    const pluginFolders = ["goLiveBypass", "LefferzinBypass"];
    const appdata = process.env.APPDATA;
    const localappdata = process.env.LOCALAPPDATA || appdata;
    const equicordInstallDirs: string[] = [];
    if (localappdata) {
        equicordInstallDirs.push(path.join(localappdata, "Equicord"));
        equicordInstallDirs.push(path.join(localappdata, "Vencord"));
    }
    if (appdata) {
        equicordInstallDirs.push(path.join(appdata, "Equicord"));
        equicordInstallDirs.push(path.join(appdata, "Vencord"));
        equicordInstallDirs.push(path.join(appdata, "equicord"));
    }
    const candidates: Array<string | undefined> = [
        process.env.GOLIVE_PLUGIN_PROTON_CONFGEN,
        process.resourcesPath ? path.join(process.resourcesPath, "extra", "proton-confgen", exeName) : undefined,
        process.resourcesPath ? path.join(process.resourcesPath, "proton-confgen", exeName) : undefined,
        path.join(__dirname, "bin", "win32-x64", exeName),
        ...pluginFolders.map(folder => path.join(__dirname, folder, "bin", "win32-x64", exeName)),
        ...pluginFolders.flatMap(folder => [
            path.resolve(__dirname, "../../src/userplugins", folder, "bin/win32-x64", exeName),
            path.resolve(__dirname, "../src/userplugins", folder, "bin/win32-x64", exeName),
            path.resolve(__dirname, "../../dist/_userplugins", folder, "bin/win32-x64", exeName),
            path.resolve(__dirname, "../dist/_userplugins", folder, "bin/win32-x64", exeName),
            path.resolve(process.cwd(), folder, "bin/win32-x64", exeName),
            path.resolve(process.cwd(), "src/userplugins", folder, "bin/win32-x64", exeName),
            path.resolve(process.cwd(), "Equicord/src/userplugins", folder, "bin/win32-x64", exeName),
            path.resolve(process.cwd(), "dist/_userplugins", folder, "bin/win32-x64", exeName),
            path.resolve(process.cwd(), "Equicord/dist/_userplugins", folder, "bin/win32-x64", exeName),
            path.resolve(process.cwd(), "Equicord/dist/desktop/bin/win32-x64", exeName),
            path.resolve(process.cwd(), "Equicord/dist/equibop/bin/win32-x64", exeName),
            path.resolve(process.cwd(), "dist/desktop/bin/win32-x64", exeName),
        ]),
        ...equicordInstallDirs.flatMap(base => [
            path.join(base, "bin", "win32-x64", exeName),
            path.join(base, "proton-confgen", exeName),
            ...pluginFolders.map(folder => path.join(base, folder, "bin", "win32-x64", exeName)),
            ...pluginFolders.map(folder => path.join(base, "src/userplugins", folder, "bin/win32-x64", exeName)),
        ]),
        path.resolve(process.cwd(), "../tools/proton-confgen/build", exeName),
        path.resolve(process.cwd(), "bin/win32-x64", exeName),
        path.resolve(process.cwd(), "LefferzinBypass/bin/win32-x64", exeName),
    ];
    const filtered = candidates.filter((value): value is string => typeof value === "string" && value.length > 0);
    return [...new Set(filtered.map(value => path.resolve(value)))];
}

export function findProtonConfgenExe(): string {
    const found = candidatePaths().find(candidate => {
        try { return fs.existsSync(candidate) && fs.statSync(candidate).isFile(); } catch { return false; }
    });
    if (!found) throw new Error("O executável proton-confgen não foi encontrado no pacote do plugin.");
    return found;
}

function validProgress(value: unknown): ProtonOptimizationProgress | null {
    if (value === null || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    const phases = new Set(["ping", "preparing", "testing", "finalizing", "completed", "failed", "cancelled"]);
    if (typeof raw.phase !== "string" || !phases.has(raw.phase)) return null;
    const totalValue = Number(raw.total);
    const testedValue = Number(raw.tested);
    const succeededValue = Number(raw.succeeded);
    const total = Number.isFinite(totalValue) ? Math.max(0, Math.floor(totalValue)) : 0;
    const tested = Number.isFinite(testedValue) ? Math.max(0, Math.min(total, Math.floor(testedValue))) : 0;
    const succeeded = Number.isFinite(succeededValue) ? Math.max(0, Math.min(tested, Math.floor(succeededValue))) : 0;
    const result: ProtonOptimizationProgress = { phase: raw.phase as ProtonOptimizationProgress["phase"], total, tested, succeeded };
    if (typeof raw.server === "string" && raw.server.length <= 200) result.server = raw.server;
    for (const key of ["downloadMbps", "uploadMbps", "pingMs"] as const) {
        const numeric = Number(raw[key]);
        if (Number.isFinite(numeric) && numeric > 0) result[key] = numeric;
    }
    if (raw.status === "testing" || raw.status === "success" || raw.status === "failed") result.status = raw.status;
    return result;
}

export function parseConfgenJson(stdout: string): Record<string, unknown> | undefined {
    for (const line of stdout.trim().split(/\r?\n/).reverse()) {
        const candidate = line.trim();
        if (!candidate.startsWith("{")) continue;
        try {
            const value = JSON.parse(candidate) as unknown;
            return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
        } catch {}
    }
    return undefined;
}

export function parseConfgenJsonArray(stdout: string): Array<Record<string, unknown>> | undefined {
    for (const line of stdout.trim().split(/\r?\n/).reverse()) {
        const candidate = line.trim();
        if (!candidate.startsWith("[")) continue;
        try {
            const value = JSON.parse(candidate) as unknown;
            return Array.isArray(value) ? value as Array<Record<string, unknown>> : undefined;
        } catch {}
    }
    return undefined;
}

export interface ProtonServerEntry {
    id: string;
    name: string;
    country: string;
    city?: string;
    load?: number;
    tier?: string | number;
    pingMs?: number;
    score?: number;
    p2p?: boolean;
    secureCore?: boolean;
    free?: boolean;
}

export async function listAvailableServers(
    dataDir: string,
    options: {
        username: string;
        countries?: string;
        freeOnly?: boolean;
        p2pOnly?: boolean;
        secureCore?: boolean;
        log?: RunConfgenOptions["log"];
    },
): Promise<{ success: boolean; servers?: ProtonServerEntry[]; error?: string }> {
    if (!options.username.trim()) return { success: false, error: "Sessão Proton não encontrada." };
    ensureDataDir(dataDir);
    const args = [
        "-username", options.username.trim(),
        "-session-file", protonSessionFile(dataDir),
        "-list-servers", "-json",
    ];
    if (options.countries?.trim()) args.push("-countries", options.countries.trim());
    if (options.freeOnly !== false) args.push("-free-only");
    if (options.p2pOnly !== false) args.push("-p2p-only");
    if (options.secureCore === true) args.push("-secure-core");
    try {
        const result = await runConfgen({ args, timeoutMs: 45_000, log: options.log });
        if (result.code !== 0) return { success: false, error: safeDiagnosticDetail(result.json?.error || result.stderr || "Falha ao listar servidores Proton.") };
        const array = parseConfgenJsonArray(result.stdout);
        if (!Array.isArray(array)) return { success: false, error: safeDiagnosticDetail(result.json?.error || "A lista de servidores Proton retornou em formato inválido.") };
        const servers: ProtonServerEntry[] = [];
        for (const raw of array) {
            if (raw === null || typeof raw !== "object") continue;
            const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null;
            if (!id) continue;
            const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
            const country = typeof raw.country === "string" && raw.country.trim() ? raw.country.trim().toUpperCase().slice(0, 4) : "--";
            const entry: ProtonServerEntry = { id, name, country };
            if (typeof raw.city === "string" && raw.city.trim()) entry.city = raw.city.trim().slice(0, 120);
            if (finitePositive(raw.load)) entry.load = raw.load;
            if (typeof raw.tier === "string" || Number.isInteger(raw.tier)) entry.tier = raw.tier as string | number;
            if (finitePositive(raw.pingMs)) entry.pingMs = raw.pingMs;
            else if (finitePositive(raw.ping)) entry.pingMs = raw.ping;
            else if (finitePositive(raw.latencyMs)) entry.pingMs = raw.latencyMs;
            if (finitePositive(raw.score)) entry.score = raw.score;
            if (typeof raw.p2p === "boolean") entry.p2p = raw.p2p;
            if (typeof raw.secureCore === "boolean") entry.secureCore = raw.secureCore;
            if (typeof raw.free === "boolean") entry.free = raw.free;
            servers.push(entry);
        }
        const sortServers = (a: ProtonServerEntry, b: ProtonServerEntry) => {
            const pa = a.pingMs ?? Number.POSITIVE_INFINITY;
            const pb = b.pingMs ?? Number.POSITIVE_INFINITY;
            if (pa !== pb) return pa - pb;
            const la = a.load ?? Number.POSITIVE_INFINITY;
            const lb = b.load ?? Number.POSITIVE_INFINITY;
            if (la !== lb) return la - lb;
            return a.country.localeCompare(b.country) || a.name.localeCompare(b.name);
        };
        servers.sort(sortServers);
        return { success: true, servers };
    } catch (error) {
        options.log?.("error", "falha ao listar servidores Proton", { erro: logError(error) });
        return { success: false, error: logError(error) };
    }
}

export function runConfgen(options: RunConfgenOptions): Promise<ConfgenResult> {
    const operation = confgenQueue.then(() => runConfgenExclusive(options));
    confgenQueue = operation.catch(() => undefined);
    return operation;
}

function runConfgenExclusive(options: RunConfgenOptions): Promise<ConfgenResult> {
    return new Promise(async (resolve, reject) => {
        if (options.signal?.aborted) { reject(abortError()); return; }
        let releaseLock: (() => void) | undefined;
        try {
            releaseLock = await acquireConfgenLock();
        } catch (error) {
            reject(error);
            return;
        }
        let executable: string;
        try { executable = path.resolve(options.exePath || findProtonConfgenExe()); }
        catch (error) { releaseLock?.(); reject(error); return; }

        const timeoutMs = options.timeoutMs ?? 25_000;
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(executable, options.args, { windowsHide: true, env: { ...process.env } });
        } catch (error) {
            releaseLock?.();
            reject(error);
            return;
        }
        let stdout = "";
        let stderr = "";
        let stderrBuffer = "";
        let settled = false;
        let aborted = false;
        let terminationError: Error | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const decoder = new StringDecoder("utf8");

        const emitProgress = (chunk: string) => {
            stderrBuffer = (stderrBuffer + chunk).slice(-MAX_STDERR_BYTES);
            const lines = stderrBuffer.split(/\r?\n/);
            stderrBuffer = lines.pop() || "";
            for (const line of lines) {
                const match = /^\s*GOLIVE_PROGRESS\s+(\{.*\})\s*$/.exec(line);
                if (!match || terminationError) continue;
                try {
                    const progress = validProgress(JSON.parse(match[1]));
                    if (progress) options.onProgress?.(progress);
                } catch {}
            }
        };
        const finishReject = (error: Error) => {
            if (settled) return;
            settled = true;
            releaseLock?.();
            releaseLock = undefined;
            clearTimeout(timer);
            clearTimeout(killTimer);
            options.signal?.removeEventListener("abort", abort);
            reject(error);
        };
        const kill = (error: Error) => {
            if (settled || terminationError) return;
            terminationError = error;
            try { child.kill(); } catch {}
            killTimer = setTimeout(() => { if (!settled) { try { child.kill("SIGKILL"); } catch {} } }, 1000);
            killTimer.unref?.();
        };
        const timer = setTimeout(() => kill(new Error(`Tempo limite excedido (${Math.round(timeoutMs / 1000)}s) ao executar proton-confgen.`)), timeoutMs);
        timer.unref?.();
        const abort = () => { aborted = true; kill(abortError()); };
        options.signal?.addEventListener("abort", abort, { once: true });

        child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-MAX_STDOUT_BYTES); });
        child.stderr?.on("data", (chunk: Buffer) => {
            const text = decoder.write(chunk);
            stderr = (stderr + text).slice(-MAX_STDERR_BYTES);
            emitProgress(text);
        });
        child.once("error", error => { terminationError ??= error; });
        child.once("close", code => {
            if (settled) return;
            const tail = decoder.end();
            stderr = (stderr + tail).slice(-MAX_STDERR_BYTES);
            if (tail) emitProgress(`${tail}\n`);
            clearTimeout(timer);
            clearTimeout(killTimer);
            options.signal?.removeEventListener("abort", abort);
            if (terminationError || aborted) {
                finishReject(terminationError || abortError());
                return;
            }
            settled = true;
            releaseLock?.();
            releaseLock = undefined;
            resolve({ code, stdout, stderr, json: parseConfgenJson(stdout) });
        });
    });
}

export function classifyProtonError(error: unknown, stderr = "", stdout = ""): { code: ProtonLoginErrorCode; message: string; retryable: boolean } {
    const raw = `${error instanceof Error ? error.message : String(error)} ${stderr} ${stdout}`.toLowerCase();
    if (/captcha_invalid|captcha.*expired|human verification.*(invalid|expired)/.test(raw)) return { code: "CAPTCHA_INVALID", message: "A verificação de segurança expirou ou foi recusada.", retryable: true };
    if (/captcha_required|captcha verification required|human verification required|code 9001/.test(raw)) return { code: "CAPTCHA_REQUIRED", message: "O Proton solicitou uma verificação de segurança.", retryable: true };
    if (/2fa_required|two.?factor|required.*2fa/.test(raw)) return { code: "TWO_FACTOR_REQUIRED", message: "Esta conta exige autenticação em duas etapas.", retryable: false };
    if (/2fa|two.?factor|totp|verification code/.test(raw)) return { code: "TWO_FACTOR_INVALID", message: "O código 2FA está incorreto ou expirou.", retryable: false };
    if (/invalid credential|invalid password|wrong password|authentication failed|incorrect/.test(raw)) return { code: "INVALID_CREDENTIALS", message: "Usuário ou senha incorretos.", retryable: false };
    if (/timeout|tempo limite|timed out/.test(raw)) return { code: "TIMEOUT", message: "O ProtonVPN demorou demais para responder.", retryable: true };
    if (/not found|enoent|spawn|não foi encontrado/.test(raw)) return { code: "MISSING_EXECUTABLE", message: "O componente ProtonVPN não foi encontrado nesta instalação.", retryable: false };
    if (/network|connection|dns|tls|temporary|unreachable|reset/.test(raw)) return { code: "NETWORK_ERROR", message: "Não foi possível conectar aos servidores ProtonVPN.", retryable: true };
    return { code: "UNKNOWN", message: "Não foi possível concluir a operação ProtonVPN.", retryable: true };
}

export function protonSessionFile(dataDir: string): string {
    return path.join(dataDir, "proton-session.json");
}

export function savedSessionUsername(dataDir: string): string {
    try {
        const value = JSON.parse(fs.readFileSync(protonSessionFile(dataDir), "utf8")) as { username?: unknown };
        return typeof value.username === "string" ? value.username.trim() : "";
    } catch { return ""; }
}

export function parseCaptchaUrl(rawUrl: string): { url: string; challenge: string; origin: string } | null {
    try {
        const parsed = new URL(rawUrl);
        const challenge = parsed.searchParams.get("Token")?.trim() || "";
        const host = parsed.hostname.toLowerCase();
        if (parsed.protocol !== "https:" || !(host === "proton.me" || host.endsWith(".proton.me"))) return null;
        if (parsed.pathname !== "/core/v4/captcha" || challenge.length < 3 || challenge.length > 4096) return null;
        parsed.hash = "";
        return { url: parsed.toString(), challenge, origin: parsed.origin };
    } catch { return null; }
}

export function validateCaptchaResponse(value: unknown, challenge: string): value is string {
    if (typeof value !== "string") return false;
    const token = value.trim();
    if (token.length < 3 || token.length > 16_384 || !challenge || challenge.length > 4096) return false;
    return token.startsWith(`${challenge}:`) && token.length > challenge.length + 1 && !/[\r\n]/.test(token);
}

function ensureDataDir(dataDir: string): void {
    fs.mkdirSync(dataDir, { recursive: true });
}

export async function checkProtonSession(dataDir: string, username: string): Promise<{ valid: boolean; username?: string; expiresIn?: string; error?: string }> {
    if (!username.trim()) return { valid: false, error: "Usuário Proton não especificado." };
    ensureDataDir(dataDir);
    const result = await runConfgen({ args: ["-username", username.trim(), "-session-file", protonSessionFile(dataDir), "-check-session", "-json"] });
    if (result.json?.valid === true) return { valid: true, username: typeof result.json.username === "string" ? result.json.username : username.trim(), expiresIn: typeof result.json.expiresIn === "string" ? result.json.expiresIn : undefined };
    return { valid: false, error: safeDiagnosticDetail(result.json?.error || result.stderr || "Sessão Proton inválida ou não encontrada.") };
}

export function normalizeProtonPlan(value: unknown): ProtonPlanResult {
    if (value === null || typeof value !== "object") return { success: false, status: "unknown", error: GENERIC_PLAN_ERROR };
    const raw = value as Record<string, unknown>;
    if (raw.success !== true || !Number.isInteger(raw.maxTier) || Number(raw.maxTier) < 0) return { success: false, status: "unknown", error: GENERIC_PLAN_ERROR };
    const result: ProtonPlanResult = { success: true, status: Number(raw.maxTier) === 0 ? "free" : "premium", maxTier: Number(raw.maxTier), checkedAt: new Date().toISOString() };
    for (const key of ["planName", "planTitle"] as const) if (typeof raw[key] === "string" && raw[key].trim()) result[key] = raw[key].trim().slice(0, 120);
    return result;
}

export async function getProtonPlan(dataDir: string, username: string, log?: RunConfgenOptions["log"]): Promise<ProtonPlanResult> {
    if (!username.trim()) return { success: false, status: "unknown", error: "Sessão Proton não encontrada." };
    ensureDataDir(dataDir);
    try {
        const result = await runConfgen({ args: ["-username", username.trim(), "-session-file", protonSessionFile(dataDir), "-check-plan", "-json"], timeoutMs: 10_000, log });
        return result.code === 0 ? normalizeProtonPlan(result.json) : { success: false, status: "unknown", error: GENERIC_PLAN_ERROR };
    } catch (error) {
        log?.("warn", "falha ao consultar plano Proton", { erro: logError(error) });
        return { success: false, status: "unknown", error: GENERIC_PLAN_ERROR };
    }
}

export async function loginProton(
    dataDir: string,
    username: string,
    password?: string,
    twoFactorCode?: string,
    humanVerificationToken?: string,
    log?: RunConfgenOptions["log"],
): Promise<ProtonLoginResult> {
    if (!username.trim()) return { success: false, code: "CONFIGURATION_ERROR", message: "Informe o usuário Proton.", retryable: false };
    ensureDataDir(dataDir);
    const args = ["-username", username.trim(), "-session-file", protonSessionFile(dataDir), "-login-only", "-json"];
    if (password) args.push("-password", password);
    if (twoFactorCode) args.push("-2fa", twoFactorCode);
    if (humanVerificationToken) args.push("-hv-token", humanVerificationToken);
    try {
        const result = await runConfgen({ args, timeoutMs: 25_000, log });
        if (result.json?.success === true) return { success: true, username: typeof result.json.username === "string" ? result.json.username.trim() : username.trim(), message: "Autenticação Proton concluída." };
        const code = result.json?.code;
        if (code === "CAPTCHA_REQUIRED" || code === "CAPTCHA_INVALID") {
            return { success: false, code, message: typeof result.json?.error === "string" ? result.json.error : "O Proton solicitou uma verificação de segurança.", retryable: result.json?.retryable !== false, captchaUrl: typeof result.json?.captchaUrl === "string" ? parseCaptchaUrl(result.json.captchaUrl)?.url : undefined };
        }
        const classified = classifyProtonError(result.json?.error || result.stderr || result.stdout);
        return { success: false, ...classified, error: classified.message };
    } catch (error) {
        const classified = classifyProtonError(error);
        log?.("error", "falha ao executar login Proton", { codigo: classified.code, erro: logError(error) });
        return { success: false, ...classified, error: classified.message };
    }
}

function finitePositive(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export async function generateOptimalProtonConfig(
    dataDir: string,
    options: {
        username: string;
        country?: string;
        serverId?: string;
        freeOnly?: boolean;
        autoPing?: boolean;
        speedTest?: boolean;
        signal?: AbortSignal;
        onProgress?: (progress: ProtonOptimizationProgress) => void;
        log?: RunConfgenOptions["log"];
    },
): Promise<ProtonOptimizationResult> {
    if (!options.username.trim()) return { success: false, error: "Sessão Proton não encontrada." };
    ensureDataDir(dataDir);
    const output = path.join(dataDir, "wireguard.conf");
    const staging = path.join(dataDir, `.wireguard.conf.${randomUUID()}.tmp`);
    let selectedServer = options.serverId?.trim() || "";
    if (selectedServer) try {
        const available = await listAvailableServers(dataDir, {
            username: options.username,
            countries: options.country,
            freeOnly: options.freeOnly,
            p2pOnly: true,
            log: options.log,
        });
        if (!available.success || !Array.isArray(available.servers)) {
            return { success: false, error: available.error || "Não foi possível consultar as rotas Proton." };
        }
        const eligible = available.servers;
        if (selectedServer) {
            const selected = eligible.find(server =>
                server.id.toLowerCase() === selectedServer.toLowerCase()
                || server.name.toLowerCase() === selectedServer.toLowerCase()
            );
            if (!selected) {
                return { success: false, error: "A rota selecionada não está disponível na lista atual de servidores Proton." };
            }
            selectedServer = selected.name;
        }
    } catch (error) {
        return { success: false, error: `Não foi possível filtrar as rotas Proton: ${logError(error)}` };
    }
    const args = ["-username", options.username.trim(), "-session-file", protonSessionFile(dataDir), "-output", staging, "-json", "-ipv6", "-exclude-countries", "BR"];
    if (options.autoPing !== false) args.push("-auto-ping");
    if (options.speedTest) args.push("-speed-test", "-progress-json");
    if (options.freeOnly !== false) args.push("-free-only");
    if (options.country?.trim()) args.push("-countries", options.country.trim());
    if (selectedServer) args.push("-server", selectedServer);

    try {
        const result = options.speedTest
            ? await runIsolatedSpeedSelection(args, options.signal, options.onProgress, options.log)
            : await runConfgen({ args, timeoutMs: 60_000, signal: options.signal, onProgress: options.onProgress, log: options.log });
        const measured = !options.speedTest || (finitePositive(result.json?.downloadMbps) && finitePositive(result.json?.uploadMbps));
        if (result.code === 0 && result.json?.success === true && measured && fs.existsSync(staging)) {
            if (options.signal?.aborted) throw abortError();
            fs.renameSync(staging, output);
            return {
                success: true,
                server: typeof result.json.server === "string" ? result.json.server : undefined,
                country: typeof result.json.country === "string" ? result.json.country : undefined,
                city: typeof result.json.city === "string" ? result.json.city : undefined,
                tier: typeof result.json.tier === "string" ? result.json.tier : undefined,
                load: finitePositive(result.json.load) ? result.json.load : undefined,
                score: finitePositive(result.json.score) ? result.json.score : undefined,
                pingMs: finitePositive(result.json.pingMs) ? result.json.pingMs : undefined,
                downloadMbps: finitePositive(result.json.downloadMbps) ? result.json.downloadMbps : undefined,
                uploadMbps: finitePositive(result.json.uploadMbps) ? result.json.uploadMbps : undefined,
                speedTested: Number.isInteger(result.json.speedTested) ? Number(result.json.speedTested) : undefined,
                speedSucceeded: Number.isInteger(result.json.speedSucceeded) ? Number(result.json.speedSucceeded) : undefined,
                endpoint: typeof result.json.endpoint === "string" ? result.json.endpoint : undefined,
                confFile: output,
            };
        }
        return { success: false, error: safeDiagnosticDetail(result.json?.error || result.stderr || "Falha ao gerar a configuração Proton.") };
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        options.log?.("error", "falha ao gerar configuração Proton", { erro: logError(error) });
        return { success: false, error: logError(error) };
    } finally {
        try { fs.rmSync(staging, { force: true }); } catch {}
    }
}

export async function runIsolatedSpeedSelection(
    args: string[],
    signal?: AbortSignal,
    onProgress?: (progress: ProtonOptimizationProgress) => void,
    log?: RunConfgenOptions["log"],
): Promise<ConfgenResult> {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "golive-plugin-speed-"));
    const executable = path.join(tempDir, process.platform === "win32" ? "golive-speed-probe.exe" : "golive-speed-probe");
    try {
        fs.copyFileSync(findProtonConfgenExe(), executable);
        if (process.platform !== "win32") fs.chmodSync(executable, 0o700);
        return await runConfgen({ args, exePath: executable, timeoutMs: 210_000, signal, onProgress, log });
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 }).catch(() => {});
    }
}

export function removeProtonSession(dataDir: string): boolean {
    try {
        fs.rmSync(protonSessionFile(dataDir), { force: true });
        return true;
    } catch { return false; }
}
