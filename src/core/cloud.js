/**
 * core/cloud.js — Sincronização cloud: ofuscação, gestão de configs API e
 * operações genéricas fetch/save/remove contra o backend Cloudflare Worker.
 *
 * Nota: a "encriptação" das configs é apenas ofuscação XOR + base64 —
 * protege contra leitura casual do GM_storage, não é um esquema criptográfico.
 * A chave real (x-api-key) viaja sempre por header HTTPS, nunca pelo body.
 *
 * Source of truth: filmin.user.js
 * Used by: filmin, filmtwist, pandaplus, tvcine, zigzag
 *
 * Usage:
 *   const cloud = createCloudSync({ obfKey: "FLM_SEC_KEY_24", storeApiConfigsKey: "filmin_api_configs" });
 *   const configs = cloud.getApiConfigs();
 *
 *   const result = await fetchCloudStores({ configs, storeKeys, getApiColor: cloud.getApiColor });
 *   const { pushed } = await saveStoresToCloud({ configs, storeKeys, getStored, mergeData, mergeDataPreferNewest, getApiColor: cloud.getApiColor });
 *   await removeUrlFromCloud({ configs, storeKeys, url });
 */

import { mergeData, mergeDataPreferNewest } from "./merge.js";

/** Default fetch timeout (ms) and retry settings — adjustable per call. */
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES    = 1;
const RETRY_BACKOFF_MS   = 500;

/**
 * Lê o header Retry-After e devolve o atraso em ms (suporta segundos e data HTTP).
 * Devolve null se o header estiver ausente, mal formado ou indicar o passado.
 * Exportado para testes — em produção, só fetchWithRetry o usa.
 */
export function _parseRetryAfter(res) {
    const raw = res.headers.get("Retry-After");
    if (!raw) return null;
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60000);
    const when = Date.parse(raw);
    if (Number.isFinite(when)) {
        const delta = when - Date.now();
        return delta > 0 ? Math.min(delta, 60000) : 0;
    }
    return null;
}

/**
 * fetchWithRetry() com timeout via AbortController e 1 retry em erros de rede transitórios.
 * NÃO faz retry em respostas 4xx (são erros aplicacionais, não transitórios),
 * exceto em 429 (rate limit) se houver Retry-After razoável.
 * Faz retry em: AbortError (timeout), TypeError (falha de rede), 5xx e 429.
 * Respeita o header Retry-After quando presente.
 */
async function fetchWithRetry(url, opts = {}, {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries   = DEFAULT_RETRIES,
} = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(url, { ...opts, signal: ctrl.signal });
            clearTimeout(timer);
            // 5xx e 429 (rate limit) são transitórios — vale a pena repetir.
            const isTransient = (res.status >= 500 && res.status < 600) || res.status === 429;
            if (isTransient && attempt < retries) {
                const retryAfter = _parseRetryAfter(res);
                const delay = retryAfter != null ? retryAfter : RETRY_BACKOFF_MS * (attempt + 1);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            return res;
        } catch (err) {
            clearTimeout(timer);
            lastErr = err;
            // Erros de rede (TypeError) ou timeout (AbortError) — retry
            const transient = err.name === "AbortError" || err.name === "TypeError";
            if (transient && attempt < retries) {
                await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}

/**
 * Creates an API-config manager bound to a service-specific obfuscation key
 * and GM storage key.
 *
 * @param {{ obfKey: string, storeApiConfigsKey: string }} opts
 */
export function createCloudSync({ obfKey, storeApiConfigsKey }) {
    // Simple XOR obfuscation of the API key in GM_setValue.
    // Uses TextEncoder/TextDecoder for Unicode-safety (names with accents/emojis
    // no longer corrupt stored values — btoa() fails with chars > Latin1).
    function __obf(str) {
        const bytes  = new TextEncoder().encode(str);
        const kbytes = new TextEncoder().encode(obfKey);
        const out    = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ kbytes[i % kbytes.length];
        let bin = "";
        out.forEach(b => bin += String.fromCharCode(b));
        return btoa(bin);
    }

    function __deobf(b64) {
        try {
            const bin    = atob(b64);
            const bytes  = Uint8Array.from(bin, c => c.charCodeAt(0));
            const kbytes = new TextEncoder().encode(obfKey);
            const out    = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ kbytes[i % kbytes.length];
            return new TextDecoder().decode(out);
        } catch { return b64; }
    }

    function getApiConfigs() {
        const raw = GM_getValue(storeApiConfigsKey, "[]");
        if (raw === "[]") return [];
        try { return JSON.parse(raw.startsWith("[") ? raw : __deobf(raw)); } catch { return []; }
    }

    function setApiConfigs(configs) {
        GM_setValue(storeApiConfigsKey, __obf(JSON.stringify(configs)));
    }

    function getApiColor(apiName, configs = null) {
        if (!configs) configs = getApiConfigs();
        const api = configs.find(c => c.name === apiName);
        if (api?.apiKey) return "#3b82f6";
        let hash = 0;
        for (let i = 0; i < apiName.length; i++) hash = apiName.charCodeAt(i) + ((hash << 5) - hash);
        const HUES = [0, 190, 240, 265, 290, 315, 340, 355];
        return `hsl(${HUES[Math.abs(hash) % HUES.length]}, 85%, 65%)`;
    }

    return { getApiConfigs, setApiConfigs, getApiColor };
}

/**
 * Fetches all store keys from all configured clouds in parallel.
 *
 * @param {{ configs, storeKeys: string[], extraFieldKey: string|null, getApiColor }} opts
 * @returns {{ cloudSaves, cloudFullData, cloudExtraFields }}
 */
export async function fetchCloudStores({ configs, storeKeys, extraFieldKey = null, getApiColor }) {
    const nextSaves       = {};
    const nextFull        = [];
    const nextExtraFields = [];

    const keysParam = extraFieldKey
        ? [...storeKeys, extraFieldKey].join(",")
        : storeKeys.join(",");

    await Promise.all(configs.map(async (api) => {
        try {
            const hdrs = api.apiKey ? { "x-api-key": api.apiKey } : undefined;
            const res  = await fetchWithRetry(`${api.url}?keys=${keysParam}`, { headers: hdrs });
            if (!res.ok) return;
            const data = await res.json();
            if (!data || typeof data !== "object" || Array.isArray(data)) return;

            for (const key of storeKeys) {
                const arr = data[key];
                if (!Array.isArray(arr)) continue;
                arr.forEach(item => {
                    nextFull.push({ ...item, apiName: api.name, apiColor: getApiColor(api.name, configs), listType: key });
                    if (!nextSaves[item.url]) nextSaves[item.url] = [];
                    if (!nextSaves[item.url].includes(api.name)) nextSaves[item.url].push(api.name);
                });
            }
            if (extraFieldKey && Array.isArray(data[extraFieldKey])) {
                nextExtraFields.push(...data[extraFieldKey]);
            }
        } catch (err) { console.error(`Falha no GET para ${api.name}:`, err); }
    }));

    return {
        cloudSaves:       nextSaves,
        cloudFullData:    nextFull.sort((a, b) => (b.saved_at || 0) - (a.saved_at || 0)),
        cloudExtraFields: nextExtraFields,
    };
}

/**
 * Pushes all local stores to each configured cloud (requires apiKey).
 * Merges with existing cloud data before writing.
 *
 * @param {{ configs, storeKeys: string[], extraFieldKey: string|null,
 *            getStored, getApiColor }} opts
 * @returns {{ pushed: number }}
 */
export async function saveStoresToCloud({ configs, storeKeys, extraFieldKey = null, getStored, getApiColor }) {
    const keysParam = extraFieldKey
        ? [...storeKeys, extraFieldKey].join(",")
        : storeKeys.join(",");

    const results = await Promise.all(configs.map(async (api) => {
        if (!api.apiKey) return false;
        try {
            const getRes = await fetchWithRetry(`${api.url}?keys=${keysParam}`, {
                headers: { "x-api-key": api.apiKey },
            });
            if (!getRes.ok) throw new Error(`GET falhou ${getRes.status}`);

            let cloudData = {};
            try { cloudData = await getRes.json() || {}; } catch { /* ignora JSON inválido */ }

            const payload = {};
            for (const key of storeKeys) {
                payload[key] = mergeData([...(cloudData[key] || []), ...getStored(key)]);
            }
            if (extraFieldKey) {
                payload[extraFieldKey] = mergeDataPreferNewest([
                    ...(cloudData[extraFieldKey] || []),
                    ...getStored(extraFieldKey),
                ]);
            }

            const res = await fetchWithRetry(api.url, {
                method:  "POST",
                headers: { "Content-Type": "application/json", "x-api-key": api.apiKey },
                body:    JSON.stringify(payload),
            });
            if (res.ok) return true;
            console.warn(`Falha ao sincronizar com ${api.name} (${res.status})`);
            return false;
        } catch (err) {
            console.error(`Falha POST para ${api.name}:`, err);
            return false;
        }
    }));

    return { pushed: results.filter(Boolean).length };
}

/**
 * Removes a single URL from all store keys across all clouds.
 *
 * @param {{ configs, storeKeys: string[], extraFieldKey: string|null, url: string }} opts
 * @returns {{ cnt: number }}
 */
export async function removeUrlFromCloud({ configs, storeKeys, extraFieldKey = null, url }) {
    let cnt = 0;
    const keys = extraFieldKey ? [...storeKeys, extraFieldKey] : storeKeys;

    for (const api of configs) {
        if (!api.apiKey) continue;
        try {
            const res = await fetchWithRetry(api.url, {
                method:  "DELETE",
                headers: { "Content-Type": "application/json", "x-api-key": api.apiKey },
                body:    JSON.stringify({ url, keys }),
            });
            if (res.ok) cnt++;
            else console.warn(`Falha ao remover de ${api.name} (${res.status})`);
        } catch (err) { console.error(`Falha DELETE para ${api.name}:`, err); }
    }

    return { cnt };
}
