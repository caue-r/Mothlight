/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Paragraph } from "@components/Paragraph";
import { copyWithToast } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { Button, Constants, MaskedLink, React, RestAPI, SearchableSelect, TextInput, showToast, Toasts, UserStore, useEffect, useState } from "@webpack/common";

import {
    evaluateStreamObservation,
    evaluateStreamClaim,
    initialStreamClaimState,
    type StreamClaimState,
    type StreamObservation,
    type StreamObservationStatus,
} from "./stability";
import { startPresence, stopPresence, updateRouteInfo } from "./presence";

const Native = VencordNative?.pluginHelpers?.LefferzinBypass as PluginNative<typeof import("./native")> | undefined;

const logger = new Logger("Lefferzin Bypass");

interface RegionStore {
    getPreferredRegion(): string | null;
    getPreferredRegions(): string[] | null;
    shouldIncludePreferredRegion(): boolean;
}

interface VoiceRegion {
    id: string;
    name: string;
    optimal: boolean;
    deprecated: boolean;
    custom: boolean;
}

interface MediaEngineStore {
    supportsInApp(kind: string): boolean;
    supports(kind: string): boolean;
    isSupported(): boolean;
}

interface ApexExperiments {
    getServerAssignment(kind: string, unitId: string, name: string): unknown;
}

interface DiagnosticStore {
    [method: string]: unknown;
}

const RTCRegionStore: RegionStore = findStoreLazy("RTCRegionStore");
const MediaEngineStore: MediaEngineStore = findStoreLazy("MediaEngineStore");
const ApexExperimentStore: ApexExperiments & DiagnosticStore = findStoreLazy("ApexExperimentStore");
const ApplicationStreamingStore: DiagnosticStore = findStoreLazy("ApplicationStreamingStore");
const StreamRTCConnectionStore: DiagnosticStore = findStoreLazy("StreamRTCConnectionStore");
const RTCConnectionStore: DiagnosticStore = findStoreLazy("RTCConnectionStore");

const VIDEO_GUARD = "2026-08-video-guard";

const AUTOMATIC = "";
const VOICE_KEYS: "voiceRegion"[] = ["voiceRegion"];
const STREAM_KEYS: "streamRegion"[] = ["streamRegion"];

let original: RegionStore | undefined;
let streamClaimTimer: ReturnType<typeof setInterval> | null = null;
let streamClaimState: StreamClaimState = initialStreamClaimState();
let streamClaimStatus = "idle";
let streamClaimProbeFailed = false;
let lastStreamObservationKey: string | null = null;
let lastStreamObservation: {
    status: StreamObservationStatus;
    visibleStreamCount: number | null;
    nativeStreamCount: number | null;
} | null = null;
let lastSelectedStreamRegion: string | null = null;
let presenceStatusTimer: ReturnType<typeof setInterval> | null = null;
let routeCheckTimer: ReturnType<typeof setInterval> | null = null;
let initialRouteCheckTimer: ReturnType<typeof setTimeout> | null = null;
let lastVpnNotification: { state: string; active: boolean; routeId: string | null } | null = null;

function notifyVpnStatus(status: Partial<PluginVpnStatus> | null): void {
    if (!status || typeof status.state !== "string" || typeof status.active !== "boolean") return;
    const routeId = typeof status.routeId === "string" ? status.routeId : null;
    const previous = lastVpnNotification;
    const changed = !previous || previous.state !== status.state || previous.active !== status.active || previous.routeId !== routeId;
    if (!changed) return;
    lastVpnNotification = { state: status.state, active: status.active, routeId };

    const route = status.routeLabel || status.routeCity || status.routeCountry || status.routeId || "rota atual";
    const toastType = (Toasts.Type as { WARNING?: unknown }).WARNING ?? Toasts.Type.MESSAGE;
    if (status.active && (!previous?.active || previous.routeId !== routeId)) {
        const ping = typeof status.pingMs === "number" ? ` (${Math.round(status.pingMs)} ms)` : "";
        showToast(`VPN conectada pela ${route}${ping}.`, Toasts.Type.SUCCESS);
    } else if (!status.active && previous?.active) {
        showToast("VPN desconectada. O tráfego voltou para a rede normal.", toastType);
    } else if (status.state === "blocked_external" || status.state === "recovery_required") {
        showToast(`VPN não iniciou: ${status.message || status.externalReason || "é necessária uma recuperação"}.`, Toasts.Type.FAILURE);
    }
}

async function checkRouteAutomatically(): Promise<void> {
    if (!Native) return;
    try {
        const result = await Native.autoOptimizeRoute();
        if (result?.changed === true) {
            const selected = result.selectedServer || result.server || "uma rota alternativa";
            const load = typeof result.currentLoad === "number" ? ` (carga anterior: ${result.currentLoad}%)` : "";
            showToast(`Rota limpa ativada: ${selected}${load}. Discord continua conectado.`, Toasts.Type.SUCCESS);
            await refreshPresenceStatus();
        } else if (result?.checked === true && typeof result.currentLoad === "number" && result.currentLoad > 70) {
            const candidates = typeof result.pingCandidates === "number" ? ` Foram comparadas ${result.pingCandidates} rotas de menor carga.` : "";
            showToast(`Rota atual acima de 70% (${Math.round(result.currentLoad)}%). Não foi possível trocar a rota.${candidates}`, (Toasts.Type as { WARNING?: unknown }).WARNING ?? Toasts.Type.MESSAGE);
        }
    } catch (error) {
        logger.error("Falha na verificação automática de rota", error);
    }
}

function startAutomaticRouteMonitor(): void {
    if (routeCheckTimer !== null) return;
    // Dá tempo para o túnel terminar de subir antes da primeira consulta.
    initialRouteCheckTimer = setTimeout(() => void checkRouteAutomatically(), 12_000);
    routeCheckTimer = setInterval(() => void checkRouteAutomatically(), 90 * 60 * 1000);
}

function stopAutomaticRouteMonitor(): void {
    if (initialRouteCheckTimer !== null) clearTimeout(initialRouteCheckTimer);
    if (routeCheckTimer !== null) clearInterval(routeCheckTimer);
    initialRouteCheckTimer = null;
    routeCheckTimer = null;
}

async function refreshPresenceStatus(): Promise<void> {
    if (!Native) return;
    try {
        const status = await Native.getVpnStatus() as PluginVpnStatus;
        notifyVpnStatus(status);
        if (status.active === true) {
            startPresence(status.routeId, status.routeCountry, status.routeCity, status.pingMs);
            updateRouteInfo(status.routeId, status.routeCountry, status.routeCity, status.pingMs);
        } else {
            stopPresence();
        }
    } catch (error) {
        logger.error("Falha ao atualizar o status global do Presence", error);
    }
}

interface RegionSelectProps {
    value: string;
    placeholder: string;
    automaticLabel: string;
    onChange(region: string): void;
}

function RegionSelect({ value, placeholder, automaticLabel, onChange }: RegionSelectProps) {
    const [regions, error, pending] = useAwaiter(
        async () => {
            const { body } = await RestAPI.get({ url: Constants.Endpoints.REGIONS() });
            return (body as VoiceRegion[]).filter(region => !region.deprecated && !region.custom);
        },
        { fallbackValue: [] as VoiceRegion[] }
    );

    if (pending) return <Paragraph>Loading the region list.</Paragraph>;
    if (error) return <Paragraph>Discord did not hand over the region list. Log in and reopen settings to try again.</Paragraph>;

    const options = [
        { label: automaticLabel, value: AUTOMATIC },
        ...regions.map(region => ({ label: region.optimal ? `${region.name}, optimal for you` : region.name, value: region.id }))
    ];

    return (
        <SearchableSelect
            placeholder={placeholder}
            maxVisibleItems={8}
            options={options}
            value={options.find(option => option.value === value)?.value}
            onChange={onChange}
            closeOnSelect
        />
    );
}

function VoiceRegionPicker() {
    const { voiceRegion } = settings.use(VOICE_KEYS);

    return (
        <RegionSelect
            value={voiceRegion}
            placeholder="Pick the region your calls should connect through"
            automaticLabel="Automatic, whatever Discord picks"
            onChange={region => settings.store.voiceRegion = region}
        />
    );
}

function StreamRegionPicker() {
    const { streamRegion } = settings.use(STREAM_KEYS);

    return (
        <RegionSelect
            value={streamRegion}
            placeholder="Pick the region your screen share should go through"
            automaticLabel="Same region as your call"
            onChange={region => settings.store.streamRegion = region}
        />
    );
}

function AboutPlugin() {
    return <VpnPanel />;
}

const settings = definePluginSettings({
    aboutSettings: {
        type: OptionType.COMPONENT,
        description: "Passo a passo rapido: 1) Entrar na conta Proton  ->  2) Otimizar rota  ->  3) Start Bypass",
        component: () => null
    },
    vpnDescription: {
        type: OptionType.COMPONENT,
        description: "Tunel VPN exclusivo do Discord. O restante do PC continua com a rede normal.",
        component: () => null
    },
    protonUsername: {
        type: OptionType.STRING,
        description: "Usuario ProtonVPN (seu login @proton.me ou o nome do app).",
        default: ""
    },
    protonCountry: {
        type: OptionType.STRING,
        description: "Paises preferidos (codigos de 2 letras, separados por virgula). Vazio = escolha automatica.",
        default: "",
        placeholder: "ex.: BR,US,NL",
        isValid: (value: string) => value.trim() === "" || value.trim().split(",").every(part => /^[A-Za-z]{2}$/.test(part.trim()))
            || "Formato errado. Use codigos de 2 letras separados por virgula: BR,US,NL"
    },
    protonFreeOnly: {
        type: OptionType.BOOLEAN,
        description: "Usar apenas servidores gratuitos da Proton (desligue se tiver conta Plus/Unlimited).",
        default: true
    },
    protonAutoPing: {
        type: OptionType.BOOLEAN,
        description: "Priorizar servidores com menor latencia (mais rapido, melhor qualidade de stream).",
        default: true
    },
    separadorVoz: {
        type: OptionType.COMPONENT,
        description: "Configuracoes de voz e Go Live (regioes dos servidores)",
        component: () => null
    },
    voiceRegion: {
        type: OptionType.COMPONENT,
        component: VoiceRegionPicker,
        default: AUTOMATIC
    },
    streamRegion: {
        type: OptionType.COMPONENT,
        component: StreamRegionPicker,
        default: AUTOMATIC
    }
});

interface PluginVpnStatus {
    state: string;
    active: boolean;
    message: string;
    externalReason: string | null;
    lastDiagnostic: { detail: string; ok: boolean; kind: string } | null;
    routeId: string | null;
    routeCountry: string | null;
    routeCity: string | null;
    routeLabel: string | null;
    pingMs: number | null;
}

interface ProtonRouteEntry {
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

function VpnPanel() {
    const [status, setStatus] = useState<PluginVpnStatus | null>(null);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [twoFactorCode, setTwoFactorCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [optimizing, setOptimizing] = useState(false);
    const [starting, setStarting] = useState(false);
    const [logoutBusy, setLogoutBusy] = useState(false);
    const [routes, setRoutes] = useState<ProtonRouteEntry[]>([]);
    const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
    const [loadingRoutes, setLoadingRoutes] = useState(false);
    const [applyingRoute, setApplyingRoute] = useState(false);

    const refresh = async () => {
        if (!Native) return;
        try {
            const [nextStatus, saved] = await Promise.all([Native.getVpnStatus(), Native.getProtonSettings()]);
            setStatus(nextStatus as PluginVpnStatus);
            notifyVpnStatus(nextStatus as PluginVpnStatus);
            const savedRecord = saved as { protonUsername?: unknown; sessionUsername?: unknown };
            const savedUsername = typeof savedRecord.protonUsername === "string" && savedRecord.protonUsername
                ? savedRecord.protonUsername
                : savedRecord.sessionUsername;
            if (!username && typeof savedUsername === "string" && savedUsername) setUsername(savedUsername);
        } catch (error) {
            logger.error("Falha ao ler o estado da VPN do plugin", error);
        }
    };

    useEffect(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), 5_000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (!Native) return;
        if (status?.active === true) {
            startPresence(status?.routeId, status?.routeCountry, status?.routeCity, status?.pingMs);
        } else if (status?.state === "blocked_external" || status?.state === "recovery_required") {
            stopPresence();
        }
    }, [status?.active, status?.state, Native, status?.routeId, status?.routeCountry, status?.routeCity, status?.pingMs]);

    useEffect(() => {
        updateRouteInfo(status?.routeId ?? null, status?.routeCountry ?? null, status?.routeCity ?? null, status?.pingMs ?? null);
    }, [status?.routeId, status?.routeCountry, status?.routeCity, status?.pingMs]);

    const login = async () => {
        if (!Native || busy || optimizing || starting || logoutBusy) return;
        setBusy(true);
        try {
            showToast("Iniciando login na Proton VPN...", Toasts.Type.MESSAGE);
            const result = await Native.loginProton({ username, password, twoFactorCode });
            if (!result.success) throw new Error(result.error || result.message || "Login Proton recusado.");
            setPassword("");
            setTwoFactorCode("");
            showToast("Logado na Proton. Subindo bypass automaticamente...", Toasts.Type.SUCCESS);
            startPresence();
            await refresh();
            if (Native) {
                const enabled = await Native.enable(false);
                if (enabled.success === false) {
                    showToast(
                        `Logado, mas bypass ainda nao ativado: ${enabled.error || enabled.message || "clique em Start Bypass"}`,
                        (Toasts.Type as { WARNING?: unknown }).WARNING ?? Toasts.Type.MESSAGE
                    );
                } else {
                    showToast("Login OK + bypass ativado.", Toasts.Type.SUCCESS);
                }
                await refresh();
            }
        } catch (error) {
            showToast(`Login Proton: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    const optimize = async () => {
        if (!Native || busy || optimizing || starting || logoutBusy || loadingRoutes || applyingRoute) return;
        setOptimizing(true);
        try {
            showToast("Iniciando verificação das rotas Proton...", Toasts.Type.MESSAGE);
            const result = await Native.optimizeProtonRoute({
                requestId: `plugin-${Date.now()}`,
                speedTest: true,
                country: settings.store.protonCountry,
                freeOnly: settings.store.protonFreeOnly,
                autoPing: settings.store.protonAutoPing
            });
            if (!result.success) throw new Error(result.error || "Não foi possível otimizar a rota Proton.");
            showToast("Rota Proton otimizada. O Discord sera reiniciado para aplicar o tunel.", Toasts.Type.SUCCESS);
            await refresh();
        } catch (error) {
            showToast(`Otimizacao Proton: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            setOptimizing(false);
        }
    };

    const loadRoutes = async () => {
        if (!Native || loadingRoutes || applyingRoute) return;
        setLoadingRoutes(true);
        try {
            showToast("Consultando todas as rotas Proton...", Toasts.Type.MESSAGE);
            const result = await Native.listAvailableProtonServers() as { success?: boolean; servers?: ProtonRouteEntry[]; error?: string };
            if (!result?.success) throw new Error(result?.error || "Não conseguiu listar as rotas Proton.");
            const list = Array.isArray(result.servers) ? result.servers : [];
            setRoutes(list);
            if (selectedRouteId == null && status?.routeId) {
                const current = list.find(r => r.id.toLowerCase() === String(status.routeId).toLowerCase() || r.name.toLowerCase() === String(status.routeId).toLowerCase());
                if (current) setSelectedRouteId(current.id);
            }
            showToast(`Encontradas ${list.length} rotas Proton disponiveis.`, Toasts.Type.SUCCESS);
        } catch (error) {
            showToast(`Lista de rotas: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            setLoadingRoutes(false);
        }
    };

    const applyRoute = async () => {
        if (!Native || busy || optimizing || starting || logoutBusy || applyingRoute || !selectedRouteId) return;
        const chosen = routes.find(r => r.id === selectedRouteId);
        if (!chosen) {
            showToast("Selecione uma rota da lista primeiro.", Toasts.Type.FAILURE);
            return;
        }
        setApplyingRoute(true);
        setBusy(true);
        try {
            showToast(`Conectando à rota ${chosen.country} - ${chosen.city || chosen.name}...`, Toasts.Type.MESSAGE);
            const result = await Native.applySelectedProtonRoute({ country: chosen.country, serverId: chosen.name }) as { success?: boolean; error?: string; message?: string };
            if (result?.success === false) throw new Error(result.error || result.message || "Não conseguiu aplicar a rota selecionada.");
            showToast(`Rota ${chosen.country} - ${chosen.city || chosen.name} aplicada. Reiniciando tunel...`, Toasts.Type.SUCCESS);
            await refresh();
        } catch (error) {
            showToast(`Aplicar rota: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            setApplyingRoute(false);
            setBusy(false);
        }
    };

    const startBypass = async () => {
        if (!Native || busy || optimizing || starting || logoutBusy || loadingRoutes || applyingRoute) return;
        setStarting(true);
        setBusy(true);
        try {
            showToast("Iniciando o túnel VPN...", Toasts.Type.MESSAGE);
            startPresence();
            const result = await Native.enable(false) as { success?: boolean; error?: string; message?: string; state?: string };
            if (result.success === false) {
                if (result.state === "blocked_external" || /outro perfil|GUI|plugin|externo/i.test(String(result.error || result.message || ""))) {
                    stopPresence();
                }
                throw new Error(result.error || result.message || "Não foi possível ativar o bypass.");
            }
            showToast("Bypass ativado - VPN em tunel isolado.", Toasts.Type.SUCCESS);
            await refresh();
        } catch (error) {
            showToast(`Start Bypass: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            setStarting(false);
            setBusy(false);
        }
    };

    const recoverAndStart = async () => {
        if (!Native || busy || optimizing || starting || logoutBusy || loadingRoutes || applyingRoute) return;
        setStarting(true);
        setBusy(true);
        try {
            showToast("Iniciando recuperação e conexão do túnel...", Toasts.Type.MESSAGE);
            const typed = Native as PluginNative<typeof import("./native")>;
            const result = await typed.recoverAndStart() as { success?: boolean; error?: string; message?: string };
            if (result.success === false) throw new Error(result.error || result.message || "Não foi possível recuperar o WireSock.");
            startPresence();
            showToast("WireSock recuperado e bypass ativado usando o perfil existente.", Toasts.Type.SUCCESS);
            await refresh();
        } catch (error) {
            stopPresence();
            showToast(`Recuperar bypass: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            setStarting(false);
            setBusy(false);
        }
    };

    const logout = async () => {
        if (!Native || busy || optimizing || starting || logoutBusy || loadingRoutes || applyingRoute) return;
        setLogoutBusy(true);
        setBusy(true);
        try {
            showToast("Encerrando a VPN e desconectando da Proton...", Toasts.Type.MESSAGE);
            stopPresence();
            const typed = Native as PluginNative<typeof import("./native")>;
            const result = await typed.fullLogout();
            if (!result.success) {
                const msg = result.error || "Logout teve falhas parciais — tente rodar o 0-LIMPAR-WIRESOCK.bat.";
                logger.warn("fullLogout retornou parcial:", result);
                showToast(`Sair: ${msg}`, Toasts.Type.FAILURE);
            } else {
                showToast("Deslogado — VPN encerrada, serviços WireSock removidos e conta Proton desconectada.", Toasts.Type.SUCCESS);
                logger.info("fullLogout concluido:", result);
            }
            setUsername("");
            setPassword("");
            setTwoFactorCode("");
            await refresh();
        } catch (error) {
            showToast(`Sair: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        } finally {
            setLogoutBusy(false);
            setBusy(false);
        }
    };

    const disabledAll = busy || optimizing || starting || logoutBusy || loadingRoutes || applyingRoute;

    let statusLabel = "Inativo";
    let statusColor = "var(--text-normal)";
    let statusBg = "var(--background-secondary)";
    if (!Native) {
        statusLabel = "Inativo (componente desktop nao carregado - injete o plugin e reabra o Discord)";
    } else if (status?.active) {
        statusColor = "var(--text-positive)";
        statusBg = "color-mix(in srgb, var(--info-positive-foreground) 14%, var(--background-secondary))";
        const ping = status.pingMs;
        const pingText = typeof ping === "number" && Number.isFinite(ping) ? `${Math.round(ping)} ms` : "-- ms";
        const routeText = status.routeLabel
            || (status.routeCountry ? (status.routeCity ? `${status.routeCountry} - ${status.routeCity}` : status.routeCountry) : status.routeId)
            || "desconhecida";
        statusLabel = `Ativo | ${routeText} | ${pingText}`;
    } else if (status?.state === "blocked_external") {
        statusColor = "var(--text-danger)";
        statusBg = "color-mix(in srgb, var(--info-danger-background) 55%, var(--background-secondary))";
        statusLabel = "Bloqueado (WireSock de outro app ativo)";
    } else if (status?.state === "recovery_required") {
        statusColor = "var(--text-warning)";
        statusBg = "color-mix(in srgb, var(--info-warning-foreground) 18%, var(--background-secondary))";
        statusLabel = "Recuperacao necessaria";
    } else {
        const hasConfig = Boolean(status?.profilePath) || Boolean(status?.configPath);
        const hasUser = (settings.store.protonUsername as unknown as string || "").trim() !== "";
        if (!hasConfig && !hasUser) {
            statusLabel = "Aguardando login Proton";
        } else if (!hasConfig && hasUser) {
            statusLabel = "Logado — clique em Otimizar rotas para gerar o tunel";
        } else if (status?.message) {
            statusLabel = status.message;
        }
    }

    const routeOptions = routes.length > 0
        ? [
              { label: "Selecione uma rota da lista", value: "__none__" },
              ...routes.map(route => {
                  const hasPing = typeof route.pingMs === "number" && Number.isFinite(route.pingMs);
                  const ping = hasPing ? Math.round(route.pingMs!) : null;
                  const pingText = ping !== null ? `${ping}ms` : "--ms";
                  const parts: string[] = [];
                  parts.push(pingText);
                  parts.push(route.country.toUpperCase());
                  if (route.city) parts.push(route.city);
                  parts.push(route.name);
                  if (typeof route.load === "number" && Number.isFinite(route.load)) parts.push(`carga ${Math.round(route.load)}%`);
                  const label = parts.join(" | ");
                  return { label, value: route.id };
              }),
          ]
        : [{ label: loadingRoutes ? "Carregando rotas..." : "Clique em Atualizar rotas para listar", value: "__none__" }];

    return (
        <section style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <Paragraph style={{ margin: 0, padding: "10px 12px", borderRadius: "8px", background: statusBg, color: statusColor, fontSize: "14px", fontWeight: 600 }}>
                <strong>Status:</strong> {statusLabel}
            </Paragraph>

            {Native && status?.state === "blocked_external" && (
                <Paragraph style={{ margin: 0, padding: "8px 10px", borderRadius: "6px", background: "color-mix(in srgb, var(--info-danger-background) 40%, transparent)", color: "var(--text-danger)", fontSize: "13px" }}>
                    WireSock de outro app ativo - feche a GUI antiga e rode o arquivo <strong>0-LIMPAR-WIRESOCK.bat</strong> como administrador.
                </Paragraph>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "14px", borderRadius: "10px", border: "1px solid var(--background-modifier-accent)" }}>
                <Paragraph style={{ margin: 0, fontWeight: 700, fontSize: "15px" }}>Conta Proton VPN</Paragraph>

                <TextInput value={username} onChange={setUsername} placeholder="E-mail ou usuario Proton (ex: voce@proton.me)" disabled={disabledAll} />
                <TextInput value={password} onChange={setPassword} placeholder="Senha OpenVPN/IKEv2 (NAO e a senha da conta - pegue em account.protonvpn.com/downloads)" type="password" disabled={disabledAll} />
                <TextInput value={twoFactorCode} onChange={setTwoFactorCode} placeholder="Codigo 2FA (deixa em branco se nao usar)" disabled={disabledAll} />

                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "4px" }}>
                    <Button onClick={() => void login()} disabled={disabledAll || !username.trim()} look={Button.Looks.FILLED ?? undefined}>
                        {busy ? "Entrando..." : "Logar"}
                    </Button>{" "}
                    <Button onClick={() => void logout()} disabled={disabledAll} look={Button.Looks.LINK ?? undefined}>
                        {logoutBusy ? "Saindo..." : "Sair"}
                    </Button>
                </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "14px", borderRadius: "10px", border: "1px solid var(--background-modifier-accent)" }}>
                <Paragraph style={{ margin: 0, fontWeight: 700, fontSize: "15px" }}>Bypass</Paragraph>
                <Paragraph style={{ margin: 0, color: "var(--text-muted)", fontSize: "13px" }}>
                    O login Proton ativa o bypass automaticamente. Use Start Bypass apenas para tentar novamente se a ativação falhar.
                </Paragraph>

                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <Button onClick={() => void optimize()} disabled={disabledAll || !username.trim()} look={Button.Looks.OUTLINED ?? undefined}>
                        {optimizing ? "Otimizando rotas..." : "Otimizar rotas"}
                    </Button>{" "}
                    <Button onClick={() => void startBypass()} disabled={disabledAll || status?.active === true || !Native} look={Button.Looks.FILLED ?? undefined}>
                        {!Native
                            ? "Reabra o Discord"
                            : status?.active === true
                                ? "Bypass ja ativo"
                                : starting
                                    ? "Subindo tunel..."
                                    : "Start Bypass"}
                    </Button>
                    <Button onClick={() => void recoverAndStart()} disabled={disabledAll || !Native || !username.trim()} look={Button.Looks.OUTLINED ?? undefined}>
                        {starting ? "Recuperando..." : "Recuperar e ativar"}
                    </Button>
                </div>
            </div>

            {Native && username.trim() && (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "14px", borderRadius: "10px", border: "1px solid var(--background-modifier-accent)" }}>
                    <Paragraph style={{ margin: 0, fontWeight: 700, fontSize: "15px" }}>Rotas disponiveis</Paragraph>
                    <Paragraph style={{ margin: 0, color: "var(--text-muted)", fontSize: "13px" }}>
                        Lista de servidores Proton com ping e carga. Selecione uma rota e clique em Aplicar rota para trocar.
                    </Paragraph>

                    <SearchableSelect
                        placeholder={loadingRoutes ? "Carregando rotas..." : routes.length > 0 ? "Selecione uma rota" : "Clique em Atualizar rotas"}
                        maxVisibleItems={10}
                        options={routeOptions}
                        value={selectedRouteId ?? "__none__"}
                        onChange={(value: string) => setSelectedRouteId(value === "__none__" ? null : value)}
                        closeOnSelect
                    />

                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                        <Button onClick={() => void loadRoutes()} disabled={disabledAll} look={Button.Looks.OUTLINED ?? undefined}>
                            {loadingRoutes ? "Atualizando..." : "Atualizar rotas"}
                        </Button>{" "}
                        <Button onClick={() => void applyRoute()} disabled={disabledAll || !selectedRouteId || routes.length === 0} look={Button.Looks.FILLED ?? undefined}>
                            {applyingRoute ? "Aplicando..." : "Aplicar rota"}
                        </Button>
                    </div>
                </div>
            )}

            <Paragraph style={{ color: "var(--text-muted)", fontSize: "12px", margin: 0 }}>
                O bypass sobe automaticamente quando o Discord abre. Se trocar de pais ou servidor, clique em Otimizar rotas.
            </Paragraph>
        </section>
    );
}

function forcedRegion() {
    const region = settings.store.voiceRegion;
    if (typeof region !== "string") return null;

    const trimmed = region.trim();
    return trimmed === AUTOMATIC ? null : trimmed;
}

function forceRegion() {
    if (original !== undefined) return;

    const store = RTCRegionStore;
    if (typeof store.getPreferredRegion !== "function"
        || typeof store.getPreferredRegions !== "function"
        || typeof store.shouldIncludePreferredRegion !== "function") {
        showToast("Lefferzin Bypass: não conseguiu encontrar o selecionador de região do Discord — sua região de chamada não foi alterada.", Toasts.Type.FAILURE);
        return;
    }

    const saved: RegionStore = {
        getPreferredRegion: store.getPreferredRegion,
        getPreferredRegions: store.getPreferredRegions,
        shouldIncludePreferredRegion: store.shouldIncludePreferredRegion
    };

    store.getPreferredRegion = function () {
        return forcedRegion() ?? saved.getPreferredRegion.call(this);
    };

    store.getPreferredRegions = function () {
        const forced = forcedRegion();
        const ranked = saved.getPreferredRegions.call(this);
        return forced === null ? ranked : [forced, ...(ranked ?? []).filter(region => region !== forced)];
    };

    store.shouldIncludePreferredRegion = function () {
        return forcedRegion() !== null || saved.shouldIncludePreferredRegion.call(this);
    };

    original = saved;
}

function restoreRegion() {
    if (original === undefined) return;

    RTCRegionStore.getPreferredRegion = original.getPreferredRegion;
    RTCRegionStore.getPreferredRegions = original.getPreferredRegions;
    RTCRegionStore.shouldIncludePreferredRegion = original.shouldIncludePreferredRegion;
    original = undefined;
}

function videoIsBlocked() {
    const user = UserStore.getCurrentUser();
    if (user == null) return false;

    const assignment = ApexExperimentStore.getServerAssignment("user", user.id, VIDEO_GUARD);
    if (assignment === null || typeof assignment !== "object") return false;

    // As duas variacoes do experimento desligam video; o balde de controle nao tem nenhuma
    // delas. Ler supportsInApp aqui seria inutil: o patch do plugin deixa esse valor sempre
    // verdadeiro, e a checagem nunca detectaria bloqueio nenhum.
    const { variantId } = assignment as { variantId?: unknown; };
    return variantId === 1 || variantId === 2;
}

// O Logger do Vencord so aparece no console do DevTools, que ninguem abre para relatar um
// problema. Isto vai para o mesmo arquivo do processo principal, entao o registro conta a
// historia inteira num lugar so.
function record(message: string) {
    logger.info(message);
    Native?.logFromRenderer(message).catch(() => {
        // Sem o registro em arquivo ainda resta o console; nao vale quebrar o fluxo por isso.
    });
}

// O que so o renderer enxerga. Sem isto o arquivo mostraria qual saida subiu, mas nunca se o
// servidor aceitou, que e a pergunta que importa.
function recordSession() {
    const user = UserStore.getCurrentUser();
    const assignment = user == null ? "sem usuario" : ApexExperimentStore.getServerAssignment("user", user.id, VIDEO_GUARD);

    record(`sessao aberta | atribuicao do video guard: ${JSON.stringify(assignment)}`);
    record(`  o cliente aceita video? supports ${ask(MediaEngineStore, "supports", "VIDEO")} | supportsInApp ${ask(MediaEngineStore, "supportsInApp", "VIDEO")} | desktop ${ask(MediaEngineStore, "supportsInApp", "DESKTOP_CAPTURE")}`);
    record(`  regiao preferida ${ask(RTCRegionStore, "getPreferredRegion")} | lista ${JSON.stringify(ask(RTCRegionStore, "getPreferredRegions"))} | override instalado ${original !== undefined}`);
}

function reportSession() {
    recordSession();
    if (!Native) return;

    // A conexão do gateway não muda a rota: o túnel WireGuard já nasceu antes do
    // Discord conectar e continua isolado por aplicativo. Este registro é somente
    // diagnóstico e não tenta recarregar ou trocar a saída no meio da mídia.
    Native.getVpnStatus().then(status => {
        record(`sessao aberta | VPN ${status.state} | ativa ${status.active} | ownership ${status.owned}`);
        if (videoIsBlocked()) record("o servidor ainda reporta o guard de video; nenhuma troca automatica de rede foi feita");
    }).catch(error => logger.error("Falha ao consultar a VPN do plugin", error));
}

function ask(store: object, method: string, ...args: unknown[]) {
    const fn = (store as DiagnosticStore)[method];
    if (typeof fn !== "function") return "metodo ausente";

    try {
        return (fn as (...a: unknown[]) => unknown).apply(store, args) ?? null;
    } catch (error) {
        return `erro: ${error instanceof Error ? error.message : String(error)}`;
    }
}

function readStore(store: object, method: string) {
    const fn = (store as DiagnosticStore)[method];
    if (typeof fn !== "function") return { known: false as const, value: null };

    try {
        return { known: true as const, value: (fn as () => unknown).call(store) };
    } catch {
        return { known: false as const, value: null };
    }
}

function collectionCount(value: unknown): number | null {
    if (Array.isArray(value)) return value.length;
    if (value instanceof Set || value instanceof Map) return value.size;
    if (value !== null && typeof value === "object") {
        try {
            return Object.keys(value).length;
        } catch {
            return null;
        }
    }
    return null;
}

function observationText(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const clean = value.trim().replace(/[|\r\n]+/g, "_").slice(0, 200);
    return clean || null;
}

function observationHostname(value: unknown): string | null {
    const raw = observationText(value);
    if (!raw) return null;
    try {
        return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname || null;
    } catch {
        return raw;
    }
}

function readObservationText(store: object, method: string): string | null {
    const result = readStore(store, method);
    return result.known ? observationText(result.value) : null;
}

function readObservationHostname(store: object, method: string): string | null {
    const result = readStore(store, method);
    return result.known ? observationHostname(result.value) : null;
}

function configuredStreamRegion(): string | null {
    const configured = settings.store.streamRegion;
    return typeof configured === "string" && configured.trim() !== AUTOMATIC
        ? observationText(configured)
        : null;
}

// Guarda especifica para o falso "transmitindo"/erro 2001 visto no fogo da
// beta 13. Nao tenta inferir fps nem fechar sockets: as stores do renderer so
// provam que a UI afirma uma Live e se a conexao nativa de stream chegou a
// existir. Dado ausente falha fechado; a unica acao e um aviso manual.
function pollStreamClaimOnce() {
    const claimed = readStore(ApplicationStreamingStore, "getCurrentUserActiveStream");
    const visibleStreams = readStore(ApplicationStreamingStore, "getAllActiveStreams");
    const nativeKeys = readStore(StreamRTCConnectionStore, "getAllActiveStreamKeys");

    const senderClaimed = !claimed.known || claimed.value === undefined
        ? null
        : claimed.value !== null;
    if (senderClaimed === false) lastSelectedStreamRegion = null;
    const now = Date.now();
    const observation: StreamObservation = {
        now,
        senderClaimed,
        visibleStreamCount: visibleStreams.known ? collectionCount(visibleStreams.value) : null,
        nativeStreamCount: nativeKeys.known ? collectionCount(nativeKeys.value) : null,
        voiceState: readObservationText(RTCConnectionStore, "getState"),
        voiceHostname: readObservationHostname(RTCConnectionStore, "getHostname"),
        selectedRegion: lastSelectedStreamRegion ?? configuredStreamRegion(),
    };
    const observationDecision = evaluateStreamObservation(observation);
    lastStreamObservation = {
        status: observationDecision.status,
        visibleStreamCount: observation.visibleStreamCount,
        nativeStreamCount: observation.nativeStreamCount,
    };
    if (observationDecision.key !== lastStreamObservationKey) {
        lastStreamObservationKey = observationDecision.key;
        record(
            `stream.observation | status=${observationDecision.status}` +
            ` claimed=${observation.senderClaimed ?? "unknown"}` +
            ` visible=${observation.visibleStreamCount ?? "unknown"}` +
            ` native=${observation.nativeStreamCount ?? "unknown"}` +
            ` voice_state=${observation.voiceState ?? "unknown"}` +
            ` voice_host=${observation.voiceHostname ?? "unknown"}` +
            ` selected_region=${observation.selectedRegion ?? "automatic"}`
        );
    }

    const nativeStreamCount = nativeKeys.known ? collectionCount(nativeKeys.value) : null;
    const decision = evaluateStreamClaim({
        now, senderClaimed, nativeStreamCount
    }, streamClaimState);

    streamClaimState = decision.state;
    const previousStatus = streamClaimStatus;
    streamClaimStatus = decision.status;

    if (decision.warn) {
        record("stream.guard | UI afirma transmissao, mas nenhuma conexao nativa apareceu em 32s; possivel erro 2001, sem acao automatica");
        showToast(
            "Lefferzin Bypass: Discord diz que você está transmitindo, mas nenhuma conexão Live apareceu em 32s (possível erro 2001). Pare a transmissão falsa, recarregue com Ctrl+R e tente de novo.",
            Toasts.Type.FAILURE
        );
    } else if (previousStatus.startsWith("failed") && decision.status === "healthy") {
        record("stream.guard | conexao nativa apareceu depois do aviso; estado recuperado");
    }
}

function pollStreamClaim() {
    try {
        pollStreamClaimOnce();
        streamClaimProbeFailed = false;
    } catch (error) {
        // Watchdog e diagnostico: uma mudanca de store nunca pode derrubar o
        // renderer. Registra uma vez e continua tentando nos proximos ciclos.
        if (!streamClaimProbeFailed)
            logger.error("Failed to inspect the native stream state", error);
        streamClaimProbeFailed = true;
    }
}

function startStreamClaimWatch() {
    if (streamClaimTimer !== null) return;
    streamClaimState = initialStreamClaimState();
    streamClaimStatus = "idle";
    streamClaimProbeFailed = false;
    lastStreamObservationKey = null;
    lastStreamObservation = null;
    lastSelectedStreamRegion = null;
    pollStreamClaim();
    streamClaimTimer = setInterval(pollStreamClaim, 5_000);
}

function stopStreamClaimWatch() {
    if (streamClaimTimer !== null) clearInterval(streamClaimTimer);
    streamClaimTimer = null;
    streamClaimState = initialStreamClaimState();
    streamClaimStatus = "idle";
    streamClaimProbeFailed = false;
    lastStreamObservationKey = null;
    lastStreamObservation = null;
    lastSelectedStreamRegion = null;
}

async function buildReport() {
    const user = UserStore.getCurrentUser();
    const lines: string[] = ["Lefferzin Bypass, diagnostico"];

    lines.push("", "== o servidor te bloqueia? ==");
    lines.push(`atribuicao do video guard: ${JSON.stringify(user == null ? "sem usuario" : ask(ApexExperimentStore, "getServerAssignment", "user", user.id, VIDEO_GUARD))}`);

    lines.push("", "== o cliente consegue fazer video? ==");
    lines.push(`supports(VIDEO)          ${ask(MediaEngineStore, "supports", "VIDEO")}`);
    lines.push(`supportsInApp(VIDEO)     ${ask(MediaEngineStore, "supportsInApp", "VIDEO")}`);
    lines.push(`supportsInApp(DESKTOP)   ${ask(MediaEngineStore, "supportsInApp", "DESKTOP_CAPTURE")}`);
    lines.push(`motor de midia pronto    ${ask(MediaEngineStore, "isSupported")}`);

    lines.push("", "== transmissao ==");
    const observation = lastStreamObservation;
    lines.push(`observacao stream        ${observation
        ? `${observation.status} | visiveis ${observation.visibleStreamCount ?? "desconhecido"} | nativas ${observation.nativeStreamCount ?? "desconhecido"}`
        : "sem amostra"}`);
    lines.push(`estado da call           ${ask(RTCConnectionStore, "getState")} em ${ask(RTCConnectionStore, "getHostname")}`);
    lines.push(`guarda UI/conexao nativa ${streamClaimStatus}`);

    lines.push("", "== regiao ==");
    lines.push(`preferida  ${ask(RTCRegionStore, "getPreferredRegion")}`);
    lines.push(`lista      ${JSON.stringify(ask(RTCRegionStore, "getPreferredRegions"))}`);
    lines.push(`override instalado ${original !== undefined}`);

    lines.push("", "== configuracao ==");
    const { protonUsername, protonCountry, protonFreeOnly, protonAutoPing, voiceRegion, streamRegion } = settings.store;
    lines.push(`VPN Proton | usuário Proton "${protonUsername ? "definido" : "vazio"}" | países "${protonCountry}" | somente grátis ${protonFreeOnly} | auto-ping ${protonAutoPing} | região de call "${voiceRegion}" | região de stream "${streamRegion}"`);

    lines.push("", "== processo principal ==");
    if (!Native) {
        lines.push("indisponivel, o plugin esta rodando sem a parte desktop");
    } else {
        try {
            const status = await Native.getVpnStatus();
            lines.push(`VPN agora: ${status.state} | ativa ${status.active} | ownership ${status.owned} | geração ${status.generation}`);
            if (status.externalReason) lines.push(`motivo externo: ${status.externalReason}`);
            if (status.lastDiagnostic) lines.push(`último diagnóstico: ${status.lastDiagnostic.kind} | ok ${status.lastDiagnostic.ok} | ${status.lastDiagnostic.detail}`);
            lines.push(await Native.getLog() || "sem registros");
        } catch (error) {
            lines.push(`nao consegui falar com o processo principal: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return lines.join("\n");
}

export default definePlugin({
    name: "LefferzinBypass",
    enabledByDefault: true,
    description: "Devolve o Go Live e a câmera para contas bloqueadas, com VPN WireGuard isolada só para este Discord.",
    authors: [{ name: "L3ffer_", id: 406595579603451914n }],
    tags: ["Voz", "Privacidade"],
    settings,
    settingsAboutComponent: AboutPlugin,

    patches: [
        {
            find: "\"2026-08-video-guard\"",
            replacement: {
                match: /(?<=name:"2026-08-video-guard".{0,100}?)variations:\{.{0,120}?\}\}(?=\}\))/,
                replace: "variations:{}"
            }
        },
        {
            find: ".STREAM_CREATE,{type:",
            replacement: {
                match: /(?<=\.STREAM_CREATE,\{.{0,80}?preferred_region:)\i/,
                replace: "$self.pickStreamRegion($&)"
            }
        }
    ],

    pickStreamRegion(fallback: string | null) {
        const region = settings.store.streamRegion;
        const selected = typeof region === "string" && region !== AUTOMATIC ? region : fallback;
        lastSelectedStreamRegion = observationText(selected);
        return selected;
    },

    commands: [
        {
            name: "golivebypass",
            description: "Copia um diagnostico do plugin para voce colar no suporte.",
            async execute(_args, ctx) {
                const report = await buildReport();
                copyWithToast(report, "Diagnostico copiado. Cole no canal de suporte.");
                sendBotMessage(ctx.channel.id, { content: `\`\`\`\n${report.slice(0, 1800)}\n\`\`\`` });
            }
        }
    ],

    flux: {
        CONNECTION_OPEN() {
            reportSession();
        },

        LOGOUT() {
            record("voce saiu da conta; a VPN do plugin permanece isolada e nao troca a rota automaticamente");
        }
    },

    start() {
        forceRegion();
        startStreamClaimWatch();
        if (!Native) return;
        void refreshPresenceStatus();
        presenceStatusTimer = setInterval(() => void refreshPresenceStatus(), 5_000);
            Native.getProtonSettings().then(settings => {
            const hasUsername = typeof settings?.protonUsername === "string" && settings.protonUsername.trim() !== "";
            const hasSession = typeof (settings as { sessionUsername?: unknown })?.sessionUsername === "string"
                && (settings as { sessionUsername: string }).sessionUsername.trim() !== "";
            if (!hasUsername && !hasSession) return;
            startPresence();
            void Native.enable(false).then(result => {
                if (result?.success === true) {
                    startPresence(settings.activatedRouteId ?? null, settings.routeCountry ?? null, settings.routeCity ?? null, settings.pingMs ?? null);
                    startAutomaticRouteMonitor();
                    void refresh();
                } else {
                    void refresh();
                    showToast(`Lefferzin Bypass não conseguiu ativar a VPN: ${result?.error || result?.message || "rode o 0-LIMPAR-WIRESOCK.bat"}`, Toasts.Type.FAILURE);
                }
            }).catch(error => {
                logger.error("Não conseguiu falar com o processo desktop", error);
            });
        }).catch(() => {});
    },

    stop() {
        if (presenceStatusTimer) {
            clearInterval(presenceStatusTimer);
            presenceStatusTimer = null;
        }
        stopAutomaticRouteMonitor();
        stopPresence();
        stopStreamClaimWatch();
        restoreRegion();
        // Desativar o plugin só pode parar a sessão que ele consegue provar
        // que é sua. O wipe global é destrutivo e fica reservado ao botão de
        // recuperação/logout explícito.
        Native?.shutdown(false).catch(error => logger.error("shutdown do WireSock falhou", error));
    }
});
