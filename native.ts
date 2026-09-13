/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";
import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "fs";
import { dirname, join } from "path";

import { defaultPluginVpnDataDir, PluginVpnController, type ProtonLoginPayload, type ProtonOptimizationOptions } from "./vpn-controller";
import * as proton from "./vpn-proton";
import { safeDiagnosticDetail } from "./vpn-types";

const PLUGIN_SETTINGS_KEY = "LefferzinBypass";
const LEGACY_SETTINGS_KEY = "Lefferzin Bypass";
const MAX_LOG_LINES = 400;
const MAX_LOG_BYTES = 256 * 1024;
const CAPTCHA_IPC_CHANNEL = "lefferzin-plugin-proton-captcha-response";
const CAPTCHA_TIMEOUT_MS = 120_000;

const VPN_DATA_DIR = defaultPluginVpnDataDir();
const GUI_DATA_DIR = dirname(VPN_DATA_DIR);
const LOG_FILE = join(VPN_DATA_DIR, "plugin-vpn.log");
const ROUTE_INFO_FILE = join(VPN_DATA_DIR, "route-info.json");

function saveRouteInfo(routeId: string | null, pingMs: number | null): void {
    try {
        mkdirSync(dirname(ROUTE_INFO_FILE), { recursive: true });
        writeFileSync(ROUTE_INFO_FILE, JSON.stringify({ routeId, pingMs, updatedAt: Date.now() }));
    } catch {
        // Nao faz nada se nao conseguir salvar.
    }
}

function readRouteInfo(): { routeId: string | null; pingMs: number | null } {
    try {
        if (!existsSync(ROUTE_INFO_FILE)) return { routeId: null, pingMs: null };
        const raw = readFileSync(ROUTE_INFO_FILE, "utf8");
        const data = JSON.parse(raw) as { routeId?: unknown; pingMs?: unknown };
        const routeId = typeof data.routeId === "string" && data.routeId.trim() ? data.routeId.trim() : null;
        const pingMs = typeof data.pingMs === "number" && Number.isFinite(data.pingMs) && data.pingMs >= 0 ? data.pingMs : null;
        return { routeId, pingMs };
    } catch {
        return { routeId: null, pingMs: null };
    }
}

function extractRouteIdFromEndpoint(endpoint: unknown): string | null {
    if (typeof endpoint !== "string" || !endpoint) return null;
    const withoutPort = endpoint.includes(":") ? endpoint.slice(0, endpoint.indexOf(":")) : endpoint;
    const parts = withoutPort.split(".").filter(Boolean);
    if (!parts.length) return null;
    return parts[0].trim().toLowerCase() || null;
}

function extractRouteIdFromProfile(profilePath: string | null): string | null {
    try {
        if (!profilePath || !existsSync(profilePath)) return null;
        const text = readFileSync(profilePath, "utf8");
        const match = /^\s*Endpoint\s*=\s*(\S+)/m.exec(text);
        if (!match || !match[1]) return null;
        return extractRouteIdFromEndpoint(match[1]);
    } catch {
        return null;
    }
}

const history: string[] = [];
let quitting = false;

type PluginSettingsRecord = Record<string, unknown>;

function pluginSettings(): PluginSettingsRecord {
    const root = RendererSettings.plain as { plugins?: unknown };
    const plugins = root.plugins;
    if (plugins === null || typeof plugins !== "object") return {};
    const current = (plugins as Record<string, unknown>)[PLUGIN_SETTINGS_KEY];
    if (current !== null && typeof current === "object" && Object.keys(current as object).length > 0) {
        return current as PluginSettingsRecord;
    }
    const legacy = (plugins as Record<string, unknown>)[LEGACY_SETTINGS_KEY];
    if (legacy !== null && typeof legacy === "object") {
        try {
            if (!RendererSettings.store.plugins) RendererSettings.store.plugins = {};
            (RendererSettings.store.plugins as Record<string, PluginSettingsRecord>)[PLUGIN_SETTINGS_KEY] = { ...(legacy as PluginSettingsRecord) };
            log("info", "configuracoes migradas da chave antiga para a nova");
        } catch { /* ignora se nao conseguir migrar agora */ }
        return legacy as PluginSettingsRecord;
    }
    return {};
}

function pluginEnabled(): boolean {
    const current = pluginSettings();
    if (current.enabled === true) return true;
    const root = RendererSettings.plain as { plugins?: unknown };
    const plugins = root.plugins;
    if (plugins === null || typeof plugins !== "object") return false;
    const legacy = (plugins as Record<string, unknown>)[LEGACY_SETTINGS_KEY];
    return legacy !== null && typeof legacy === "object" && (legacy as PluginSettingsRecord).enabled === true;
}

function controllerSettings(): PluginSettingsRecord {
    const stored = pluginSettings();
    return {
        mode: "proton",
        protonUsername: typeof stored.protonUsername === "string" ? stored.protonUsername : "",
        protonCountry: typeof stored.protonCountry === "string" ? stored.protonCountry : "",
        protonFreeOnly: stored.protonFreeOnly !== false,
        protonAutoPing: stored.protonAutoPing !== false,
    };
}

function describeData(data: Record<string, unknown> | undefined): string {
    if (!data) return "";
    return Object.entries(data)
        .map(([key, value]) => {
            let printed: string;
            try { printed = typeof value === "string" ? value : JSON.stringify(value) ?? String(value); } catch { printed = String(value); }
            return `${key}=${safeDiagnosticDetail(printed, 500)}`;
        })
        .join(" ");
}

function log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
    const detail = describeData(data);
    const line = `${new Date().toISOString().slice(11, 23)} [${level}] ${safeDiagnosticDetail(message, 1500)}${detail ? ` | ${detail}` : ""}`;
    history.push(line);
    while (history.length > MAX_LOG_LINES) history.shift();

    try {
        mkdirSync(VPN_DATA_DIR, { recursive: true });
        if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_BYTES)
            writeFileSync(LOG_FILE, readFileSync(LOG_FILE, "utf8").slice(-Math.floor(MAX_LOG_BYTES / 2)), "utf8");
        appendFileSync(LOG_FILE, `${line}\n`, "utf8");
    } catch (error) {
        // Diagnóstico nunca pode impedir o Discord de continuar abrindo.
        if (history.length < MAX_LOG_LINES)
            history.push(`${new Date().toISOString().slice(11, 23)} [warn] não consegui gravar o log: ${safeDiagnosticDetail(error)}`);
    }
}

const controller = new PluginVpnController({
    dataDir: VPN_DATA_DIR,
    guiDataDir: GUI_DATA_DIR,
    readSettings: controllerSettings,
    isEnabled: pluginEnabled,
    log,
});

export function logFromRenderer(_: IpcMainInvokeEvent, message: unknown): void {
    if (typeof message === "string" && message.trim()) log("info", message.slice(0, 2000));
}

function setStoredUsername(username: string): void {
    try {
        const plugins = RendererSettings.store.plugins as Record<string, PluginSettingsRecord>;
        const stored = plugins[PLUGIN_SETTINGS_KEY];
        if (stored) stored.protonUsername = username;
    } catch (error) {
        log("warn", "não consegui atualizar o usuário Proton nas configurações", { erro: error });
    }
}

function cleanLoginPayload(value: unknown): ProtonLoginPayload {
    if (value === null || typeof value !== "object") throw new Error("Informe os dados de login Proton.");
    const raw = value as Record<string, unknown>;
    const username = typeof raw.username === "string" ? raw.username.trim().slice(0, 320) : "";
    const password = typeof raw.password === "string" ? raw.password.slice(0, 2048) : undefined;
    const twoFactorCode = typeof raw.twoFactorCode === "string" ? raw.twoFactorCode.trim().slice(0, 64) : undefined;
    if (!username) throw new Error("Informe o usuário Proton.");
    if (!password) throw new Error("Informe a senha Proton.");
    return { username, password, twoFactorCode };
}

function cleanOptimizationOptions(value: unknown): ProtonOptimizationOptions {
    const raw = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    const country = typeof raw.country === "string" ? raw.country.trim().slice(0, 128) : undefined;
    const serverId = typeof raw.serverId === "string" ? raw.serverId.trim().slice(0, 160) : undefined;
    const requestId = typeof raw.requestId === "string" ? raw.requestId.trim().slice(0, 120) : undefined;
    return {
        country,
        serverId,
        freeOnly: typeof raw.freeOnly === "boolean" ? raw.freeOnly : undefined,
        autoPing: raw.autoPing !== false,
        speedTest: raw.speedTest === true,
        requestId,
    };
}

function writeCaptchaPreload(): string {
    const target = join(VPN_DATA_DIR, "captcha-preload.cjs");
    const source = `"use strict";\nconst { ipcRenderer } = require("electron");\nconst accepted = new Set(["pm_captcha", "proton_captcha"]);\nwindow.addEventListener("message", event => {\n  const data = event.data;\n  if (!data || !accepted.has(data.type) || typeof data.token !== "string" || data.token.length > 16384) return;\n  ipcRenderer.send(${JSON.stringify(CAPTCHA_IPC_CHANNEL)}, { type: data.type, token: data.token });\n});\n`;
    mkdirSync(VPN_DATA_DIR, { recursive: true });
    try {
        if (readFileSync(target, "utf8") !== source) writeFileSync(target, source, { encoding: "utf8", mode: 0o600 });
    } catch {
        writeFileSync(target, source, { encoding: "utf8", mode: 0o600 });
    }
    return target;
}

function allowedCaptchaNavigation(rawUrl: string, challenge: { origin: string }): boolean {
    try {
        const parsed = new URL(rawUrl);
        return parsed.protocol === "https:"
            && parsed.origin === challenge.origin
            && parsed.pathname === "/core/v4/captcha";
    } catch {
        return false;
    }
}

type CaptchaResult =
    | { ok: true; token: string }
    | { ok: false; code: "CAPTCHA_CANCELLED" | "CAPTCHA_INVALID"; message: string };

function solveCaptcha(rawUrl: string, parent: BrowserWindow | null): Promise<CaptchaResult> {
    const challenge = proton.parseCaptchaUrl(rawUrl);
    if (!challenge) return Promise.resolve({ ok: false, code: "CAPTCHA_INVALID", message: "O Proton forneceu um endereço de CAPTCHA inválido." });

    let preload: string;
    try { preload = writeCaptchaPreload(); }
    catch { return Promise.resolve({ ok: false, code: "CAPTCHA_INVALID", message: "Não foi possível preparar a captura do CAPTCHA." }); }

    return new Promise(resolve => {
        let settled = false;
        let invalidMessages = 0;
        const captchaWindow = new BrowserWindow({
            width: 520,
            height: 700,
            minWidth: 420,
            minHeight: 560,
            parent: parent && !parent.isDestroyed() ? parent : undefined,
            modal: Boolean(parent && !parent.isDestroyed()),
            show: false,
            autoHideMenuBar: true,
            title: "Verificação de segurança Proton",
            backgroundColor: "#17171c",
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                devTools: false,
                safeDialogs: true,
                spellcheck: false,
                preload,
                partition: `golive-plugin-captcha-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            },
        });
        const captchaSession = captchaWindow.webContents.session;
        const preventDownload = (event: Electron.Event) => event.preventDefault();
        const onCaptchaResponse = (event: IpcMainEvent, message: { type?: unknown; token?: unknown }) => {
            if (settled || event.sender !== captchaWindow.webContents) return;
            if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return;
            if (!allowedCaptchaNavigation(event.senderFrame.url, challenge)) return;
            if (message?.type !== "pm_captcha" && message?.type !== "proton_captcha") return;
            if (proton.validateCaptchaResponse(message.token, challenge.challenge)) {
                finish({ ok: true, token: message.token });
                return;
            }
            invalidMessages++;
            if (invalidMessages >= 10)
                finish({ ok: false, code: "CAPTCHA_INVALID", message: "O CAPTCHA retornou uma resposta inválida. Tente novamente." });
        };
        const finish = (result: CaptchaResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            ipcMain.removeListener(CAPTCHA_IPC_CHANNEL, onCaptchaResponse);
            captchaSession.removeListener("will-download", preventDownload);
            resolve(result);
            if (!captchaWindow.isDestroyed()) captchaWindow.destroy();
        };
        const timeout = setTimeout(() => finish({ ok: false, code: "CAPTCHA_INVALID", message: "A verificação expirou. Inicie o login novamente." }), CAPTCHA_TIMEOUT_MS);
        timeout.unref?.();

        captchaSession.on("will-download", preventDownload);
        captchaSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
        captchaWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        captchaWindow.webContents.on("will-attach-webview", event => event.preventDefault());
        const guardNavigation = (event: Electron.Event, targetUrl: string) => {
            if (!allowedCaptchaNavigation(targetUrl, challenge)) event.preventDefault();
        };
        captchaWindow.webContents.on("will-navigate", guardNavigation);
        captchaWindow.webContents.on("will-redirect", guardNavigation);
        captchaWindow.webContents.on("did-fail-load", (_event, errorCode, _description, _validatedUrl, isMainFrame) => {
            if (isMainFrame && errorCode !== -3)
                finish({ ok: false, code: "CAPTCHA_INVALID", message: "Não foi possível carregar o CAPTCHA oficial da Proton." });
        });
        captchaWindow.webContents.on("preload-error", (_event, preloadPath) => {
            if (preloadPath === preload)
                finish({ ok: false, code: "CAPTCHA_INVALID", message: "Não foi possível preparar a captura do CAPTCHA." });
        });
        captchaWindow.once("ready-to-show", () => { if (!settled) captchaWindow.show(); });
        captchaWindow.once("close", () => {
            if (!settled) finish({ ok: false, code: "CAPTCHA_CANCELLED", message: "Verificação cancelada. Nenhuma credencial foi alterada." });
        });
        captchaWindow.once("closed", () => {
            if (!settled) finish({ ok: false, code: "CAPTCHA_CANCELLED", message: "Verificação cancelada. Nenhuma credencial foi alterada." });
        });
        ipcMain.on(CAPTCHA_IPC_CHANNEL, onCaptchaResponse);
        void captchaWindow.loadURL(challenge.url).catch(() => {
            finish({ ok: false, code: "CAPTCHA_INVALID", message: "Não foi possível abrir o CAPTCHA oficial da Proton." });
        });
    });
}

export function enable(_: IpcMainInvokeEvent, relaunch: unknown = false) {
    const shouldRelaunch = relaunch === true || relaunch === "true";
    return controller.enable(shouldRelaunch);
}

export function recoverAndStart(_: IpcMainInvokeEvent) {
    return controller.recoverAndStart();
}

export function shutdown(_: IpcMainInvokeEvent, relaunch: unknown = false) {
    const shouldRelaunch = relaunch === true || relaunch === "true";
    return controller.shutdown(shouldRelaunch);
}

export function wipeWireSock(_: IpcMainInvokeEvent) {
    return controller.wipeEverything();
}

export async function fullLogout(_: IpcMainInvokeEvent): Promise<{
    success: boolean;
    wipedStopped?: boolean;
    servicesDeleted?: number;
    protonSessionRemoved?: boolean;
    shutdownSuccess?: boolean;
    error?: string;
}> {
    quitting = true;
    log("info", "fullLogout: inicio do logout completo atomico");

    let wipedStopped = false;
    let servicesDeleted = 0;
    let shutdownSuccess = false;
    let protonSessionRemoved = false;

    try {
        try {
            // Logout normal só encerra a sessão pertencente ao plugin. Nunca
            // use a limpeza nuclear aqui: outro plugin/GUI pode estar usando
            // WireSock ao mesmo tempo.
            const shutdownResult = await controller.shutdown(false, false);
            wipedStopped = shutdownResult.success === true;
            shutdownSuccess = shutdownResult.success === true;
            log("info", "fullLogout: shutdown próprio concluido", { sucesso: shutdownSuccess, estado: shutdownResult.state, erro: shutdownResult.error });
        } catch (error) {
            log("error", "fullLogout: shutdown lancou excecao, continuando mesmo assim", { erro: safeDiagnosticDetail(error) });
        }

        if (!shutdownSuccess) {
            quitting = false;
            return {
                success: false,
                wipedStopped,
                servicesDeleted,
                shutdownSuccess,
                protonSessionRemoved: false,
                error: "A VPN não foi encerrada porque o WireSock não pôde ser confirmado como pertencente ao plugin. O perfil e a sessão Proton foram preservados.",
            };
        }

        try {
            protonSessionRemoved = controller.logoutProton();
            saveRouteInfo(null, null);
            log("info", "fullLogout: sessao Proton removida e arquivos deletados", { removido: protonSessionRemoved });
        } catch (error) {
            log("error", "fullLogout: logoutProton lancou excecao", { erro: safeDiagnosticDetail(error) });
        }

        setStoredUsername("");

        const success = wipedStopped && shutdownSuccess && protonSessionRemoved;
        quitting = false;
        return {
            success,
            wipedStopped,
            servicesDeleted,
            shutdownSuccess,
            protonSessionRemoved,
        };
    } catch (error) {
        const detail = safeDiagnosticDetail(error);
        log("error", "fullLogout: excecao geral", { erro: detail });
        quitting = false;
        return {
            success: false,
            wipedStopped,
            servicesDeleted,
            shutdownSuccess,
            protonSessionRemoved,
            error: detail,
        };
    }
}

export function restoreNetwork(_: IpcMainInvokeEvent) {
    return controller.restoreNetwork();
}

export function getVpnStatus(_: IpcMainInvokeEvent) {
    const base = controller.getStatus();
    const routeInfo = readRouteInfo();
    let routeId: string | null = routeInfo.routeId;
    let pingMs: number | null = routeInfo.pingMs;
    if (!routeId) {
        routeId = extractRouteIdFromProfile(base.profilePath);
        if (routeId && !routeInfo.routeId) saveRouteInfo(routeId, pingMs);
    }
    return { ...base, routeId, pingMs };
}

export function autoOptimizeRoute(_: IpcMainInvokeEvent) {
    return controller.autoOptimizeRoute().catch(error => ({
        success: false as const,
        checked: false,
        changed: false,
        error: safeDiagnosticDetail(error, 500),
    }));
}

export function getLog(_: IpcMainInvokeEvent): string {
    return history.join("\n");
}

export function getPluginVpnPaths(_: IpcMainInvokeEvent) {
    return { ...controller.paths, logPath: LOG_FILE };
}

export function getProtonSettings(_: IpcMainInvokeEvent) {
    const settings = controllerSettings();
    return {
        mode: settings.mode,
        protonUsername: settings.protonUsername,
        protonCountry: settings.protonCountry,
        protonFreeOnly: settings.protonFreeOnly,
        protonAutoPing: settings.protonAutoPing,
        sessionUsername: proton.savedSessionUsername(VPN_DATA_DIR),
    };
}

export async function loginProton(event: IpcMainInvokeEvent, value: unknown) {
    try {
        const payload = cleanLoginPayload(value);
        const parent = BrowserWindow.fromWebContents(event.sender);
        const result = await controller.loginProton(payload, url => solveCaptcha(url, parent).then(captcha => captcha.ok ? captcha.token : null));
        if (result.success && result.username) setStoredUsername(result.username);
        return result;
    } catch (error) {
        return { success: false as const, code: "CONFIGURATION_ERROR" as const, retryable: false, message: safeDiagnosticDetail(error, 500), error: safeDiagnosticDetail(error, 500) };
    }
}

export function checkProtonSession(_: IpcMainInvokeEvent, username?: unknown) {
    const value = typeof username === "string" && username.trim() ? username : String(controllerSettings().protonUsername || "");
    return controller.checkProtonSession(value).catch(error => ({ valid: false, error: safeDiagnosticDetail(error, 500) }));
}

export function getProtonPlan(_: IpcMainInvokeEvent, username?: unknown) {
    const value = typeof username === "string" && username.trim() ? username : String(controllerSettings().protonUsername || "");
    return controller.getProtonPlan(value);
}

export function logoutProton(_: IpcMainInvokeEvent) {
    const removed = controller.logoutProton();
    saveRouteInfo(null, null);
    setStoredUsername("");
    return { success: removed };
}

export function optimizeProtonRoute(event: IpcMainInvokeEvent, value: unknown) {
    const options = cleanOptimizationOptions(value);
    options.onProgress = progress => {
        if (!event.sender.isDestroyed()) event.sender.send("golive-vpn-proton-progress", progress);
    };
    return controller.optimizeProton(options).then(result => {
        if (result.success) {
            const routeId = typeof result.server === "string" && result.server.trim()
                ? result.server.trim().toLowerCase()
                : extractRouteIdFromEndpoint(result.endpoint);
            const pingMs = typeof result.pingMs === "number" && Number.isFinite(result.pingMs) && result.pingMs >= 0 ? result.pingMs : null;
            if (routeId || pingMs !== null) saveRouteInfo(routeId, pingMs);
        }
        return result;
    });
}

export function cancelProtonOptimization(_: IpcMainInvokeEvent, requestId: unknown) {
    return { cancelled: typeof requestId === "string" && controller.cancelOptimization(requestId) };
}

export function listAvailableProtonServers(_: IpcMainInvokeEvent, countries: unknown) {
    const countriesArr = Array.isArray(countries) ? countries : undefined;
    return controller.listAvailableRoutes(countriesArr).catch(error => ({ success: false as const, error: safeDiagnosticDetail(error, 500) }));
}

export function applySelectedProtonRoute(event: IpcMainInvokeEvent, value: unknown) {
    const raw = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    const country = typeof raw.country === "string" ? raw.country.trim().slice(0, 128) : undefined;
    const serverId = typeof raw.serverId === "string" ? raw.serverId.trim().slice(0, 160) : undefined;
    const options: ProtonOptimizationOptions = {
        country,
        serverId,
        autoPing: true,
        speedTest: false,
    };
    options.onProgress = progress => {
        if (!event.sender.isDestroyed()) event.sender.send("golive-vpn-proton-progress", progress);
    };
    return controller.optimizeProton(options).then(result => {
        if (result.success) {
            const routeId = typeof result.server === "string" && result.server.trim()
                ? result.server.trim().toLowerCase()
                : extractRouteIdFromEndpoint(result.endpoint);
            const pingMs = typeof result.pingMs === "number" && Number.isFinite(result.pingMs) && result.pingMs >= 0 ? result.pingMs : null;
            if (routeId || pingMs !== null) saveRouteInfo(routeId, pingMs);
        }
        return result;
    }).catch(error => ({ success: false as const, error: safeDiagnosticDetail(error, 500) }));
}

app.on("before-quit", event => {
    if (controller.isRelaunching() || quitting) return;
    if (!controller.hasCleanupWork()) return;
    event.preventDefault();
    quitting = true;
    log("info", "before-quit: encerrando somente a sessão WireSock do plugin");
    void controller.shutdown(false, false).then(result => {
        if (result.success || result.state === "blocked_external") {
            if (result.state === "blocked_external")
                log("warn", "before-quit: WireSock externo preservado; encerrando o Discord");
            app.exit(0);
            return;
        }
        quitting = false;
        log("error", "fechamento aguardou porque a restauração da VPN não foi confirmada", { estado: result.state, erro: result.error });
    }).catch(error => {
        quitting = false;
        log("error", "falha ao restaurar a rede antes do fechamento", { erro: safeDiagnosticDetail(error) });
    });
});

app.on("window-all-closed", () => {
    if (quitting) return;
    void controller.shutdown(false, false).then(result => {
        if (result.success || result.state === "blocked_external") {
            log(result.success ? "info" : "warn", "wireguard tratado depois que todas as janelas fecharam", { estado: result.state, erro: result.error });
            app.quit();
        } else {
            log("error", "Discord permaneceu aberto porque a VPN própria não foi restaurada", { estado: result.state, erro: result.error });
        }
    }).catch(error => {
        log("error", "falha ao derrubar VPN no window-all-closed", { erro: safeDiagnosticDetail(error) });
    });
});

const shutdownSignal = (source: string) => {
    if (quitting) return;
    quitting = true;
    void controller.shutdown(false, false).then(result => {
        log(result.success ? "info" : "warn", `shutdown via ${source}`, { estado: result.state, erro: result.error });
        process.exit(result.success || result.state === "blocked_external" ? 0 : 1);
    }).catch(error => {
        log("error", `falha ao restaurar VPN via ${source}`, { erro: safeDiagnosticDetail(error) });
        process.exit(1);
    });
};

try { process.on("SIGINT", () => shutdownSignal("SIGINT")); } catch {}
try { process.on("SIGTERM", () => shutdownSignal("SIGTERM")); } catch {}
try { process.on("SIGHUP", () => shutdownSignal("SIGHUP")); } catch {}

function delay(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function tryAutoEnable(attempt: number, maxAttempts: number) {
    if (!pluginEnabled()) return;
    try {
        const settings = controllerSettings();
        const hasProfile = existsSync(join(VPN_DATA_DIR, "wireguard.conf"));
        if (!settings.protonUsername && !hasProfile) {
            log("info", "plugin ativado, mas sem login/perfil Proton; pulando auto-enable no boot");
            return;
        }
        const result = await controller.enable(false);
        if (result.success) {
            log("info", `bypass ativado automaticamente no boot (tentativa ${attempt}/${maxAttempts})`, { estado: result.state });
            return;
        }
        if (attempt < maxAttempts) {
            log("warn", `bypass nao ativado no boot, tentando novamente em 6s`, { tentativa: attempt, estado: result.state, erro: result.error });
            await delay(6000);
            await tryAutoEnable(attempt + 1, maxAttempts);
            return;
        }
        log("warn", `bypass nao ativado no boot apos ${maxAttempts} tentativas`, { estado: result.state, erro: result.error });
    } catch (error) {
        log("error", `excecao ao tentar ativar bypass no boot (tentativa ${attempt})`, { erro: safeDiagnosticDetail(error, 500) });
        if (attempt < maxAttempts) {
            await delay(6000);
            await tryAutoEnable(attempt + 1, maxAttempts);
        }
    }
}

app.whenReady().then(async () => {
    log("info", `abrindo plugin VPN | ${process.platform} ${process.arch} | electron ${process.versions.electron}`);
    try {
        await controller.initialize();
    } catch (error) {
        log("error", "falha ao inicializar controlador VPN no boot", { erro: safeDiagnosticDetail(error, 500) });
    }
    void tryAutoEnable(1, 2);
}).catch(error => log("error", "falha ao inicializar o controlador VPN", { erro: safeDiagnosticDetail(error, 500) }));
