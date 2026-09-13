import fs from "fs";
import path from "path";
import { app } from "electron";

import * as proton from "./vpn-proton";
import * as windows from "./vpn-windows";
import {
    VPN_OWNER_KIND,
    VPN_SCHEMA_VERSION,
    isSupportedWindowsArchitecture,
    normalizeVpnSettings,
    safeDiagnosticDetail,
    type VpnDiagnostic,
    type VpnOwnerRecord,
    type VpnSettings,
    type VpnState,
    type VpnStatus,
    type VpnOperationResult,
} from "./vpn-types";

export type ControllerLog = windows.WireSockLogger;

export interface PluginVpnControllerOptions {
    dataDir: string;
    guiDataDir: string;
    readSettings: () => unknown;
    isEnabled: () => boolean;
    log: ControllerLog;
}

export interface ProtonLoginPayload {
    username: string;
    password?: string;
    twoFactorCode?: string;
}

export interface ProtonOptimizationOptions {
    country?: string;
    serverId?: string;
    freeOnly?: boolean;
    autoPing?: boolean;
    speedTest?: boolean;
    relaunch?: boolean;
    requestId?: string;
    onProgress?: (progress: proton.ProtonOptimizationProgress & { requestId: string }) => void;
}

const OWNER_FILE = "owner.lock";
const MIGRATION_FILE = "migration-v1.json";
const PROFILE_FILE = "wireguard.conf";
const SERVICE_CONFIG_FILE = "wiresock-discord.conf";
const WATCHDOG_MS = 15_000;
const AUTO_ROUTE_LOAD_LIMIT = 70;
const AUTO_ROUTE_PING_CANDIDATES = 20;

function errorMessage(error: unknown): string {
    return safeDiagnosticDetail(error, 600);
}

function isWindows(): boolean {
    return process.platform === "win32";
}

function processAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as { code?: unknown })?.code === "EPERM";
    }
}

function normalizeUsername(value: string): string {
    return value.trim().slice(0, 320);
}

export class PluginVpnController {
    private readonly options: PluginVpnControllerOptions;
    private readonly dataDir: string;
    private readonly profilePath: string;
    private readonly serviceConfigPath: string;
    private readonly ownerPath: string;
    private state: VpnState = "inactive";
    private generation = 0;
    private discordPid: number | null = null;
    private probePath: string | undefined;
    private lastDiagnostic: VpnDiagnostic | null = null;
    private externalReason: string | null = null;
    private operationQueue: Promise<unknown> = Promise.resolve();
    private watchdog: ReturnType<typeof setInterval> | null = null;
    private restarting = false;
    private initialized = false;
    private optimization: { id: string; controller: AbortController } | null = null;
    private routeId: string | null = null;
    private routeCountry: string | null = null;
    private routeCity: string | null = null;
    private routeLabel: string | null = null;
    private pingMs: number | null = null;

    public constructor(options: PluginVpnControllerOptions) {
        this.options = options;
        this.dataDir = path.resolve(options.dataDir);
        this.profilePath = path.join(this.dataDir, PROFILE_FILE);
        this.serviceConfigPath = path.join(this.dataDir, SERVICE_CONFIG_FILE);
        this.ownerPath = path.join(this.dataDir, OWNER_FILE);
    }

    public get paths() {
        return { dataDir: this.dataDir, profilePath: this.profilePath, serviceConfigPath: this.serviceConfigPath, ownerPath: this.ownerPath };
    }

    public isRelaunching(): boolean {
        return this.restarting;
    }

    public hasCleanupWork(): boolean {
        const inspection = windows.inspectWireSock(this.serviceConfigPath);
        if (inspection.active) return inspection.owned;
        if (this.state === "blocked_external") return false;
        if (this.state === "inactive") return this.readOwner() !== null;
        return true;
    }

    public async initialize(): Promise<void> {
        if (this.initialized || !isWindows()) return;
        this.initialized = true;
        try {
            await this.migrateGuiState();
            this.restoreRouteSnapshot();
            if (this.pingMs === null) {
                try {
                    const markerPath = path.join(this.dataDir, "optimization-marker.json");
                    if (fs.existsSync(markerPath)) {
                        const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<string, unknown>;
                        const mping = marker.pingMs ?? marker.ping ?? marker.latencyMs;
                        if (typeof mping === "number" && Number.isFinite(mping) && mping > 0) this.pingMs = mping;
                        const mcountry = marker.country;
                        const mcity = marker.city;
                        const mserver = marker.server ?? marker.serverId ?? marker.routeId;
                        if (typeof mcountry === "string" && mcountry.trim() && !this.routeCountry) this.routeCountry = mcountry.trim().slice(0, 4).toUpperCase();
                        if (typeof mcity === "string" && mcity.trim() && !this.routeCity) this.routeCity = mcity.trim().slice(0, 120);
                        if (typeof mserver === "string" && mserver.trim() && !this.routeId) this.routeId = mserver.trim().slice(0, 160);
                    }
                } catch { /* marker opcional */ }
            }
            const endpoint = this.readEndpointFromProfile();
            if (endpoint && endpoint.country && !this.routeCountry) this.routeCountry = endpoint.country;
            if (endpoint?.hostname && !this.routeId) this.routeId = endpoint.hostname.slice(0, 160);
            if (!this.routeLabel) this.routeLabel = this.buildRouteLabel();
            const owner = this.readOwner();
            const inspection = windows.inspectWireSock(this.serviceConfigPath);
            if (!inspection.active) {
                if (inspection.foreignRegisteredServices.length > 0) {
                    this.blockExternal(inspection.reason || "Um serviço WireSock externo está registrado.");
                    return;
                }
                if (owner) this.releaseOwnership(owner);
                this.state = "inactive";
                return;
            }
            if (!inspection.owned) {
                this.blockExternal(inspection.reason || "WireSock externo já está ativo.");
                return;
            }
            if (owner && owner.pid !== process.pid && processAlive(owner.pid) && !owner.restarting) {
                this.blockExternal("Outra instância do LefferzinBypass já controla esta sessão WireSock.");
                return;
            }
            if (!this.options.isEnabled()) {
                this.options.log("warn", "WireSock próprio encontrado com o plugin desativado; restaurando a rede");
                await this.stopInternal(false);
                return;
            }
            this.generation = Math.max(this.generation, owner?.generation ?? 0);
            this.adoptOwnership(owner, inspection);
            this.state = "active";
            this.discordPid = process.pid;
            this.startWatchdog();
            this.startDiagnostics("adoption");
            this.options.log("info", "sessão WireSock própria adotada após inicialização", { generation: this.generation });
        } catch (error) {
                this.state = "recovery_required";
                this.setDiagnostic("ownership", false, errorMessage(error));
            this.options.log("error", "falha ao recuperar sessão VPN no boot", { erro: errorMessage(error) });
        }
    }

    public getStatus(): VpnStatus {
        if (!isSupportedWindowsArchitecture(process.platform, process.arch)) {
            return {
                state: "blocked_external",
                platform: "unsupported",
                architecture: process.arch,
                owned: false,
                active: false,
                generation: this.generation,
                discordPid: null,
                profilePath: null,
                configPath: null,
                externalReason: "A VPN do plugin nesta versão está disponível somente no Windows x64.",
                lastDiagnostic: this.lastDiagnostic,
                message: "Windows x64 necessário",
                routeId: null,
                routeCountry: null,
                routeCity: null,
                routeLabel: null,
                pingMs: null,
            };
        }
        const inspection = windows.inspectWireSock(this.serviceConfigPath);
        if (this.state === "active" && (!inspection.active || !inspection.owned)) {
            this.state = inspection.active || inspection.foreignRegisteredServices.length > 0 ? "blocked_external" : "recovery_required";
            this.externalReason = inspection.reason;
            this.stopWatchdog();
        }
        const active = this.state === "active" && inspection.active && inspection.owned;
        if (!active && this.state !== "active") {
            this.pingMs = null;
        }
        return {
            state: this.state,
            platform: "windows",
            architecture: process.arch,
            owned: inspection.owned && (active || this.readOwner() !== null),
            active,
            generation: this.generation,
            discordPid: this.discordPid,
            profilePath: fs.existsSync(this.profilePath) ? this.profilePath : null,
            configPath: fs.existsSync(this.serviceConfigPath) ? this.serviceConfigPath : null,
            externalReason: this.externalReason,
            lastDiagnostic: this.lastDiagnostic,
            message: this.statusMessage(),
            routeId: this.routeId,
            routeCountry: this.routeCountry,
            routeCity: this.routeCity,
            routeLabel: this.routeLabel ?? this.buildRouteLabel(),
            pingMs: this.pingMs,
        };
    }

    public enable(relaunch = true): Promise<VpnOperationResult> {
        return this.serial(async () => {
            const first = await this.startInternal(relaunch);
            if (first.success) return first;
            // Retry automático para racings de primeiro-login / sessão recém criada
            // ou serviço do WireSock que demora para aparecer no SCM/WMI.
            // Só tenta de novo se não for um conflito explícito de coisa externa.
            const retryless = first.state === "blocked_external" || /exter|outro perfil|GUI|plugin/i.test(first.error || "");
            if (retryless) return first;
            this.options.log("warn", "primeira tentativa de enable falhou; aguardando 1s e tentando novamente", { estado: first.state, erro: first.error });
            await new Promise<void>(r => setTimeout(r, 1000));
            const second = await this.startInternal(relaunch);
            if (second.success) return second;
            // Se a segunda também falhou mas pelo menos o serviço está ativo sem
            // conflito explícito, retorna sucesso por exclusão também no nível do controller.
            const inspection = windows.inspectWireSock(this.serviceConfigPath);
            if (inspection.active && !inspection.owned) {
                const hasConflict = inspection.foreignRegisteredServices.length > 0
                    || inspection.reason?.includes("externo")
                    || inspection.reason?.includes("outro perfil");
                if (!hasConflict) {
                    const owner = this.readOwner();
                    if (this.state !== "active") {
                        this.generation = Math.max(this.generation, owner?.generation ?? 0);
                        this.adoptOwnership(owner, inspection);
                        this.state = "active";
                        this.discordPid = process.pid;
                        this.startWatchdog();
                        this.startDiagnostics("retry-adoption");
                    }
                    this.options.log("warn", "segunda tentativa falhou mas WireSock está ativo sem conflito; assumindo sucesso por exclusão", { serviços: inspection.services });
                    return { success: true, state: "active", message: this.statusMessage() };
                }
            }
            return second;
        });
    }

    public shutdown(relaunch = true, forceNuclear = false): Promise<VpnOperationResult> {
        return this.serial(() => this.stopInternal(relaunch, forceNuclear));
    }

    /**
     * Limpeza global destrutiva. Só deve ser chamada por uma ação explícita de
     * recuperação; encerramento normal e logout usam shutdown(false, false).
     */
    public wipeEverything(): Promise<{ stopped: boolean; servicesDeletedCount: number }> {
        return this.serial(async () => {
            this.stopWatchdog();
            try {
                this.externalReason = null;
                this.state = "stopping";
                this.options.log("info", "wipeEverything: limpeza forcada total do WireSock acionada");
                const result = windows.wipeWireSockHard(this.options.log);
                this.discordPid = null;
                this.pingMs = null;
                this.routeId = null;
                this.routeCountry = null;
                this.routeCity = null;
                this.routeLabel = null;
                this.removeProbe();
                const owner = this.readOwner();
                if (owner) this.releaseOwnership(owner);
                this.state = result.stopped ? "inactive" : "recovery_required";
                this.setDiagnostic("wireguard", result.stopped, `wipe: parado=${result.stopped} | servicos_deletados=${result.servicesDeletedCount}/2`);
                return result;
            } catch (error) {
                this.state = "recovery_required";
                this.setDiagnostic("wireguard", false, errorMessage(error));
                this.options.log("error", "wipeEverything: excecao", { erro: errorMessage(error) });
                return { stopped: false, servicesDeletedCount: 0 };
            }
        });
    }

    public restoreNetwork(): Promise<VpnOperationResult> {
        return this.serial(() => this.stopInternal(false, false));
    }

    /**
     * Recuperação manual para instalações em que o WireSock ficou registrado
     * por uma GUI/versão anterior. Preserva o perfil Proton e recria somente o
     * serviço/processo WireSock usado pelo plugin.
     */
    public recoverAndStart(): Promise<VpnOperationResult> {
        return this.serial(async () => {
            if (!isSupportedWindowsArchitecture(process.platform, process.arch)) {
                return { success: false, state: "blocked_external", error: "A VPN do plugin nesta versão exige Windows x64." };
            }
            this.stopWatchdog();
            const inspection = windows.inspectWireSock(this.serviceConfigPath);
            if (inspection.active && !inspection.owned) {
                this.blockExternal(inspection.reason || "WireSock externo está ativo.");
                return { success: false, state: this.state, error: this.externalReason || undefined };
            }
            if (inspection.foreignRegisteredServices.length > 0) {
                this.blockExternal(inspection.reason || "Um serviço WireSock externo está registrado.");
                return { success: false, state: this.state, error: this.externalReason || undefined };
            }
            this.options.log("warn", "recuperação manual: parando somente o WireSock pertencente ao plugin");
            const cleanup = await windows.stopOwnedWireSock(this.serviceConfigPath, this.options.log);
            this.removeProbe();
            const owner = this.readOwner();
            if (owner) this.releaseOwnership(owner);
            this.discordPid = null;
            this.state = "inactive";
            this.externalReason = null;
            if (!cleanup.stopped) {
                this.state = "recovery_required";
                return { success: false, state: this.state, error: cleanup.error || "Não foi possível limpar o WireSock." };
            }
            return this.startInternal(false);
        });
    }

    public async importCustomConfig(sourcePath: string): Promise<{ success: boolean; error?: string; path?: string }> {
        try {
            if (!isWindows()) throw new Error("A VPN do plugin nesta versão exige Windows x64.");
            const source = path.resolve(sourcePath.trim());
            if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("Arquivo WireGuard não encontrado.");
            const raw = fs.readFileSync(source, "utf8");
            const validation = windows.validateWireGuardProfile(raw);
            if (!validation.valid) throw new Error(validation.error);
            this.writeProfileAtomically(raw);
            return { success: true, path: this.profilePath };
        } catch (error) {
            return { success: false, error: errorMessage(error) };
        }
    }

    public testConfig(sourcePath?: string): { success: boolean; error?: string; path?: string } {
        try {
            const target = sourcePath?.trim() ? path.resolve(sourcePath.trim()) : this.profilePath;
            if (!fs.existsSync(target)) throw new Error("Nenhuma configuração WireGuard foi encontrada.");
            const validation = windows.validateWireGuardProfile(fs.readFileSync(target, "utf8"));
            if (!validation.valid) throw new Error(validation.error);
            return { success: true, path: target };
        } catch (error) {
            return { success: false, error: errorMessage(error) };
        }
    }

    public loginProton(payload: ProtonLoginPayload, solveCaptcha: (url: string) => Promise<string | null>): Promise<proton.ProtonLoginResult> {
        // O CAPTCHA também fica dentro da fila, impedindo outro login até a
        // tentativa atual terminar ou ser cancelada.
        return this.serial(async () => {
            const username = normalizeUsername(payload.username);
            let result = await proton.loginProton(this.dataDir, username, payload.password, payload.twoFactorCode, undefined, this.options.log);
            for (let attempt = 0; attempt < 3 && (result.code === "CAPTCHA_REQUIRED" || result.code === "CAPTCHA_INVALID"); attempt++) {
                if (!result.captchaUrl) break;
                const token = await solveCaptcha(result.captchaUrl);
                if (!token) return { success: false, code: "CAPTCHA_CANCELLED", message: "A verificação Proton foi cancelada.", retryable: true };
                result = await proton.loginProton(this.dataDir, username, payload.password, payload.twoFactorCode, token, this.options.log);
            }
            return result;
        });
    }

    public checkProtonSession(username: string) {
        return proton.checkProtonSession(this.dataDir, normalizeUsername(username));
    }

    public getProtonPlan(username: string) {
        return proton.getProtonPlan(this.dataDir, normalizeUsername(username), this.options.log);
    }

    public logoutProton(): boolean {
        const removedSession = proton.removeProtonSession(this.dataDir);
        try {
            if (fs.existsSync(this.profilePath)) fs.rmSync(this.profilePath, { force: true, maxRetries: 10 });
        } catch { /* ignora */ }
        try {
            const clientConf = path.join(this.dataDir, "wireguard-client.conf");
            if (fs.existsSync(clientConf)) fs.rmSync(clientConf, { force: true, maxRetries: 10 });
        } catch { /* ignora */ }
        try {
            const optimized = path.join(this.dataDir, "optimized-profile.conf");
            if (fs.existsSync(optimized)) fs.rmSync(optimized, { force: true, maxRetries: 10 });
        } catch { /* ignora */ }
        try {
            const marker = path.join(this.dataDir, "optimization-marker.json");
            if (fs.existsSync(marker)) fs.rmSync(marker, { force: true, maxRetries: 10 });
        } catch { /* ignora */ }
        try {
            const activation = path.join(this.dataDir, "activation-state.json");
            if (fs.existsSync(activation)) fs.rmSync(activation, { force: true, maxRetries: 10 });
        } catch { /* ignora */ }
        try {
            const snapshot = this.routeSnapshotPath();
            if (fs.existsSync(snapshot)) fs.rmSync(snapshot, { force: true, maxRetries: 10 });
        } catch { /* ignora */ }
        this.routeId = null;
        this.routeCountry = null;
        this.routeCity = null;
        this.routeLabel = null;
        this.pingMs = null;
        const residualFiles = [
            proton.protonSessionFile(this.dataDir),
            this.profilePath,
            path.join(this.dataDir, "wireguard-client.conf"),
            path.join(this.dataDir, "optimized-profile.conf"),
            path.join(this.dataDir, "optimization-marker.json"),
            path.join(this.dataDir, "activation-state.json"),
            this.routeSnapshotPath(),
        ].filter(file => fs.existsSync(file));
        if (residualFiles.length > 0)
            this.options.log("warn", "logout Proton deixou arquivos residuais", { arquivos: residualFiles });
        return removedSession && residualFiles.length === 0;
    }

    public async optimizeProton(options: ProtonOptimizationOptions): Promise<proton.ProtonOptimizationResult & { cancelled?: boolean; deferred?: boolean }> {
        return this.serial(async () => {
            if (!isWindows() || process.arch !== "x64") return { success: false, error: "A VPN do plugin nesta versão exige Windows x64." };
            const settings = this.settings();
            const username = normalizeUsername(settings.protonUsername);
            if (!username) return { success: false, error: "Faça login com sua conta Proton antes de otimizar a rota." };
            if (this.optimization) return { success: false, error: "Já existe uma otimização Proton em andamento." };

            const wasActive = this.getStatus().active;
            if (this.state === "blocked_external") return { success: false, error: this.externalReason || "WireSock externo está ativo." };
            if (wasActive) {
                const stopped = await this.stopInternal(false);
                if (!stopped.success) return { success: false, error: stopped.error || "Não foi possível pausar a VPN para otimizar a rota." };
            }

            const restorePreviousRoute = async (): Promise<string | null> => {
                if (!wasActive) return null;
                    const restored = await this.startInternal(options.relaunch !== false);
                return restored.success ? null : restored.error || "Não foi possível reativar a rota WireGuard anterior.";
            };

            const id = options.requestId || `proton-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const controller = new AbortController();
            this.optimization = { id, controller };
            try {
                let result: proton.ProtonOptimizationResult;
                try {
                    result = await proton.generateOptimalProtonConfig(this.dataDir, {
                        username,
                        country: options.country ?? settings.protonCountry,
                        serverId: options.serverId,
                        freeOnly: options.freeOnly ?? settings.protonFreeOnly,
                        autoPing: options.autoPing ?? settings.protonAutoPing,
                        speedTest: options.speedTest === true,
                        signal: controller.signal,
                        onProgress: progress => options.onProgress?.({ ...progress, requestId: id }),
                        log: this.options.log,
                    });
                } catch (error) {
                    const restoreError = await restorePreviousRoute();
                    if (restoreError) this.options.log("error", "otimização falhou e a rota anterior não voltou", { erro: restoreError });
                    throw error;
                }
                if (controller.signal.aborted) {
                    const restoreError = await restorePreviousRoute();
                    return { success: false, cancelled: true, error: restoreError || "Otimização Proton cancelada." };
                }
                if (result.success && wasActive) {
                    const restartError = await restorePreviousRoute();
                    if (restartError) return { ...result, success: false, error: restartError };
                } else if (!result.success && wasActive) {
                    const restoreError = await restorePreviousRoute();
                    if (restoreError) return { ...result, error: `${result.error || "A otimização falhou."} ${restoreError}` };
                }
                this.applyProtonResult(result);
                return result;
            } finally {
                this.optimization = null;
            }
        });
    }

    public cancelOptimization(requestId: string): boolean {
        if (!this.optimization || this.optimization.id !== requestId) return false;
        this.optimization.controller.abort();
        return true;
    }

    public listAvailableRoutes(countries?: string[]): Promise<{ success: boolean; servers?: proton.ProtonServerEntry[]; error?: string }> {
        const settings = this.settings();
        const username = normalizeUsername(settings.protonUsername);
        const countriesArg = Array.isArray(countries) && countries.length > 0
            ? countries.map(c => String(c).trim().toUpperCase()).filter(Boolean).join(",")
            : undefined;
        return proton.listAvailableServers(this.dataDir, {
            username,
            countries: countriesArg,
            freeOnly: settings.protonFreeOnly,
            p2pOnly: true,
            log: this.options.log,
        });
    }

    public applySelectedRoute(options: { country?: string; serverId?: string }): Promise<proton.ProtonOptimizationResult & { cancelled?: boolean; deferred?: boolean }> {
        return this.optimizeProton({
            country: options.country,
            serverId: options.serverId,
            autoPing: true,
            speedTest: false,
        });
    }

    public autoOptimizeRoute(): Promise<proton.ProtonOptimizationResult & { checked?: boolean; changed?: boolean; currentLoad?: number; selectedServer?: string; pingCandidates?: number }> {
        return (async () => {
            const status = this.getStatus();
            if (!status.active) return { success: false, checked: false, changed: false, error: "VPN inativa." };
            const settings = this.settings();
            const currentId = this.routeId?.toLowerCase() || this.readEndpointFromProfile()?.hostname.toLowerCase();
            const listed = await proton.listAvailableServers(this.dataDir, {
                username: normalizeUsername(settings.protonUsername),
                countries: undefined,
                freeOnly: settings.protonFreeOnly,
                p2pOnly: true,
                log: this.options.log,
            });
            if (!listed.success || !listed.servers) return { success: false, checked: false, changed: false, error: listed.error || "Não foi possível consultar as rotas." };
            const current = listed.servers.find(server => {
                const id = server.id.toLowerCase();
                const name = server.name.toLowerCase();
                return Boolean(currentId && (id === currentId || name === currentId || id.includes(currentId) || currentId.includes(id)));
            });
            const currentLoad = current?.load;
            if (typeof currentLoad !== "number" || currentLoad <= AUTO_ROUTE_LOAD_LIMIT)
                return { success: true, checked: true, changed: false, currentLoad, server: current?.name, load: currentLoad, pingMs: current?.pingMs };
            // Primeiro consultamos a lista inteira. Só as 20 rotas com menor
            // carga passam para a etapa de comparação de latência, evitando
            // testar dezenas de servidores desnecessariamente.
            const pingCandidates = listed.servers
                .filter(server => server.id !== current?.id && typeof server.load === "number" && server.load <= AUTO_ROUTE_LOAD_LIMIT)
                .sort((a, b) => (a.load ?? 100) - (b.load ?? 100) || a.country.localeCompare(b.country) || a.name.localeCompare(b.name))
                .slice(0, AUTO_ROUTE_PING_CANDIDATES);
            const selected = pingCandidates
                .sort((a, b) => (a.pingMs ?? Number.POSITIVE_INFINITY) - (b.pingMs ?? Number.POSITIVE_INFINITY) || (a.load ?? 100) - (b.load ?? 100))[0];
            if (!selected) return { success: false, checked: true, changed: false, currentLoad, pingCandidates: 0, error: `Todas as rotas disponíveis estão acima de ${AUTO_ROUTE_LOAD_LIMIT}% ou sem dados suficientes.` };
            const result = await this.optimizeProton({ serverId: selected.id, autoPing: true, speedTest: false, relaunch: false });
            return { ...result, checked: true, changed: result.success === true, currentLoad, selectedServer: selected.name, pingCandidates: pingCandidates.length };
        })();
    }

    private settings(): VpnSettings {
        const raw = this.options.readSettings();
        const settings = normalizeVpnSettings(raw);
        if (!settings.protonUsername) settings.protonUsername = proton.savedSessionUsername(this.dataDir);
        return settings;
    }

    private serial<T>(operation: () => Promise<T>): Promise<T> {
        const current = this.operationQueue.catch(() => {}).then(operation);
        this.operationQueue = current.catch(() => {});
        return current;
    }

    private buildRouteLabel(): string | null {
        const parts: string[] = [];
        if (this.routeCountry) parts.push(this.routeCountry.toUpperCase());
        if (this.routeCity) parts.push(this.routeCity);
        if (parts.length === 0 && this.routeId) parts.push(this.routeId);
        return parts.length === 0 ? null : parts.join(" - ");
    }

    private applyProtonResult(result: { success: boolean; server?: unknown; country?: unknown; city?: unknown; pingMs?: unknown }): void {
        if (!result.success) return;
        if (typeof result.server === "string" && result.server.trim()) this.routeId = result.server.trim().slice(0, 160);
        if (typeof result.country === "string" && result.country.trim()) this.routeCountry = result.country.trim().slice(0, 4).toUpperCase();
        if (typeof result.city === "string" && result.city.trim()) this.routeCity = result.city.trim().slice(0, 120);
        if (typeof result.pingMs === "number" && Number.isFinite(result.pingMs) && result.pingMs > 0) this.pingMs = result.pingMs;
        this.routeLabel = this.buildRouteLabel();
        this.persistRouteSnapshot();
    }

    private async ensurePingFromExistingProfile(): Promise<void> {
        if (this.pingMs !== null && Number.isFinite(this.pingMs) && this.pingMs > 0) return;
        if (!fs.existsSync(this.profilePath)) return;
        try {
            const raw = fs.readFileSync(this.profilePath, "utf8");
            const endpoint = windows.extractEndpointFromWireGuardConfig(raw);
            if (!endpoint?.host) return;
            const sample = await Promise.all([
                windows.pingEndpoint(endpoint.host, endpoint.port, 2000),
                windows.pingEndpoint(endpoint.host, endpoint.port, 2000),
            ]);
            const valids = sample.filter((r): r is { pingMs: number } => typeof r?.pingMs === "number" && Number.isFinite(r.pingMs) && r.pingMs > 0);
            if (valids.length === 0) return;
            const avg = Math.round(valids.reduce((acc, r) => acc + r.pingMs, 0) / valids.length);
            if (!Number.isFinite(avg) || avg <= 0) return;
            this.pingMs = avg;
            this.options.log("info", "ping calculado a partir do endpoint do perfil wireguard", { host: endpoint.host, pingMs: avg });
            this.persistRouteSnapshot();
        } catch (error) {
            this.options.log("warn", "não consegui calcular ping a partir do endpoint do perfil", { erro: errorMessage(error) });
        }
    }

    private routeSnapshotPath(): string {
        return path.join(this.dataDir, "route-snapshot.json");
    }

    private persistRouteSnapshot(): void {
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            const temporary = this.routeSnapshotPath() + ".tmp";
            fs.writeFileSync(temporary, JSON.stringify({
                routeId: this.routeId,
                routeCountry: this.routeCountry,
                routeCity: this.routeCity,
                routeLabel: this.routeLabel,
                pingMs: this.pingMs,
                savedAt: Date.now(),
            }), "utf8");
            fs.renameSync(temporary, this.routeSnapshotPath());
        } catch { /* ignora erro de persistencia do snapshot, nao e critico */ }
    }

    private restoreRouteSnapshot(): void {
        try {
            if (fs.existsSync(this.routeSnapshotPath())) {
                const raw = JSON.parse(fs.readFileSync(this.routeSnapshotPath(), "utf8")) as Record<string, unknown>;
                if (typeof raw.routeId === "string") this.routeId = raw.routeId.slice(0, 160);
                if (typeof raw.routeCountry === "string") this.routeCountry = raw.routeCountry.slice(0, 4).toUpperCase();
                if (typeof raw.routeCity === "string") this.routeCity = raw.routeCity.slice(0, 120);
                if (typeof raw.routeLabel === "string") this.routeLabel = raw.routeLabel.slice(0, 200);
                const rping = raw.pingMs;
                if (typeof rping === "number" && Number.isFinite(rping) && rping > 0) this.pingMs = rping;
            }
        } catch { /* sem snapshot, os campos ficam null mesmo */ }
        if (this.pingMs === null) {
            try {
                const markerPath = path.join(this.dataDir, "optimization-marker.json");
                if (fs.existsSync(markerPath)) {
                    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<string, unknown>;
                    const mping = marker.pingMs ?? marker.ping ?? marker.latencyMs;
                    if (typeof mping === "number" && Number.isFinite(mping) && mping > 0) this.pingMs = mping;
                }
            } catch { /* marker opcional */ }
        }
    }

    private readEndpointFromProfile(): { hostname: string; country: string | null } | null {
        try {
            if (!fs.existsSync(this.profilePath)) return null;
            const raw = fs.readFileSync(this.profilePath, "utf8");
            for (const line of raw.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#")) continue;
                const match = /^Endpoint\s*=\s*(.+)$/i.exec(trimmed);
                if (!match) continue;
                const endpoint = match[1].trim();
                const host = endpoint.includes(":") ? endpoint.slice(0, endpoint.lastIndexOf(":")) : endpoint;
                const countryMatch = /(^|[.-])([A-Z]{2})([.-]|(?:\d|vp|node|proton))/i.exec(host);
                const country = countryMatch ? countryMatch[2].toUpperCase() : null;
                return { hostname: host, country };
            }
            return null;
        } catch {
            return null;
        }
    }

    private statusMessage(): string {
        switch (this.state) {
            case "active": return "VPN WireGuard ativa para este Discord";
            case "preparing": return "Preparando perfil e WireSock";
            case "starting": return "Iniciando túnel WireGuard";
            case "restart_pending": return "VPN preparada; reiniciando Discord";
            case "stopping": return "Restaurando rede normal";
            case "blocked_external": return this.externalReason || "WireSock externo está ativo";
            case "recovery_required": return "A rede precisa de recuperação manual";
            default: return "VPN inativa";
        }
    }

    private setDiagnostic(kind: VpnDiagnostic["kind"], ok: boolean, detail: unknown): void {
        this.lastDiagnostic = { at: new Date().toISOString(), kind, ok, detail: safeDiagnosticDetail(detail) };
    }

    private blockExternal(reason: string): void {
        this.state = "blocked_external";
        this.externalReason = safeDiagnosticDetail(reason);
        this.setDiagnostic("ownership", false, this.externalReason);
        this.stopWatchdog();
        this.options.log("warn", "VPN recusada para preservar WireSock externo", { motivo: this.externalReason });
    }

    private async startInternal(relaunch: boolean): Promise<VpnOperationResult> {
        if (!isSupportedWindowsArchitecture(process.platform, process.arch)) {
            this.state = "blocked_external";
            this.externalReason = "A VPN do plugin nesta versão está disponível somente no Windows x64.";
            return { success: false, state: this.state, error: this.externalReason };
        }
        let existing = windows.inspectWireSock(this.serviceConfigPath);
        if (existing.active && !existing.owned) {
            for (let attempt = 0; attempt < 3 && existing.active && !existing.owned; attempt++) {
                await new Promise<void>(r => setTimeout(r, 600));
                existing = windows.inspectWireSock(this.serviceConfigPath);
            }
        }
        if (existing.active && existing.owned) {
            const owner = this.readOwner();
            if (owner && owner.pid !== process.pid && processAlive(owner.pid) && !owner.restarting) {
                this.blockExternal("Outra instância do LefferzinBypass já controla esta sessão WireSock.");
                return { success: false, state: this.state, error: this.externalReason || undefined };
            }
            if (this.state !== "active") {
                this.generation = Math.max(this.generation, owner?.generation ?? 0);
                this.adoptOwnership(owner, existing);
                this.state = "active";
                this.discordPid = process.pid;
                this.startWatchdog();
                this.startDiagnostics("adoption");
                void this.ensurePingFromExistingProfile();
            }
            return { success: true, state: "active", message: this.statusMessage() };
        }
        if (existing.active && !existing.owned) {
            // Nunca encerre uma sessão que o plugin não consegue provar que é
            // sua. A limpeza destrutiva fica reservada ao script global
            // manual; o fluxo normal apenas bloqueia o conflito.
            this.options.log("warn", "WireSock externo ativo antes do start; ativação bloqueada", {
                services: existing.services,
                registeredServices: existing.registeredServices,
                foreignRegisteredServices: existing.foreignRegisteredServices,
                pids: existing.processIds,
                motivo: existing.reason,
            });
            this.blockExternal(existing.reason || "WireSock externo está ativo.");
            return { success: false, state: this.state, error: this.externalReason || undefined };
        }
        this.state = "preparing";
        this.externalReason = null;
        this.generation++;
        let owner: VpnOwnerRecord | null = null;
        let started = false;
        try {
            await this.migrateGuiState();
            // O lock precisa ser adquirido antes de gerar/escrever
            // wireguard.conf. Se duas instâncias chegarem aqui juntas, a
            // segunda não pode sobrescrever o perfil enquanto a primeira
            // ainda está iniciando o serviço.
            owner = this.acquireOwnership();
            const settings = this.settings();
            if (!settings.protonUsername) throw new Error("Faça login com sua conta Proton antes de ativar.");
            if (!fs.existsSync(this.profilePath)) {
                let generated: proton.ProtonOptimizationResult | null = null;
                for (let attempt = 0; attempt < 2 && (generated === null || !generated.success); attempt++) {
                    if (attempt > 0) {
                        this.options.log("warn", "geração de perfil Proton falhou; tentando novamente após 800ms", { erro: generated?.error });
                        await new Promise<void>(r => setTimeout(r, 800));
                    }
                    generated = await proton.generateOptimalProtonConfig(this.dataDir, {
                        username: settings.protonUsername,
                        country: settings.protonCountry,
                        freeOnly: settings.protonFreeOnly,
                        autoPing: settings.protonAutoPing,
                        log: this.options.log,
                    });
                }
                if (!generated || !generated.success) throw new Error(generated?.error || "Não foi possível gerar a configuração Proton.");
                this.applyProtonResult(generated);
            } else {
                const endpoint = this.readEndpointFromProfile();
                if (endpoint?.country && !this.routeCountry) this.routeCountry = endpoint.country;
                if (endpoint?.hostname && !this.routeId) this.routeId = endpoint.hostname.slice(0, 160);
                if (!this.routeLabel) this.routeLabel = this.buildRouteLabel();
                void this.ensurePingFromExistingProfile();
            }
            const raw = fs.readFileSync(this.profilePath, "utf8");
            const validation = windows.validateWireGuardProfile(raw);
            if (!validation.valid) throw new Error(validation.error);

            const apps = this.discordAllowedApps();
            const probe = this.prepareRouteProbe();
            if (probe) apps.push(probe);
            owner.probePath = probe;
            this.writeOwner(owner);
            this.state = "starting";
            const startedResult = await windows.startWireSockService(this.serviceConfigPath, raw, apps, this.options.log);
            started = true;
            owner.configPath = startedResult.configPath;
            owner.restarting = relaunch;
            this.writeOwner(owner);
            this.discordPid = process.pid;
            this.state = relaunch ? "restart_pending" : "active";
            this.startWatchdog();
            this.startDiagnostics("activation");
            if (relaunch) {
                if (!this.requestRelaunch()) {
                    this.state = "active";
                    owner.restarting = false;
                    this.writeOwner(owner);
                    return { success: false, state: this.state, error: "A VPN foi iniciada, mas não consegui reiniciar o Discord para aplicar a rota." };
                }
                return { success: true, state: "restart_pending", message: "VPN preparada; o Discord será reiniciado." };
            }
            return { success: true, state: "active", message: this.statusMessage() };
        } catch (error) {
            this.stopWatchdog();
            if (started || windows.inspectWireSock(this.serviceConfigPath).active) {
                // Mesmo depois de uma ativação parcial, nunca use a limpeza
                // global automaticamente. A inspeção do perfil/serviço é a
                // única prova autorizada para parar o que pertence ao plugin;
                // se ela não confirmar ownership, deixe recovery_required.
                const cleanup = await windows.stopOwnedWireSock(this.serviceConfigPath, this.options.log);
                if (!cleanup.stopped) {
                    this.state = "recovery_required";
                    this.setDiagnostic("wireguard", false, cleanup.error || "limpeza incompleta");
                    return { success: false, state: this.state, error: `A ativação falhou e a rede não foi restaurada: ${cleanup.error || "limpeza incompleta"}.` };
                }
            }
            if (owner) this.releaseOwnership(owner);
            this.removeProbe();
            this.state = "inactive";
            const message = errorMessage(error);
            this.setDiagnostic("wireguard", false, message);
            this.options.log("error", "ativação VPN falhou", { erro: message });
            return { success: false, state: this.state, error: message };
        }
    }

    private async stopInternal(relaunch: boolean, forceNuclear = false): Promise<VpnOperationResult> {
        if (!isSupportedWindowsArchitecture(process.platform, process.arch)) return { success: false, state: "blocked_external", error: "A VPN do plugin nesta versão exige Windows x64." };
        this.stopWatchdog();
        const inspection = windows.inspectWireSock(this.serviceConfigPath);
        const owner = this.readOwner();
        const needsInactiveCleanup = Boolean(owner)
            || this.state === "preparing"
            || this.state === "starting"
            || this.state === "stopping"
            || this.state === "restart_pending"
            || this.state === "recovery_required";
        if (!inspection.active && !needsInactiveCleanup) {
            if (owner) this.releaseOwnership(owner);
            this.removeProbe();
            this.state = "inactive";
            this.discordPid = null;
            return { success: true, state: this.state, message: this.statusMessage() };
        }
        if (!forceNuclear && inspection.active && !inspection.owned) {
            this.blockExternal(inspection.reason || "WireSock externo está ativo; não será interrompido.");
            return { success: false, state: this.state, error: this.externalReason || undefined };
        }
        this.state = "stopping";
        let cleanup: windows.WireSockCleanupResult;
        if (forceNuclear) {
            cleanup = await windows.stopAllWireSockNuclear(this.options.log);
        } else {
            cleanup = await windows.stopOwnedWireSock(this.serviceConfigPath, this.options.log);
        }
        if (!cleanup.stopped) {
            this.state = "recovery_required";
            this.setDiagnostic("wireguard", false, cleanup.error || "limpeza incompleta");
            return { success: false, state: this.state, error: cleanup.error || "Não foi possível restaurar a rede." };
        }
        this.removeProbe();
        if (owner) this.releaseOwnership(owner);
        this.discordPid = null;
        this.state = "inactive";
        this.externalReason = null;
        this.setDiagnostic("wireguard", true, "serviço WireSock próprio parado e rede restaurada");
        if (relaunch && !this.restarting) {
            if (!this.requestRelaunch())
                return { success: false, state: this.state, error: "A rede foi restaurada, mas não consegui reiniciar o Discord." };
            return { success: true, state: "restart_pending", message: "Rede restaurada; o Discord será reiniciado." };
        }
        return { success: true, state: this.state, message: this.statusMessage() };
    }

    private discordAllowedApps(): string[] {
        const executable = path.resolve(process.execPath);
        const appDir = path.dirname(executable);
        const installRoot = path.dirname(appDir);
        const updater = path.join(installRoot, "Update.exe");
        const values = [executable];
        if (fs.existsSync(updater)) values.push(path.resolve(updater));
        return values;
    }

    private prepareRouteProbe(): string | undefined {
        try {
            const source = proton.findProtonConfgenExe();
            const target = windows.routeProbeExecutablePath(this.dataDir);
            windows.copyRouteProbe(source, target);
            return target;
        } catch (error) {
            this.options.log("warn", "helper de diagnóstico não foi incluído em AllowedApps", { erro: errorMessage(error) });
            return undefined;
        }
    }

    private removeProbe(): void {
        if (this.probePath) windows.removeRouteProbe(this.probePath);
        const owner = this.readOwner();
        if (owner?.probePath) windows.removeRouteProbe(owner.probePath);
        this.probePath = undefined;
    }

    private startDiagnostics(stage: string): void {
        void windows.diagnoseWindowsNetwork(this.options.log).then(result => {
            this.setDiagnostic("network", result.ok, `${stage}: ${result.detail}`);
        }).catch(error => this.setDiagnostic("network", false, error));

        const owner = this.readOwner();
        const probePath = owner?.probePath;
        if (!probePath || !fs.existsSync(probePath)) return;
        void windows.runRouteProbe(probePath).then(result => {
            this.setDiagnostic("route", Boolean(result?.success), safeDiagnosticDetail(JSON.stringify(result || { error: "resposta vazia" }), 500));
            this.options.log(result?.success ? "info" : "warn", "probe de rota do Discord concluído", { stage, result: safeDiagnosticDetail(JSON.stringify(result || {}), 500), mode: "log-only" });
        }).catch(error => {
            this.setDiagnostic("route", false, error);
            this.options.log("warn", "probe de rota do Discord falhou", { stage, erro: errorMessage(error), mode: "log-only" });
        });
    }

    private startWatchdog(): void {
        if (this.watchdog || !isWindows()) return;
        this.watchdog = setInterval(() => {
            if (this.state !== "active") return;
            const owner = this.readOwner();
            if (owner && owner.pid !== process.pid && !processAlive(owner.pid)) {
                void this.stopInternal(false, false).then(result => {
                    this.options.log(result.success ? "info" : "warn", "watchdog encerrou a sessão WireSock após a morte do Discord dono", { pid: owner.pid, sucesso: result.success, erro: result.error });
                }).catch(error => {
                    this.options.log("error", "watchdog não conseguiu derrubar WireSock do PID morto", { erro: errorMessage(error) });
                });
                return;
            }
            if (this.discordPid !== null && this.discordPid !== process.pid && !processAlive(this.discordPid)) {
                const discordPid = this.discordPid;
                void this.stopInternal(false, false).then(result => {
                    this.options.log(result.success ? "info" : "warn", "watchdog encerrou a sessão WireSock após a morte do Discord", { pid: discordPid, sucesso: result.success, erro: result.error });
                }).catch(error => {
                    this.options.log("error", "watchdog não conseguiu derrubar WireSock do Discord PID morto", { erro: errorMessage(error) });
                });
                return;
            }
            const inspection = windows.inspectWireSock(this.serviceConfigPath);
            if (!inspection.active) {
                this.state = "recovery_required";
                this.setDiagnostic("wireguard", false, "serviço WireSock próprio desapareceu");
                this.options.log("error", "watchdog detectou que o WireSock próprio parou", { mode: "diagnostic-only" });
                this.stopWatchdog();
                return;
            }
            if (!inspection.owned) {
                this.blockExternal(inspection.reason || "ownership do WireSock mudou");
                return;
            }
            this.startDiagnostics("watchdog");
        }, WATCHDOG_MS);
        this.watchdog.unref?.();
    }

    private stopWatchdog(): void {
        if (this.watchdog) clearInterval(this.watchdog);
        this.watchdog = null;
    }

    private requestRelaunch(): boolean {
        const owner = this.readOwner();
        if (owner) {
            owner.pid = process.pid;
            owner.restarting = true;
            this.writeOwner(owner);
        }
        this.restarting = true;
        try {
            app.relaunch();
            app.exit(0);
            return true;
        } catch (error) {
            this.restarting = false;
            if (owner) {
                owner.restarting = false;
                this.writeOwner(owner);
            }
            this.options.log("error", "não consegui solicitar reinício do Discord", { erro: errorMessage(error) });
            return false;
        }
    }

    private acquireOwnership(): VpnOwnerRecord {
        fs.mkdirSync(this.dataDir, { recursive: true });
        const existing = this.readOwner();
        const inspection = windows.inspectWireSock(this.serviceConfigPath);
        if (inspection.active && !inspection.owned) throw new Error(inspection.reason || "WireSock externo está ativo.");
        if (existing?.pid === process.pid) {
            this.probePath = existing.probePath;
            return existing;
        }
        if (existing && existing.pid !== process.pid) {
            if (existing.restarting && inspection.active && inspection.owned) {
                this.generation = Math.max(this.generation, existing.generation);
                this.probePath = existing.probePath;
                return { ...existing, pid: process.pid, restarting: false };
            }
            if (processAlive(existing.pid)) throw new Error("Outra instância do GoLiveBypass já controla a VPN.");
            if (inspection.active && inspection.owned) {
                this.generation = Math.max(this.generation, existing.generation);
                this.probePath = existing.probePath;
                return { ...existing, pid: process.pid, restarting: false };
            }
            this.releaseOwnership(existing);
        }
        const owner: VpnOwnerRecord = {
            kind: VPN_OWNER_KIND,
            pid: process.pid,
            generation: this.generation,
            profilePath: this.profilePath,
            configPath: this.serviceConfigPath,
            createdAt: Date.now(),
        };
        try {
            const descriptor = fs.openSync(this.ownerPath, "wx");
            fs.writeFileSync(descriptor, JSON.stringify(owner), "utf8");
            fs.closeSync(descriptor);
        } catch (error) {
            const current = this.readOwner();
            if (current && processAlive(current.pid)) throw new Error("Outra instância do GoLiveBypass já controla a VPN.");
            throw new Error(`Não foi possível reservar ownership da VPN: ${errorMessage(error)}`);
        }
        this.probePath = undefined;
        return owner;
    }

    private adoptOwnership(previous: VpnOwnerRecord | null, inspection: windows.WireSockInspection): void {
        const source: VpnOwnerRecord = previous ?? {
            kind: VPN_OWNER_KIND,
            pid: process.pid,
            generation: this.generation,
            profilePath: this.profilePath,
            configPath: this.serviceConfigPath,
            createdAt: Date.now(),
        } satisfies VpnOwnerRecord;
        this.probePath = source.probePath;
        this.writeOwner({ ...source, pid: process.pid, configPath: this.serviceConfigPath, profilePath: this.profilePath, restarting: false });
        this.options.log("info", "ownership do WireSock confirmado", { services: inspection.services, pids: inspection.processIds });
    }

    private readOwner(): VpnOwnerRecord | null {
        try {
            const value = JSON.parse(fs.readFileSync(this.ownerPath, "utf8")) as Partial<VpnOwnerRecord>;
            const pid = value.pid;
            const generation = value.generation;
            const profilePath = value.profilePath;
            const configPath = value.configPath;
            const createdAt = value.createdAt;
            if (value.kind !== VPN_OWNER_KIND || typeof pid !== "number" || !Number.isInteger(pid) || typeof generation !== "number" || !Number.isInteger(generation)) return null;
            if (typeof profilePath !== "string" || typeof configPath !== "string" || typeof createdAt !== "number") return null;
            if (path.resolve(profilePath) !== this.profilePath || path.resolve(configPath) !== this.serviceConfigPath) return null;
            return {
                kind: VPN_OWNER_KIND,
                pid,
                generation,
                profilePath: this.profilePath,
                configPath: this.serviceConfigPath,
                probePath: typeof value.probePath === "string" ? value.probePath : undefined,
                restarting: value.restarting === true,
                createdAt,
            };
        } catch { return null; }
    }

    private writeOwner(owner: VpnOwnerRecord): void {
        fs.mkdirSync(this.dataDir, { recursive: true });
        const temporary = `${this.ownerPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(owner), "utf8");
        fs.renameSync(temporary, this.ownerPath);
    }

    private releaseOwnership(owner: VpnOwnerRecord): void {
        const current = this.readOwner();
        if (!current || current.kind !== owner.kind || current.configPath !== owner.configPath) return;
        try { fs.rmSync(this.ownerPath, { force: true }); } catch (error) { this.options.log("warn", "não consegui remover lock da VPN", { erro: errorMessage(error) }); }
    }

    private writeProfileAtomically(raw: string): void {
        fs.mkdirSync(this.dataDir, { recursive: true });
        const temporary = `${this.profilePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporary, raw, "utf8");
        fs.renameSync(temporary, this.profilePath);
    }

    private async migrateGuiState(): Promise<void> {
        fs.mkdirSync(this.dataDir, { recursive: true });
        const markerPath = path.join(this.dataDir, MIGRATION_FILE);
        if (fs.existsSync(markerPath)) return;
        const copies = [PROFILE_FILE, "proton-session.json"];
        for (const file of copies) {
            const source = path.join(this.options.guiDataDir, file);
            const target = path.join(this.dataDir, file);
            if (fs.existsSync(source) && !fs.existsSync(target)) {
                try { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); this.options.log("info", "estado compatível da GUI importado", { arquivo: file }); }
                catch (error) { this.options.log("warn", "não consegui importar estado da GUI", { arquivo: file, erro: errorMessage(error) }); }
            }
        }
        const temporary = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ schema: VPN_SCHEMA_VERSION, completedAt: Date.now(), source: "gui-compatible-profile-only" }), "utf8");
        fs.renameSync(temporary, markerPath);
    }
}

export function defaultPluginVpnDataDir(): string {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || osFallbackHome();
    return path.join(base, "GoLiveBypass", "plugin-vpn");
}

function osFallbackHome(): string {
    return process.env.USERPROFILE || process.env.HOME || ".";
}
