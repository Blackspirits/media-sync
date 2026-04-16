// ==UserScript==
// @name         TVCine — Gestor de Catálogo, Downloads & Sync Cloud
// @namespace    leinad4mind.top/forum
// @version      1.9.0
// @description  Conta e guarda filmes/séries do TVCine, sincroniza com Cloudflare Workers (multi-API), gere downloads e copiados, e apresenta uma Dashboard com filtros, posters, notas e exportação. Modifica também os links do header para incluir ?watch_more=1 e adiciona item "Destaques".
// @author       Leinad4Mind
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=tvcine.pt
// @match        https://tvcine.pt/*
// @match        https://www.tvcine.pt/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// ==/UserScript==
(function () {
    'use strict';

    /**
     * core/merge.js — Pure data-manipulation helpers (no side-effects, no globals).
     *
     * Source of truth: filmin.user.js
     * Used by: filmin, filmtwist, pandaplus, zigzag
     */

    const toObj = (item) => {
        if (!item) return null;
        if (typeof item === "string") return { url: item, title: "", poster: "" };
        if (typeof item === "object") return item;
        return null;
    };

    const safeTrim = (s) => String(s || "").trim();

    const isValidHttpUrl = (value) => {
        const v = safeTrim(value);
        if (!v || (!v.startsWith("http://") && !v.startsWith("https://"))) return false;
        try { new URL(v); return true; } catch { return false; }
    };

    /** Converts relative hrefs ("/filme/x") to absolute URLs */
    const toAbsUrl = (href, origin = location.origin) => {
        if (!href) return "";
        if (href.startsWith("http://") || href.startsWith("https://")) return href;
        try { return new URL(href, origin).toString(); } catch { return href; }
    };

    /** Removes query string and trailing slash */
    const normUrl = (urlStr) => {
        if (!urlStr) return "";
        const abs = toAbsUrl(urlStr);
        try {
            const u = new URL(abs);
            u.search = "";
            let final = u.toString();
            if (final.endsWith("/")) final = final.slice(0, -1);
            return final;
        } catch { return abs; }
    };

    /** Prefers a valid HTTP poster URL with longer path */
    const betterPoster = (n, o) => {
        const nn = safeTrim(n), oo = safeTrim(o);
        if (!nn || nn.length <= 8 || !isValidHttpUrl(nn)) return oo;
        return nn;
    };

    /**
     * Returns a betterTitle function.
     * Pass a suffixRe to strip service-specific title suffixes (e.g., "— Filmin").
     * Without suffixRe, falls back to choosing the longer of the two titles.
     */
    function makeBetterTitle(suffixRe = null) {
        return (n, o) => {
            let nn = safeTrim(n);
            let oo = safeTrim(o);
            if (suffixRe) { nn = nn.replace(suffixRe, "").trim(); oo = oo.replace(suffixRe, "").trim(); }
            if (!nn) return oo;
            if (!oo) return nn;
            if (nn.length >= 3 && nn !== oo) return nn;
            return oo;
        };
    }

    /** Default betterTitle: choose the longer of the two titles */
    const betterTitle = makeBetterTitle();

    /**
     * Merges arrays of items, deduplicating by normalised URL.
     * Preserves the oldest saved_at (correct for history/catalog stores).
     */
    function mergeData(arr, betterTitleFn = betterTitle) {
        const map = new Map();
        for (const raw of (arr || [])) {
            const item = toObj(raw);
            if (!item?.url) continue;
            const url = normUrl(item.url);
            if (!url) continue;
            const ex = map.get(url);
            if (!ex) {
                map.set(url, {
                    ...item, url,
                    title:    safeTrim(item.title),
                    poster:   safeTrim(item.poster),
                    saved_at: item.saved_at || Date.now(),
                });
            } else {
                map.set(url, {
                    ...ex, ...item, url,
                    saved_at: ex.saved_at || item.saved_at || Date.now(),
                    title:    betterTitleFn(item.title, ex.title),
                    poster:   betterPoster(item.poster, ex.poster),
                });
            }
        }
        return Array.from(map.values());
    }

    /**
     * Variant of mergeData where the most-recent saved_at wins.
     * Used for STORE_EXTRA_FIELD (series notes) so edits are never overwritten
     * by older cloud copies.
     */
    function mergeDataPreferNewest(arr, betterTitleFn = betterTitle) {
        const map = new Map();
        for (const raw of (arr || [])) {
            const item = toObj(raw);
            if (!item?.url) continue;
            const url = normUrl(item.url);
            if (!url) continue;
            const ex = map.get(url);
            if (!ex) {
                map.set(url, { ...item, url, saved_at: item.saved_at || Date.now() });
                continue;
            }
            const exTs = ex.saved_at   || 0;
            const itTs = item.saved_at || 0;
            map.set(url, {
                ...ex, ...item, url,
                saved_at: Math.max(exTs, itTs) || Date.now(),
                title:    betterTitleFn(item.title, ex.title),
                poster:   betterPoster(item.poster, ex.poster),
            });
        }
        return Array.from(map.values());
    }

    /**
     * core/storage.js — localStorage / GM_getValue persistence helpers.
     *
     * Source of truth: filmin.user.js
     * Used by: filmin, filmtwist, pandaplus, zigzag
     *
     * Depends on: GM_getValue / GM_setValue (injected by Tampermonkey at runtime)
     *             mergeData from ./merge.js (used by setStored)
     */


    /** Safe localStorage.getItem — never throws even if storage is blocked */
    function safeLSGet(key, fallback = null) {
        try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
    }

    /** Safe localStorage.setItem — never throws even if storage is blocked */
    function safeLSSet(key, val) {
        try { localStorage.setItem(key, val); } catch { /* localStorage blocked — ignore */ }
    }

    /**
     * Reads a list from localStorage (preferred) with fallback to GM_getValue.
     *
     * Priority:
     *   1. localStorage — available in most environments
     *   2. GM_getValue  — fallback when localStorage is blocked
     *
     * Write rule: only syncs GM from localStorage when localStorage has real data.
     * If localStorage is empty, recovers what GM already has (never overwrites valid
     * GM data with "[]").
     */
    function getStored(key) {
        let lsData = null, lsError = false;
        try { lsData = localStorage.getItem(key); }
        catch (e) { console.warn("localStorage inacessível, usando GM_getValue.", e); lsError = true; }

        let raw;
        if (lsError) {
            raw = GM_getValue(key, "[]");
        } else if (lsData !== null && lsData !== "") {
            raw = lsData;
            GM_setValue(key, raw);
        } else {
            raw = GM_getValue(key, "[]");
        }

        try {
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return [];
            return arr.map(item => typeof item === "string" ? { url: item, title: "", poster: "" } : item);
        } catch { return []; }
    }

    /**
     * core/image-cache.js — IndexedDB poster cache + blob URL management.
     *
     * Source of truth: filmin.user.js
     * Used by: filmin, filmtwist, pandaplus, zigzag
     *
     * Usage:
     *   const imgCache = createImageCache("filmin_img_cache_db");
     *   const blobUrl  = await imgCache.getCachedImageURL(posterUrl);
     *   imgCache.revokeAllObjectURLs(); // call on dashboard close
     */

    const IMG_STORE_NAME = "images";
    const OBJ_URL_CAP    = 400;

    function createImageCache(dbName) {
        // Map of original URL → blob: URL created in this session
        const _objUrls = new Map();

        // Cached IndexedDB promise — opens ONE connection per session
        let _imgDbPromise = null;

        /**
         * Revokes old blob URLs when the Map exceeds OBJ_URL_CAP.
         * Checks which blob: URLs are still mounted in a <img> before revoking
         * to avoid breaking visible posters when the user scrolls the dashboard.
         */
        function _revokeOldObjectURLs() {
            if (_objUrls.size <= OBJ_URL_CAP) return;
            const inUse = new Set(
                [...document.querySelectorAll('img[src^="blob:"]')]
                    .map(img => img.currentSrc || img.src)
            );
            for (const [k, obj] of _objUrls) {
                if (_objUrls.size <= OBJ_URL_CAP) break;
                if (inUse.has(obj)) continue;
                URL.revokeObjectURL(obj);
                _objUrls.delete(k);
            }
        }

        /** Revokes ALL blob URLs — call on dashboard close to free RAM */
        function revokeAllObjectURLs() {
            for (const obj of _objUrls.values()) {
                try { URL.revokeObjectURL(obj); } catch { /* ignore */ }
            }
            _objUrls.clear();
        }

        function openImageDB() {
            if (_imgDbPromise) return _imgDbPromise;
            _imgDbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(dbName, 1);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(IMG_STORE_NAME))
                        db.createObjectStore(IMG_STORE_NAME);
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror   = () => { _imgDbPromise = null; reject(req.error); };
            }).catch(err => { _imgDbPromise = null; throw err; });
            return _imgDbPromise;
        }

        async function getCachedImageBLOB(url) {
            if (!url || !url.startsWith("http")) return null;
            try {
                const db = await openImageDB();
                return new Promise((resolve) => {
                    const tx   = db.transaction(IMG_STORE_NAME, "readonly");
                    const getR = tx.objectStore(IMG_STORE_NAME).get(url);
                    getR.onsuccess = () => resolve(getR.result || null);
                    getR.onerror   = () => resolve(null);
                });
            } catch { return null; }
        }

        async function setCachedImageBLOB(url, blob) {
            if (!url || !blob) return;
            try {
                const db = await openImageDB();
                const tx = db.transaction(IMG_STORE_NAME, "readwrite");
                tx.objectStore(IMG_STORE_NAME).put(blob, url);
            } catch (e) { console.error("Erro ao guardar imagem na cache", e); }
        }

        /**
         * Returns a blob: URL for the given image URL.
         * Priority: in-memory Map → IndexedDB → GM_xmlhttpRequest fetch.
         */
        async function getCachedImageURL(url) {
            if (!url || url.includes("placehold.co") || !url.startsWith("http")) return url;
            if (_objUrls.has(url)) return _objUrls.get(url);

            const cachedBlob = await getCachedImageBLOB(url);
            if (cachedBlob) {
                const obj = URL.createObjectURL(cachedBlob);
                _objUrls.set(url, obj); _revokeOldObjectURLs();
                return obj;
            }

            return new Promise((resolve) => {
                if (typeof GM_xmlhttpRequest === "undefined") { resolve(url); return; }
                GM_xmlhttpRequest({
                    method: "GET", url, responseType: "blob",
                    onload: (response) => {
                        if (response.status >= 200 && response.status < 300 && response.response) {
                            const blob = response.response;
                            setCachedImageBLOB(url, blob);
                            const obj = URL.createObjectURL(blob);
                            _objUrls.set(url, obj); _revokeOldObjectURLs();
                            resolve(obj);
                        } else { resolve(url); }
                    },
                    onerror: () => resolve(url),
                });
            });
        }

        return { getCachedImageURL, getCachedImageBLOB, setCachedImageBLOB, revokeAllObjectURLs };
    }

    /**
     * core/toast.js — Toast notifications and progress toasts.
     *
     * Source of truth: filmin.user.js
     * Used by: filmin, filmtwist, pandaplus, zigzag
     *
     * Each service runs on its own domain, so a single shared namespace is fine.
     */

    const CSS_ID       = "bs-ms-toast-css";
    const CONTAINER_ID = "bs-ms-toast-container";

    function _injectToastCSS() {
        if (document.getElementById(CSS_ID)) return;
        const s = document.createElement("style");
        s.id = CSS_ID;
        s.textContent = `
    #${CONTAINER_ID} { position:fixed;bottom:20px;right:20px;z-index:1000000;
        display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none; }
    .bs-ms-toast { background:rgba(10,14,22,.97);color:#f1f5f9;padding:11px 18px;
        border-radius:8px;font-size:13.5px;font-weight:500;max-width:340px;
        font-family:system-ui,-apple-system,sans-serif;
        border:1px solid rgba(255,255,255,.08);border-left:3px solid #00e0a4;
        box-shadow:0 8px 24px rgba(0,0,0,.6);backdrop-filter:blur(8px);
        animation:bsMsSlideIn .35s cubic-bezier(.16,1,.3,1) forwards; }
    .bs-ms-toast-success { border-left-color:#10b981 !important; }
    .bs-ms-toast-error   { border-left-color:#ef4444 !important; }
    .bs-ms-toast-warning { border-left-color:#f59e0b !important; }
    .bs-ms-toast-info    { border-left-color:#00e0a4 !important; }
    .bs-ms-toast.bs-ms-toast-out { animation:bsMsSlideOut .25s ease-in forwards; }
    .bs-ms-toast-progress { width:300px;display:flex;flex-direction:column;gap:8px; }
    @keyframes bsMsSlideIn  { from { transform:translateX(calc(100% + 24px));opacity:0; } to { transform:translateX(0);opacity:1; } }
    @keyframes bsMsSlideOut { from { transform:translateX(0);opacity:1; } to { transform:translateX(calc(100% + 24px));opacity:0; } }
    `;
        (document.head || document.documentElement).appendChild(s);
    }

    function _getToastContainer() {
        _injectToastCSS();
        let c = document.getElementById(CONTAINER_ID);
        if (!c) {
            c = document.createElement("div");
            c.id = CONTAINER_ID;
            document.documentElement.appendChild(c);
        }
        return c;
    }

    /**
     * Shows an animated progress toast.
     * Pass current === -1 to dismiss immediately.
     * Pass current >= total to auto-dismiss after 1s.
     */
    function progressToast(id, title, current, total) {
        const container = _getToastContainer();
        let pToast = document.getElementById(id);
        if (!pToast) {
            pToast = document.createElement("div");
            pToast.id = id;
            pToast.className = "bs-ms-toast bs-ms-toast-progress";
            pToast.style.cssText = "padding:12px 18px;background:rgba(10,14,22,.97);border:1px solid rgba(255,255,255,.1);border-left:3px solid #3b82f6;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.6);animation:bsMsSlideIn .35s cubic-bezier(.16,1,.3,1) forwards;";
            pToast.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#f1f5f9;margin-bottom:8px;">
                <span class="bs-ms-progress-title" style="font-weight:500;"></span>
                <span class="bs-ms-progress-pct" style="font-size:11px;color:#94a3b8;">0%</span>
            </div>
            <div style="width:100%;height:4px;background:rgba(255,255,255,.12);border-radius:2px;overflow:hidden;">
                <div class="bs-ms-progress-fill" style="width:0%;height:100%;background:#3b82f6;transition:width .2s;border-radius:2px;"></div>
            </div>`;
            container.appendChild(pToast);
        }
        if (total > 0) {
            const pct = Math.round((current / total) * 100);
            pToast.querySelector(".bs-ms-progress-title").textContent = title;
            pToast.querySelector(".bs-ms-progress-pct").textContent   = `${current}/${total} (${pct}%)`;
            pToast.querySelector(".bs-ms-progress-fill").style.width  = `${pct}%`;
            if (current >= total) {
                setTimeout(() => {
                    pToast.classList.add("bs-ms-toast-out");
                    pToast.addEventListener("animationend", () => pToast.remove(), { once: true });
                }, 1000);
            }
        } else if (current === -1) {
            pToast.classList.add("bs-ms-toast-out");
            pToast.addEventListener("animationend", () => pToast.remove(), { once: true });
        }
    }

    /**
     * Shows a temporary notification popup.
     * @param {string} msg
     * @param {number} duration  milliseconds (default 4000)
     * @param {"info"|"success"|"error"|"warning"} type
     */
    function toast(msg, duration = 4000, type = "info") {
        const container = _getToastContainer();
        const t = document.createElement("div");
        t.className = `bs-ms-toast bs-ms-toast-${type}`;
        t.textContent = msg;
        container.appendChild(t);
        const dismiss = () => {
            t.classList.add("bs-ms-toast-out");
            t.addEventListener("animationend", () => t.remove(), { once: true });
        };
        setTimeout(dismiss, duration);
    }

    /**
     * core/icons.js — Shared Lucide SVG icon library.
     *
     * Source of truth: filmin.user.js
     * Used by: filmin, filmtwist, pandaplus
     */

    const ICONS = {
        cloud:    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`,
        download: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>`,
        history:  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l3 3"/><path d="M3.05 11a9 9 0 1 0 .5-4"/><polyline points="3 3 3 7 7 7"/></svg>`,
        copy:     `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
        check:    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
        api:      `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
        settings: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>`,
        export:   `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>`,
        poster:   `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`,
        dash:     `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
    };

    /**
     * core/cloud.js — Cloud sync: encryption, API config management, and generic
     * fetch/save/remove operations against the Cloudflare Worker backend.
     *
     * Source of truth: filmin.user.js
     * Used by: filmin, filmtwist, pandaplus, zigzag
     *
     * Usage:
     *   const cloud = createCloudSync({ obfKey: "FLM_SEC_KEY_24", storeApiConfigsKey: "filmin_api_configs" });
     *   const configs = cloud.getApiConfigs();
     *
     *   const result = await fetchCloudStores({ configs, storeKeys, getApiColor: cloud.getApiColor });
     *   const { pushed } = await saveStoresToCloud({ configs, storeKeys, getStored, mergeData, mergeDataPreferNewest, getApiColor: cloud.getApiColor });
     *   await removeUrlFromCloud({ configs, storeKeys, url });
     */


    /** Default fetch timeout (ms) and retry settings — adjustable per call. */
    const DEFAULT_TIMEOUT_MS = 15000;
    const DEFAULT_RETRIES    = 1;
    const RETRY_BACKOFF_MS   = 500;

    /**
     * fetchWithRetry() com timeout via AbortController e 1 retry em erros de rede transitórios.
     * NÃO faz retry em respostas 4xx (são erros aplicacionais, não transitórios).
     * Faz retry em: AbortError (timeout), TypeError (falha de rede), e 5xx.
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
                // 5xx é transitório — vale a pena repetir
                if (res.status >= 500 && res.status < 600 && attempt < retries) {
                    await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
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
    function createCloudSync({ obfKey, storeApiConfigsKey }) {
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
    async function fetchCloudStores({ configs, storeKeys, extraFieldKey = null, getApiColor }) {
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
    async function saveStoresToCloud({ configs, storeKeys, extraFieldKey = null, getStored, getApiColor }) {
        let pushed = 0;

        for (const api of configs) {
            if (!api.apiKey) continue;
            try {
                const keysParam = extraFieldKey
                    ? [...storeKeys, extraFieldKey].join(",")
                    : storeKeys.join(",");

                const getRes = await fetchWithRetry(`${api.url}?keys=${keysParam}`, {
                    headers: { "x-api-key": api.apiKey },
                });
                if (!getRes.ok) throw new Error(`GET falhou ${getRes.status}`);

                let cloudData = {};
                try { cloudData = await getRes.json() || {}; } catch { /* ignore bad JSON */ }

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
                if (res.ok) pushed++;
                else console.warn(`Falha ao sincronizar com ${api.name} (${res.status})`);
            } catch (err) {
                console.error(`Falha POST para ${api.name}:`, err);
            }
        }

        return { pushed };
    }

    /**
     * Removes a single URL from all store keys across all clouds.
     *
     * @param {{ configs, storeKeys: string[], extraFieldKey: string|null, url: string }} opts
     * @returns {{ cnt: number }}
     */
    async function removeUrlFromCloud({ configs, storeKeys, extraFieldKey = null, url }) {
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

    // ==UserScript==
    // @name         TVCine — Gestor de Catálogo, Downloads & Sync Cloud
    // @namespace    leinad4mind.top/forum
    // @version      1.9.0
    // @description  Conta e guarda filmes/séries do TVCine, sincroniza com Cloudflare Workers (multi-API), gere downloads e copiados, e apresenta uma Dashboard com filtros, posters, notas e exportação. Modifica também os links do header para incluir ?watch_more=1 e adiciona item "Destaques".
    // @author       Leinad4Mind
    // @license      MIT
    // @icon         https://www.google.com/s2/favicons?sz=64&domain=tvcine.pt
    // @match        https://tvcine.pt/*
    // @match        https://www.tvcine.pt/*
    // @grant        GM_getValue
    // @grant        GM_setValue
    // @grant        GM_setClipboard
    // @grant        GM_registerMenuCommand
    // @grant        GM_xmlhttpRequest
    // @grant        unsafeWindow
    // ==/UserScript==


        /* =====================================================================
           CONSTANTES
           ===================================================================== */

        const STORE_CATALOG = "tvcine_catalog";        // histórico visto/guardado
        const STORE_DOWNLOADED = "tvcine_downloaded";     // transferidos definitivamente
        const STORE_DOWNLOAD_LIST = "tvcine_download_list";  // copiados temporários
        const STORE_EXTRA_FIELD = "tvcine_extra_field";    // notas de série
        const STORE_API_CONFIGS = "tvcine_api_configs";    // configurações das APIs cloud

        const UI_POS_KEY = "tvcine_ui_pos_v1";
        const UI_MIN_KEY = "tvcine_ui_min_v1";

        // Selector raiz dos cards (agora inclui as páginas de episódio)
        const CARD_ROOT_SELECTOR = ".catalog-movies";

        const AUTO_UPDATE_MS = 650;

        /* =====================================================================
           ESTADO GLOBAL
           ===================================================================== */

        let cloudSaves = {};   // url → [apiName, ...]
        let cloudFullData = [];
        let cloudExtraFields = [];
        let _cloudFetchSeq = 0;

        let hideDownloaded = GM_getValue("tvcine_hide_downloaded_v1", false);
        let hideHistory = GM_getValue("tvcine_hide_history_v1", false);

        /* =====================================================================
           CACHE DE IMAGENS — via core/image-cache.js
           ===================================================================== */

        const { getCachedImageURL, revokeAllObjectURLs } = createImageCache("tvcine_img_cache_db");

        /* =====================================================================
           CSS GLOBAL
           ===================================================================== */

        const globStyle = document.createElement('style');
        globStyle.innerHTML = `
        /* ---- Cloud badges ---- */
        .ft-cloud-badge { opacity:0; transition:opacity 0.18s ease !important; }
        a.mcard:hover .ft-cloud-badge,
        .relative:hover .ft-cloud-badge { opacity:1 !important; }
        /* ---- Card hover overlay ---- */
        .ft-card-overlay {
            position:absolute; inset:0; z-index:200;
            display:flex; flex-direction:column; justify-content:flex-end; align-items:stretch;
            background:linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.3) 60%, transparent 100%);
            opacity:0; transition:opacity .18s ease; pointer-events:none;
            border-radius:4px;
        }
        /* Hover nos filtros (.relative wrapper) */
        .relative:hover .ft-card-overlay,
        a.mcard:hover .ft-card-overlay,
        /* Hover nos swipers da homepage (sem .relative) */
        [data-ft-card]:hover .ft-card-overlay { opacity:1; pointer-events:auto; }
        /* Cloud badge hover */
        .relative:hover .ft-cloud-badge,
        a.mcard:hover .ft-cloud-badge,
        [data-ft-card]:hover .ft-cloud-badge { opacity:1 !important; }
        .ft-card-overlay-btns {
            display:flex; gap:12px; padding:12px; justify-content:center;
        }
        .ft-ovl-btn {
            width:38px; height:38px; border-radius:50%; border:none; cursor:pointer;
            display:flex; align-items:center; justify-content:center;
            font-size:18px; line-height:1; 
            transition:background .12s,transform .1s; box-shadow: 0 4px 10px rgba(0,0,0,0.5);
        }
        .ft-ovl-btn:hover { transform:scale(1.04); }
        .ft-ovl-btn.catalog { background:rgba(14,165,233,.85); color:#fff; }
        .ft-ovl-btn.catalog:hover { background:rgba(14,165,233,1); }
        .ft-ovl-btn.catalog.active { background:rgba(16,185,129,.85); color:#fff; }
        .ft-ovl-btn.catalog.active:hover { background:rgba(16,185,129,1); }
        .ft-ovl-btn.downloaded { background:rgba(239,68,68,.85); color:#fff; }
        .ft-ovl-btn.downloaded:hover { background:rgba(239,68,68,1); }
        .ft-ovl-btn.downloaded.active { background:rgba(16,185,129,.85); color:#fff; }
        .ft-ovl-btn.downloaded.active:hover { background:rgba(16,185,129,1); }

        /* ---- Painel hide buttons ---- */
        .ft-hide-btn { padding:6px 12px; border-radius:4px; border:1px solid rgba(255,255,255,0.18);
            background:rgba(26,27,37,0.9); color:#d4d8e0; cursor:pointer; font-size:15px;
            font-family:inherit; display:inline-flex; align-items:center; gap:6px;
            letter-spacing:.01em; transition:background .15s,border-color .15s,color .15s;
            white-space:nowrap; }
        .ft-hide-btn:hover { background:rgba(50,55,70,0.95); border-color:rgba(255,255,255,0.32); color:#fff; }

        /* ---- Destaques separator ---- */
        .ft-destaques-sep {
            width:1px; background:rgba(255,255,255,.15); margin:4px 6px 4px 16px;
            align-self:stretch; display:inline-block;
        }
        .ft-destaques-link { cursor:pointer; }
    `;
        (document.head || document.documentElement).appendChild(globStyle);

        /* =====================================================================
           HELPERS GENÉRICOS — importados de core/merge.js
           ===================================================================== */

        function isRelevantFTItem(url) {
            if (!url) return false;
            const s = url.toLowerCase();
            return s.includes("/filmes-e-series/") || s.includes("/conteudo/") || s.includes("/vod/");
        }

        function ftConfirm(message, title = "Confirmar") {
            return new Promise((resolve) => {
                const mod = document.createElement("div");
                mod.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999999;
                display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);`;
                const box = document.createElement("div");
                box.style.cssText = `background:#0a0e16;padding:28px;border-radius:14px;width:90%;max-width:380px;
                border:1px solid rgba(255,166,26,.15);text-align:center;font-family:system-ui,sans-serif;
                box-shadow:0 12px 40px rgba(0,0,0,.8),0 0 0 1px rgba(255,166,26,.05);`;
                box.innerHTML = `
                <div style="font-size:35px;margin-bottom:14px;">⚠️</div>
                <h2 style="margin:0 0 12px;font-size:19px;color:#f1f5f9;letter-spacing:.02em;">${title}</h2>
                <p style="margin:0 0 24px;font-size:16.5px;color:#cbd5e1;line-height:1.5;">${message}</p>
                <div style="display:flex;gap:12px;justify-content:center;">
                    <button id="ft-conf-no" class="focusable" style="padding:10px 20px;background:rgba(255,255,255,.06);color:#94a3b8;border:1px solid rgba(255,255,255,.1);border-radius:8px;cursor:pointer;font-weight:600;font-size:15.5px;transition:background .2s;">Cancelar</button>
                    <button id="ft-conf-yes" class="focusable" style="padding:10px 20px;background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.3);border-radius:8px;cursor:pointer;font-weight:600;font-size:15.5px;transition:background .2s;">Confirmar</button>
                </div>
            `;
                mod.appendChild(box);
                document.body.appendChild(mod);
                const btnNo = box.querySelector("#ft-conf-no");
                const btnYes = box.querySelector("#ft-conf-yes");
                btnNo.onmouseover = () => btnNo.style.background = "rgba(255,255,255,.1)";
                btnNo.onmouseout = () => btnNo.style.background = "rgba(255,255,255,.06)";
                btnYes.onmouseover = () => btnYes.style.background = "rgba(239,68,68,.25)";
                btnYes.onmouseout = () => btnYes.style.background = "rgba(239,68,68,.15)";
                const cleanup = (val) => { mod.remove(); resolve(val); };
                btnNo.onclick = () => cleanup(false);
                btnYes.onclick = () => cleanup(true);
                mod.onclick = (e) => { if (e.target === mod) cleanup(false); };
            });
        }

        /* =====================================================================
           ARMAZENAMENTO LOCAL — getStored via core/storage.js
           setStored local: usa mergeDataPreferNewest para STORE_EXTRA_FIELD
           ===================================================================== */

        function setStored(key, list) {
            const jsonStr = key === STORE_EXTRA_FIELD
                ? JSON.stringify(mergeDataPreferNewest(list))
                : JSON.stringify(mergeData(list));
            try { localStorage.setItem(key, jsonStr); } catch (e) { console.error("Erro localStorage:", e); }
            GM_setValue(key, jsonStr);
        }

        function buildStoreCache() {
            const catalog = getStored(STORE_CATALOG);
            const downloaded = getStored(STORE_DOWNLOADED);
            const copyList = getStored(STORE_DOWNLOAD_LIST);
            return {
                catalog, downloaded, copyList,
                setCatalog: new Set(catalog.map(u => u.url)),
                setDownloaded: new Set(downloaded.map(u => u.url)),
                setCopyList: new Set(copyList.map(u => u.url)),
            };
        }

        /* =====================================================================
           RECOLHA DE LINKS DA PÁGINA
           ===================================================================== */

        function collectLinksFromPage() {
            const articles = [...document.querySelectorAll(CARD_ROOT_SELECTOR)];
            const all = [];
            const seen = new Set();

            for (const art of articles) {
                const linkEl = art.querySelector("a") || art;
                const href = normUrl(linkEl.href || toAbsUrl(linkEl.getAttribute("href") || ""));
                if (!href || !isRelevantFTItem(href)) continue;
                if (seen.has(href)) continue;
                seen.add(href);

                const titleEl = linkEl.querySelector(".catalog-cover-p");
                let title = titleEl ? Array.from(titleEl.childNodes)
                    .filter(node => node.nodeType === Node.TEXT_NODE)
                    .map(node => node.textContent)
                    .join(" ")
                    .trim() : "";
                    
                const spanTitle = titleEl?.querySelector("span");
                if (spanTitle) {
                     title += " " + spanTitle.textContent.trim();
                }
                if(!title) {
                     title = safeTrim(linkEl.getAttribute("alt") || "");
                }

                const imgEl = linkEl.querySelector("img.catalog-cover, img");
                let poster = imgEl ? (imgEl.getAttribute("data-src") || imgEl.getAttribute("src") || "") : "";
                
                // Força a imagem de alta resolução (remove _s antes da extensão)
                if (poster) poster = poster.replace(/_s\.([^.]+)$/i, '.$1');

                all.push({ url: href, title: safeTrim(title), poster });
            }
            return { all: mergeData(all) };
        }

        /* =====================================================================
           GUARDAR HISTÓRICO
           ===================================================================== */

        async function autoScrollToBottom() {
            return new Promise((resolve) => {
                let lastH = 0, checks = 0;
                const iv = setInterval(() => {
                    window.scrollTo(0, document.body.scrollHeight);
                    if (document.body.scrollHeight === lastH) {
                        if (++checks >= 3) { clearInterval(iv); resolve(); }
                    } else { checks = 0; lastH = document.body.scrollHeight; }
                }, 800);
            });
        }

        let isScrapingMetadata = false;

        async function saveHistory() {
            toast("A iniciar captura. A fazer scroll automático...");
            await autoScrollToBottom();

            const { all } = collectLinksFromPage();
            toast(`Encontrados ${all.length} títulos.`);

            if (!all.length) return toast("Nenhum link encontrado para processar.");

            const existing = getStored(STORE_CATALOG);
            const merged = mergeData([...existing, ...all]);
            setStored(STORE_CATALOG, merged);

            toast("A enviar para a Nuvem...");
            await saveToCloud();
            toast(`Guardados ${merged.length} títulos no catálogo!`);

            const dirtyRe = /placehold\.co|^$/;
            const incomplete = merged.filter(i => !i.title || !i.poster || dirtyRe.test(i.poster));
            if (incomplete.length > 0) {
                toast(`${incomplete.length} títulos sem metadados. A extrair...`);
                scrapeMissingMetadataInBackground(incomplete);
            }

            refreshAllCards();
            updateStats();
        }

        /* =====================================================================
           COPIAR LINKS PARA CLIPBOARD
           ===================================================================== */

        async function copyLinksToClipboard() {
            const { all } = collectLinksFromPage();
            const storedCopy = getStored(STORE_DOWNLOAD_LIST);
            const storedDown = getStored(STORE_DOWNLOADED);
            const copiedSet = new Set(storedCopy.map(u => u.url));
            const downSet = new Set(storedDown.map(u => u.url));
            const configs = getApiConfigs();
            const excludedNames = new Set(configs.filter(c => c.excludeFromCopy).map(c => c.name));

            let skipped = 0;
            const newOnes = all.filter(u => {
                if (copiedSet.has(u.url) || downSet.has(u.url)) return false;
                const urlClouds = cloudSaves[u.url] || [];
                if (urlClouds.some(n => excludedNames.has(n))) { skipped++; return false; }
                return true;
            });

            if (!newOnes.length) {
                GM_setClipboard("", { type: "text/plain" });
                return toast(skipped > 0
                    ? `🚫 Nada copiado. ${skipped} links com restrição.`
                    : "Nenhum link novo para copiar.");
            }

            const merged = mergeData([...storedCopy, ...newOnes]);
            setStored(STORE_DOWNLOAD_LIST, merged);
            GM_setClipboard(merged.map(i => i.url).join("\n") + "\n", { type: "text/plain" });

            toast(`A enviar ${newOnes.length} para a Nuvem...`);
            await saveToCloud();
            refreshAllCards();
            updateStats();
            toast(`Copiados: ${merged.length} (Novos: ${newOnes.length})${skipped ? ` 🚫 Omitidos: ${skipped}` : ''}`);
        }

        async function markCopiedAsDownloaded() {
            const copyList = getStored(STORE_DOWNLOAD_LIST);
            if (!copyList.length) return toast("Nenhum título na lista de copiados.");
            setStored(STORE_DOWNLOADED, mergeData([...getStored(STORE_DOWNLOADED), ...copyList]));
            setStored(STORE_DOWNLOAD_LIST, []);
            refreshAllCards();
            updateStats();
            toast(`A sincronizar ${copyList.length} títulos na Nuvem...`);
            await saveToCloud();
            toast(`${copyList.length} títulos movidos para 'Transferidos'!`);
        }

        function resetCopiedLinks() {
            const copyList = getStored(STORE_DOWNLOAD_LIST);
            if (!copyList.length) return toast("A lista de copiados já está vazia.");
            if (confirm(`Esvaziar a lista de ${copyList.length} links copiados?`)) {
                setStored(STORE_DOWNLOAD_LIST, []);
                toast("Lista de copiados esvaziada.");
                updateStats(); refreshAllCards();
            }
        }

        /* =====================================================================
           BACKUP — exportar / importar
           ===================================================================== */

        function exportData() {
            const payload = {
                catalog: getStored(STORE_CATALOG),
                downloaded: getStored(STORE_DOWNLOADED),
                download_list: getStored(STORE_DOWNLOAD_LIST),
            };
            const dateStr = new Date().toISOString().split('T')[0];
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = `panda_backup_${dateStr}.json`; a.click();
            URL.revokeObjectURL(url);
            toast("Backup exportado com sucesso.");
        }

        function importData() {
            const fileInput = document.createElement("input");
            fileInput.type = "file";
            fileInput.accept = ".json,application/json,.txt,text/plain";
            fileInput.style.display = "none";

            fileInput.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return toast("Nenhum ficheiro selecionado.");
                const reader = new FileReader();
                reader.onload = (ev) => {
                    try {
                        const data = JSON.parse(ev.target.result.trim());
                        if (!data || typeof data !== 'object') throw new Error("Formato inválido");

                        const norm = (arr) => !Array.isArray(arr) ? [] : arr.map(i => typeof i === 'string' ? { url: i, title: "", poster: "" } : i);
                        const inCatalog = norm(data.catalog);
                        const inDown = norm(data.downloaded);
                        const inCopy = norm(data.download_list);

                        if (inCatalog.length) setStored(STORE_CATALOG, mergeData([...getStored(STORE_CATALOG), ...inCatalog]));
                        if (inDown.length) setStored(STORE_DOWNLOADED, mergeData([...getStored(STORE_DOWNLOADED), ...inDown]));
                        if (inCopy.length) setStored(STORE_DOWNLOAD_LIST, mergeData([...getStored(STORE_DOWNLOAD_LIST), ...inCopy]));

                        const allImported = mergeData([...inCatalog, ...inDown, ...inCopy]);
                        if (allImported.some(i => i.title && i.poster)) saveToCloud();

                        refreshAllCards(); updateStats();
                        toast("Backup importado com sucesso!");

                        const incomplete = allImported.filter(i => !i.title || !i.poster);
                        if (incomplete.length) {
                            toast(`${incomplete.length} sem metadados. A extrair...`);
                            scrapeMissingMetadataInBackground(incomplete);
                        }
                    } catch (err) {
                        console.error(err);
                        toast("Erro: ficheiro JSON inválido ou corrompido.");
                    }
                };
                reader.readAsText(file);
            };

            document.body.appendChild(fileInput); fileInput.click(); document.body.removeChild(fileInput);
        }

        /* =====================================================================
           SCRAPE DE METADADOS EM BACKGROUND
           ===================================================================== */

        async function scrapeMissingMetadataInBackground(items) {
            if (isScrapingMetadata) return;
            isScrapingMetadata = true;

            const total = items.length;
            let updated = 0;
            if (total > 0) progressToast('ft_scrape', 'A extrair metadados...', 0, total);

            const sleep = ms => new Promise(r => setTimeout(r, ms));
            let baseDelay = 1200;
            const ALL_KEYS = [STORE_CATALOG, STORE_DOWNLOADED, STORE_DOWNLOAD_LIST];

            for (let i = 0; i < total; i++) {
                const item = items[i];
                progressToast('ft_scrape', 'A extrair metadados...', i + 1, total);
                if (window._ftDashScrapeProgress) window._ftDashScrapeProgress(i + 1, total);

                try {
                    await sleep(baseDelay);
                    const res = await fetch(item.url);
                    if (res.ok) {
                        const doc = new DOMParser().parseFromString(await res.text(), "text/html");

                        // Título: og:title ou h1 ou title
                        let title = doc.querySelector('meta[property="og:title"]')?.getAttribute('content')
                            || doc.querySelector("h1")?.textContent?.trim()
                            || doc.querySelector("title")?.textContent?.trim()
                            || "";
                        title = title.replace(/\s*[|–-]\s*Panda[+\s\S]*/i, '').replace(/\s+/g, ' ').trim();

                        // Poster: og:image
                        let poster = doc.querySelector('meta[property="og:image"]')?.getAttribute('content')
                            || doc.querySelector("picture img")?.getAttribute("src")
                            || "";

                        item.title = title || "Sem Título";
                        item.poster = poster || "https://placehold.co/280x400?text=Sem+Capa";

                        // Ano
                        const yearMatch = doc.querySelector('meta[property="og:description"]')?.getAttribute('content')?.match(/\b(19|20)\d{2}\b/);
                        if (yearMatch) item.year = yearMatch[0];

                        let touched = false;
                        ALL_KEYS.forEach(KEY => {
                            const list = getStored(KEY), idx = list.findIndex(u => u.url === item.url);
                            if (idx !== -1) { list[idx] = { ...list[idx], ...item }; setStored(KEY, list); touched = true; }
                        });
                        if (touched) updated++;
                        if (window._ftDashUpdateItem) window._ftDashUpdateItem(item.url, item.title, item.poster, item.year || "");
                    } else {
                        if (res.status === 429) {
                            baseDelay += 2000;
                            // Pausa não bloqueante — aborta se o utilizador fechar o dashboard
                            await new Promise(r => setTimeout(r, 60000));
                        }
                        else baseDelay = Math.min(baseDelay + 500, 5000);
                    }
                } catch (err) {
                    console.error(`Erro ao scrape ${item.url}`, err);
                }
                await sleep(1100);
            }

            if (updated > 0) {
                saveToCloud();
                setTimeout(() => toast(`${updated} metadados extraídos.`), 1500);
            }
            isScrapingMetadata = false;
        }

        /* =====================================================================
           OBSERVER INCREMENTAL + applyCardState()
           ===================================================================== */

        const _seenCards = new WeakSet();
        const _pendingCards = new Set();
        let _rafId = 0;

        function queueCard(el) {
            if (!el || _seenCards.has(el)) return;
            _pendingCards.add(el);
            if (!_rafId) _rafId = requestAnimationFrame(_flushCards);
        }

        function _flushCards() {
            _rafId = 0;
            if (!_pendingCards.size) return;

            const cache = buildStoreCache();
            const cloudMap = _buildCloudMap();
            const configs = getApiConfigs();
            const excludedFromHide = new Set(configs.filter(c => c.excludeFromHide).map(c => c.name));
            const readableApiNames = new Set(configs.map(c => c.name));

            for (const card of _pendingCards) {
                _seenCards.add(card);
                applyCardState(card, cache, cloudMap, configs, excludedFromHide, readableApiNames);
            }
            _pendingCards.clear();

            _currentHiddenCount = [...document.querySelectorAll(CARD_ROOT_SELECTOR)].filter(c => {
                const container = c.parentElement?.parentElement || c.parentElement || c;
                return container.style.display === "none";
            }).length;
            updateCatalogCount(_currentHiddenCount);
            scheduleStats();
        }

        let _currentHiddenCount = 0;

        let _statsThrottle = 0;
        function scheduleStats() {
            if (_statsThrottle) return;
            _statsThrottle = setTimeout(() => { _statsThrottle = 0; updateStats(); }, 300);
        }

        function refreshAllCards() {
            document.querySelectorAll(CARD_ROOT_SELECTOR).forEach(card => {
                _seenCards.delete(card);
                queueCard(card);
            });
            _currentHiddenCount = 0;
        }

        function _buildCloudMap() {
            const map = new Map();
            for (const item of cloudFullData) {
                if (!map.has(item.url)) map.set(item.url, []);
                map.get(item.url).push(item);
            }
            return map;
        }

        function applyCardState(root, cache, cloudMap, configs, excludedFromHide, readableApiNames) {
            // No TVCine, root é .catalog-movies e link é o <a> interior
            const linkEl = root.querySelector("a") || root;
            const href = normUrl(linkEl.href || toAbsUrl(linkEl.getAttribute("href") || ""));
            if (!href || !isRelevantFTItem(href)) return false;

            // Marcar com data-ft-card para o CSS de hover funcionar
            root.setAttribute('data-ft-card', '1');
            
            let imgWrapper = linkEl.querySelector('.ft-img-wrapper');
            const rawImg = linkEl.querySelector("img.catalog-cover, img");
            if (rawImg && !imgWrapper) {
                 imgWrapper = document.createElement("div");
                 imgWrapper.className = "ft-img-wrapper";
                 imgWrapper.style.position = "relative";
                 imgWrapper.style.display = "flex";
                 rawImg.parentNode.insertBefore(imgWrapper, rawImg);
                 imgWrapper.appendChild(rawImg);
            }
            const insertTarget = imgWrapper || root;
            insertTarget.style.position = insertTarget.style.position || 'relative';

            // Estado local
            const isCatalog = cache.setCatalog.has(href);
            const isDownloaded = cache.setDownloaded.has(href);
            const isCopied = cache.setCopyList.has(href);

            // Estado cloud
            const cloudItems = cloudMap.get(href) || [];
            const dlCloudItems = cloudItems.filter(i => i.listType === STORE_DOWNLOADED && readableApiNames.has(i.apiName));
            const catalogCloudItems = cloudItems.filter(i => i.listType === STORE_CATALOG && readableApiNames.has(i.apiName));

            const isSavedInCloud = dlCloudItems.length > 0;
            const isCatalogCloud = catalogCloudItems.length > 0;
            const cloudNames = [...new Set(dlCloudItems.map(i => i.apiName))];
            const isOnlyExcluded = cloudNames.length > 0 && cloudNames.every(n => excludedFromHide.has(n));

            const visuallySaved = isDownloaded || isCopied || isSavedInCloud;
            const visuallyCatalog = isCatalog || isCatalogCloud;
            const meetsHide = isDownloaded || (isSavedInCloud && !isOnlyExcluded);

            // Container a ocultar: no TVCine é a própria div .catalog-movies (root)
            const container = root;

            insertTarget.style.boxShadow = "";
            insertTarget.style.transition = "all 0.2s ease";

            if ((meetsHide && hideDownloaded) || (visuallyCatalog && hideHistory)) {
                container.style.display = "none";
                return true;
            } else {
                container.style.display = "";
            }

            // Cloud badge (canto top-left)
            insertTarget.querySelector('.ft-cloud-badge')?.remove();
            if (isSavedInCloud || visuallyCatalog) {
                const badge = document.createElement("div");
                badge.className = "ft-cloud-badge";
                badge.style.cssText = "position:absolute;top:6px;left:6px;z-index:210;display:flex;gap:3px;align-items:center;pointer-events:none;";

                if (visuallyCatalog) {
                    const icon = document.createElement("div");
                    icon.style.cssText = "background:rgba(0,0,0,0.72);color:#38bdf8;display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:4px;border:1px dashed rgba(14,165,233,0.6);font-size:15px;";
                    icon.title = "No catálogo/histórico"; icon.innerHTML = "📜";
                    badge.appendChild(icon);
                }
                if (isSavedInCloud) {
                    const pill = document.createElement("div");
                    pill.style.cssText = "background:rgba(0,0,0,0.8);color:#fff;font-size:13px;padding:2px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.18);font-weight:bold;display:flex;align-items:center;gap:3px;";
                    let names = "";
                    cloudNames.forEach((n, idx) => {
                        const match = dlCloudItems.find(i => i.apiName === n);
                        names += `<span style="color:${match?.apiColor || '#3b82f6'}">${n}</span>` + (idx < cloudNames.length - 1 ? ", " : "");
                    });
                    pill.innerHTML = `${ICONS.cloud}<span>${names}</span>`;
                    badge.appendChild(pill);
                }
                insertTarget.style.position = "relative";
                insertTarget.appendChild(badge);
            }

            // Overlay de hover com botões de gestão
            insertTarget.querySelector('.ft-card-overlay')?.remove();
            insertTarget.style.position = "relative";
            const overlay = document.createElement("div");
            overlay.className = "ft-card-overlay";

            const btns = document.createElement("div");
            btns.className = "ft-card-overlay-btns";

            // Botão: Guardar no catálogo
            const btnCat = document.createElement("button");
            btnCat.className = "ft-ovl-btn catalog" + (isCatalog ? " active" : "");
            btnCat.title = isCatalog ? "Remover do catálogo" : "Guardar no catálogo";
            btnCat.innerHTML = isCatalog ? "✓" : "💾";
            btnCat.addEventListener("click", async (e) => {
                e.preventDefault(); e.stopPropagation();
                const existing = getStored(STORE_CATALOG);
                
                const titleEl = root.querySelector(".catalog-cover-p");
                let title = titleEl ? Array.from(titleEl.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(" ").trim() : "";
                const spanTitle = titleEl?.querySelector("span");
                if(spanTitle) title += " " + spanTitle.textContent.trim();
                title = safeTrim(title);
                
                const imgEl = root.querySelector("img.catalog-cover, img");
                let poster = imgEl ? (imgEl.getAttribute("data-src") || imgEl.getAttribute("src") || "") : "";
                if (poster) poster = poster.replace(/_s\.([^.]+)$/i, '.$1');
                
                if (isCatalog) {
                    setStored(STORE_CATALOG, existing.filter(i => i.url !== href));
                    toast("Removido do catálogo.");
                } else {
                    setStored(STORE_CATALOG, mergeData([...existing, { url: href, title, poster, saved_at: Date.now() }]));
                    toast("💾 Guardado no catálogo!");
                }
                await saveToCloud();
                refreshAllCards(); updateStats();
            });
            btns.appendChild(btnCat);

            // Botão: Marcar como Já temos
            const btnDwn = document.createElement("button");
            btnDwn.className = "ft-ovl-btn downloaded" + (isDownloaded ? " active" : "");
            btnDwn.title = isDownloaded ? "Remover Transferidos" : "Marcar Transferidos";
            btnDwn.innerHTML = isDownloaded ? "✅" : "❌";
            btnDwn.addEventListener("click", async (e) => {
                e.preventDefault(); e.stopPropagation();
                const titleEl = root.querySelector(".catalog-cover-p");
                let title = titleEl ? Array.from(titleEl.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(" ").trim() : "";
                const spanTitle = titleEl?.querySelector("span");
                if(spanTitle) title += " " + spanTitle.textContent.trim();
                title = safeTrim(title);
                
                const imgEl = root.querySelector("img.catalog-cover, img");
                let poster = imgEl ? (imgEl.getAttribute("data-src") || imgEl.getAttribute("src") || "") : "";
                if (poster) poster = poster.replace(/_s\.([^.]+)$/i, '.$1');
                
                if (isDownloaded) {
                    setStored(STORE_DOWNLOADED, getStored(STORE_DOWNLOADED).filter(i => i.url !== href));
                    toast("Removido de 'Já temos'.");
                } else {
                    setStored(STORE_DOWNLOADED, mergeData([...getStored(STORE_DOWNLOADED), { url: href, title, poster, saved_at: Date.now() }]));
                    // Se estava na copy list, remove
                    setStored(STORE_DOWNLOAD_LIST, getStored(STORE_DOWNLOAD_LIST).filter(i => i.url !== href));
                    toast("✅ Marcado como Já temos!");
                }
                await saveToCloud();
                refreshAllCards(); updateStats();
            });
            btns.appendChild(btnDwn);

            overlay.appendChild(btns);
            insertTarget.appendChild(overlay);

            // Opacidade e borda — usa o card-image wrapper interno
            const _opWrapper = rawImg || insertTarget;
            if (visuallySaved) {
                _opWrapper.style.opacity = "0.35";
                if (isCopied && !isDownloaded) insertTarget.style.boxShadow = "0 0 0 3px #ffc107";
                else if (isSavedInCloud && !isDownloaded) insertTarget.style.boxShadow = `0 0 0 3px ${getApiColor(cloudNames[0], configs)}`;
                else insertTarget.style.boxShadow = "0 0 0 3px #10b981";
                insertTarget.style.borderRadius = "6px";
            } else {
                _opWrapper.style.opacity = "1";
                insertTarget.style.boxShadow = "";
            }

            return false;
        }

        function highlightSavedLinks() {
            _currentHiddenCount = 0;
            const cache = buildStoreCache();
            const cloudMap = _buildCloudMap();
            const configs = getApiConfigs();
            const excludedFromHide = new Set(configs.filter(c => c.excludeFromHide).map(c => c.name));
            const readableApiNames = new Set(configs.map(c => c.name));

            for (const card of document.querySelectorAll(CARD_ROOT_SELECTOR)) {
                _seenCards.delete(card);
                if (applyCardState(card, cache, cloudMap, configs, excludedFromHide, readableApiNames)) _currentHiddenCount++;
                _seenCards.add(card);
            }
            updateCatalogCount(_currentHiddenCount);
        }

        /* =====================================================================
           UI UTILS
           ===================================================================== */

        function updateCatalogCount(hiddenCount) {
            const countEl = document.getElementById("catalogue-movies-count");
            if (!countEl) return;
            if (!countEl.hasAttribute("data-original-text"))
                countEl.setAttribute("data-original-text", countEl.textContent.trim());
            const orig = countEl.getAttribute("data-original-text");
            if (hiddenCount > 0) {
                const match = orig.match(/(\d+)/);
                if (match) {
                    const newNum = Math.max(0, parseInt(match[1], 10) - hiddenCount);
                    countEl.textContent = orig.replace(match[1], String(newNum));
                }
            } else {
                countEl.textContent = orig;
            }
        }

        let panel, body, statsEl;

        function loadUIState() {
            const pos = JSON.parse(GM_getValue(UI_POS_KEY, '{"right":14,"bottom":14}'));
            const min = GM_getValue(UI_MIN_KEY, false);
            return { pos, min };
        }
        function saveUIPos(pos) { GM_setValue(UI_POS_KEY, JSON.stringify(pos)); }
        function setMinimized(v) { GM_setValue(UI_MIN_KEY, !!v); }

        // SVG icons para stats — nítidos em qualquer DPI
        const STAT_ICONS = {
            page: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
            catalog: `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M5 3a2 2 0 0 0-2 2v16l9-4 9 4V5a2 2 0 0 0-2-2H5z"/></svg>`,
            download: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
            copy: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
        };

        function updateStats() {
            if (!statsEl) return;
            const { all } = collectLinksFromPage();
            const pg = all.length;
            const cat = getStored(STORE_CATALOG).length;
            const dwn = getStored(STORE_DOWNLOADED).length;
            const cpy = getStored(STORE_DOWNLOAD_LIST).length;
            const cell = (icon, color, val, label) =>
                `<div style="padding:7px 9px;background:rgba(8,12,20,.98);">
                <div style="display:flex;align-items:center;gap:5px;margin-bottom:3px;">
                    <span style="color:${color};opacity:.75;line-height:0;">${icon}</span>
                    <span style="font-size:17px;font-weight:700;color:${color};line-height:1;">${val}</span>
                </div>
                <div style="font-size:12px;color:#64748b;letter-spacing:.07em;text-transform:uppercase;">${label}</div>
            </div>`;
            statsEl.innerHTML =
                `<div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:rgba(255,255,255,.05);border-radius:9px;overflow:hidden;">
                ${cell(STAT_ICONS.page, '#94a3b8', pg, 'Na página')}
                ${cell(STAT_ICONS.catalog, '#ffa61a', cat, 'Catálogo')}
                ${cell(STAT_ICONS.download, '#10b981', dwn, 'Transferidos')}
                ${cell(STAT_ICONS.copy, cpy > 0 ? '#f59e0b' : '#334155', cpy, 'Copiados')}
            </div>`;

            const btnMark = document.getElementById("ft-btn-mark-copied");
            if (btnMark?.parentElement)
                btnMark.parentElement.style.display = cpy > 0 ? "flex" : "none";
        }

        function makeButton(label, onClick, opts = {}) {
            const b = document.createElement("button");
            b.type = "button";
            if (opts.icon && ICONS[opts.icon]) {
                b.innerHTML = `<span style="display:inline-flex;align-items:center;gap:7px;">${ICONS[opts.icon]}<span>${label}</span></span>`;
            } else {
                b.textContent = label;
            }
            const accent = opts.accent || "rgba(255,166,26,.6)";
            const danger = opts.danger || false;
            b.style.cssText = `padding:10px 12px;border-radius:10px;
            background:rgba(255,255,255,.05);
            color:${danger ? "#f87171" : "#e2e8f0"};
            border:1px solid rgba(255,255,255,.08);
            border-left:2px solid ${danger ? "#ef4444" : accent};
            cursor:pointer;text-align:left;font-size:15.5px;
            font-family:inherit;font-weight:500;letter-spacing:0.01em;
            transition:background .15s,border-color .15s,color .15s;`;
            b.addEventListener("mouseover", () => {
                b.style.background = danger ? "rgba(239,68,68,.1)" : "rgba(255,255,255,.09)";
                b.style.borderLeftColor = danger ? "#f87171" : "rgba(255,166,26,.9)";
            });
            b.addEventListener("mouseout", () => {
                b.style.background = "rgba(255,255,255,.05)";
                b.style.borderLeftColor = danger ? "#ef4444" : accent;
            });
            b.addEventListener("click", (ev) => {
                ev.preventDefault(); ev.stopPropagation();
                try { onClick(ev); } catch (e) { console.error(e); toast("Erro ao executar ação."); }
            }, true);
            return b;
        }

        function injectUI() {
            const state = loadUIState();
            const topOrBottom = state.pos.top !== undefined ? `top:${state.pos.top}px;` : `bottom:${state.pos.bottom || 14}px;`;

            panel = document.createElement("div");
            panel.id = "ft-panel";
            panel.style.cssText = `position:fixed;right:${state.pos.right !== undefined ? state.pos.right : 14}px;${topOrBottom}
            z-index:999999;width:${state.min ? 180 : 320}px;border-radius:14px;
            background:rgba(8,12,20,.95);border:1px solid rgba(255,255,255,.09);
            box-shadow:0 12px 40px rgba(0,0,0,.5),0 0 0 1px rgba(255,166,26,.05);
            backdrop-filter:blur(12px);overflow:hidden;
            font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#fff;white-space:pre-line;`;

            // Header
            const header = document.createElement("div");
            header.style.cssText = `display:flex;align-items:center;justify-content:space-between;
            padding:11px 10px 11px 13px;cursor:move;user-select:none;
            background:linear-gradient(105deg,rgba(255,166,26,.22) 0%,rgba(8,12,20,0) 65%);
            border-bottom:1px solid rgba(255,255,255,.07);`;

            const title = document.createElement("div");
            title.style.cssText = "display:flex;align-items:center;gap:8px;";
            title.innerHTML = `
            <span style="width:7px;height:7px;border-radius:50%;background:#ffa61a;
                box-shadow:0 0 8px rgba(255,166,26,.8);flex-shrink:0;display:inline-block;"></span>
            <span style="font-weight:700;font-size:14.5px;letter-spacing:.14em;color:#f1f5f9;">TVCINE</span>`;

            const svgMin = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
            const svgMax = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`;

            const minBtn = document.createElement("button");
            minBtn.type = "button"; minBtn.title = "Minimizar / Maximizar";
            minBtn.innerHTML = state.min ? svgMax : svgMin;
            minBtn.style.cssText = `display:flex;align-items:center;justify-content:center;
            border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);
            color:#94a3b8;border-radius:7px;width:26px;height:26px;cursor:pointer;
            transition:background .15s,color .15s;`;
            minBtn.addEventListener("mouseover", () => { minBtn.style.background = "rgba(255,255,255,.1)"; minBtn.style.color = "#fff"; });
            minBtn.addEventListener("mouseout", () => { minBtn.style.background = "rgba(255,255,255,.05)"; minBtn.style.color = "#94a3b8"; });
            header.append(title, minBtn);

            // Body
            body = document.createElement("div");
            body.style.cssText = `padding:10px;display:${state.min ? "none" : "flex"};flex-direction:column;gap:7px;`;

            // Stats grid (preenchida por updateStats)
            statsEl = document.createElement("div");
            statsEl.style.cssText = "margin-bottom:1px;";

            const btnSave = makeButton("Guardar catálogo (scroll + nuvem)", saveHistory, { icon: "cloud" });
            btnSave.style.flex = "1";

            const btnCopy = makeButton("Copiar links visíveis e guardar na nuvem", copyLinksToClipboard, { icon: "copy" });
            btnCopy.style.flex = "1";

            const rowCopied = document.createElement("div"); rowCopied.style.cssText = "display:flex;gap:7px;";
            const btnMark = makeButton("Marcar transferidos", markCopiedAsDownloaded);
            const btnReset = makeButton("Limpar copiados", resetCopiedLinks, { danger: true });
            btnMark.id = "ft-btn-mark-copied";
            btnMark.style.flex = "1"; btnReset.style.flex = "1";
            rowCopied.append(btnMark, btnReset);

            const btnAPIs = makeButton("Gerir APIs cloud", openApiManagerUI, { accent: "rgba(255,166,26,.7)", icon: "api" });
            btnAPIs.style.flex = "1";

            const rowBackup = document.createElement("div"); rowBackup.style.cssText = "display:flex;gap:7px;";
            const btnExport = makeButton("Exportar", exportData, { accent: "rgba(100,116,139,.7)", icon: "export" });
            const btnImport = makeButton("Importar", importData, { accent: "rgba(100,116,139,.7)" });
            btnExport.style.flex = "1"; btnImport.style.flex = "1";
            rowBackup.append(btnExport, btnImport);

            const btnDash = makeButton("Visualizar dashboard", openDashboardUI, { accent: "rgba(59,130,246,.7)", icon: "dash" });
            btnDash.style.flex = "1";

            body.append(statsEl, btnSave, btnCopy, rowCopied, btnAPIs, rowBackup, btnDash);
            panel.append(header, body);
            document.documentElement.appendChild(panel);

            const applyMin = (v) => {
                body.style.display = v ? "none" : "flex";
                minBtn.innerHTML = v ? svgMax : svgMin;
                setMinimized(v);
                panel.style.width = v ? "180px" : "320px";
            };
            minBtn.addEventListener("click", (e) => { e.stopPropagation(); applyMin(body.style.display !== "none"); });

            // Drag
            let dragging = false, startX = 0, startY = 0, startRight = 0, startTop = 0;
            const startDrag = (e) => {
                const cx = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
                const cy = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
                dragging = true; startX = cx; startY = cy;
                startRight = parseInt(panel.style.right, 10) || 14;
                startTop = parseInt(panel.style.top, 10);
                if (isNaN(startTop)) { startTop = panel.offsetTop; panel.style.bottom = 'auto'; }
                if (!e.type.includes('touch')) e.preventDefault();
            };
            const moveDrag = (e) => {
                if (!dragging) return;
                if (e.type.includes('touch')) e.preventDefault();
                const cx = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
                const cy = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
                const nr = Math.max(0, Math.min(startRight + (startX - cx), window.innerWidth - panel.offsetWidth));
                const nt = Math.max(0, Math.min(startTop + (cy - startY), window.innerHeight - panel.offsetHeight));
                panel.style.right = `${nr}px`; panel.style.top = `${nt}px`;
            };
            const endDrag = () => {
                if (!dragging) return; dragging = false;
                saveUIPos({ right: parseInt(panel.style.right, 10) || 14, top: parseInt(panel.style.top, 10) });
            };
            header.addEventListener("mousedown", startDrag);
            header.addEventListener("touchstart", startDrag, { passive: false });
            window.addEventListener("mousemove", moveDrag);
            window.addEventListener("touchmove", moveDrag, { passive: false });
            window.addEventListener("mouseup", endDrag);
            window.addEventListener("touchend", endDrag);

            updateStats();
        }

        /* =====================================================================
           INJECÇÃO DOS BOTÕES DE OCULTAR (junto ao sort nativo)
           ===================================================================== */

        function injectHideButtons() {
            if (document.getElementById("ft-hide-btns")) return;
            const filterDiv = document.querySelector(".filter-catalog-div");
            if (!filterDiv) return;

            const wrapper = document.createElement("div");
            wrapper.id = "ft-hide-btns";
            wrapper.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;margin-left:auto;padding-right:20px;";

            const svgEye = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
            const svgEyeOff = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`;

            const createBtn = (id, labelOn, labelOff, isHidden, onChange) => {
                const btn = document.createElement("button");
                btn.id = id;
                btn.className = "ft-hide-btn";
                let cur = isHidden;
                const render = () => {
                    btn.innerHTML = (cur ? svgEyeOff : svgEye) + `<span>${cur ? labelOn : labelOff}</span>`;
                };
                render();
                btn.addEventListener("click", (e) => { e.preventDefault(); cur = !cur; render(); onChange(cur); });
                return btn;
            };

            wrapper.append(
                createBtn("ft-hide-down", "Mostrar transferidos", "Ocultar transferidos", hideDownloaded,
                    (v) => { hideDownloaded = v; GM_setValue("tvcine_hide_downloaded_v1", v); highlightSavedLinks(); }),
                createBtn("ft-hide-hist", "Mostrar catálogo", "Ocultar catálogo", hideHistory,
                    (v) => { hideHistory = v; GM_setValue("tvcine_hide_history_v1", v); highlightSavedLinks(); })
            );

            // Insere após os select filters
            const filterGroup = filterDiv.querySelector(".fliter-group");
            if (filterGroup) {
                 filterGroup.style.display = "flex";
                 filterGroup.style.flexWrap = "wrap";
                 filterGroup.style.alignItems = "center";
                 filterGroup.appendChild(wrapper);
            } else {
                 filterDiv.appendChild(wrapper);
            }
        }

        /* =====================================================================
           CLOUD SYNC — via core/cloud.js
           ===================================================================== */

        const { getApiConfigs, setApiConfigs, getApiColor } = createCloudSync({
            obfKey:             "FT_SEC_KEY_24",
            storeApiConfigsKey: STORE_API_CONFIGS,
        });

        const _STORE_KEYS      = [STORE_CATALOG, STORE_DOWNLOADED];
        const _EXTRA_FIELD_KEY = STORE_EXTRA_FIELD;

        async function fetchCloudData() {
            const seq = ++_cloudFetchSeq;
            const result = await fetchCloudStores({
                configs:       getApiConfigs(),
                storeKeys:     _STORE_KEYS,
                extraFieldKey: _EXTRA_FIELD_KEY,
                getApiColor,
            });
            if (seq !== _cloudFetchSeq) return;
            ({ cloudSaves, cloudFullData, cloudExtraFields } = result);
            highlightSavedLinks();
        }

        async function saveToCloud() {
            const { pushed } = await saveStoresToCloud({
                configs:       getApiConfigs(),
                storeKeys:     _STORE_KEYS,
                extraFieldKey: _EXTRA_FIELD_KEY,
                getStored,
                getApiColor,
            });
            if (pushed > 0) { toast("Sincronizado com a Nuvem!"); fetchCloudData(); }
        }

        async function removeFromCloud(url) {
            const { cnt } = await removeUrlFromCloud({
                configs:       getApiConfigs(),
                storeKeys:     _STORE_KEYS,
                extraFieldKey: _EXTRA_FIELD_KEY,
                url,
            });
            if (cnt > 0) { toast(`Removido de ${cnt} Nuvem(s)!`); fetchCloudData(); }
        }

        /* =====================================================================
           API MANAGER UI
           ===================================================================== */

        function openApiManagerUI() {
            document.getElementById("ft-cloud-api-mgr")?.remove();

            const esc = (s) => String(s ?? "")
                .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

            const mod = document.createElement("div");
            mod.id = "ft-cloud-api-mgr";
            mod.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:20000;
            display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);`;

            const box = document.createElement("div");
            box.style.cssText = `background:#0a0e16;border:1px solid rgba(255,255,255,.09);padding:0;width:680px;max-width:95%;
            border-radius:14px;color:#e2e8f0;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;
            font-family:system-ui,-apple-system,Segoe UI,sans-serif;
            box-shadow:0 24px 60px rgba(0,0,0,.7),0 0 0 1px rgba(255,166,26,.06);`;

            const iSvg = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 7l3 3-3 3"/><path d="M8 13h8"/><rect x="2" y="3" width="20" height="18" rx="2"/>
        </svg>`;

            let editingIdx = -1;

            const inputCSS = `width:100%;padding:9px 12px;background:rgba(255,255,255,.04);color:#e2e8f0;
            border:1px solid rgba(255,255,255,.09);border-radius:8px;box-sizing:border-box;
            font-size:15.5px;font-family:inherit;outline:none;transition:border-color .15s;`;
            const checkCSS = `accent-color:#ffa61a;width:14px;height:14px;cursor:pointer;`;

            const renderList = () => {
                const configs = getApiConfigs();
                const isEditing = editingIdx !== -1;
                const editingName = isEditing ? esc(configs[editingIdx]?.name ?? "") : "";

                let listHtml = "";
                if (!configs.length) {
                    listHtml = `<div style="padding:20px;text-align:center;color:#334155;font-size:15px;border:1px dashed rgba(255,255,255,.06);border-radius:10px;">
                    Nenhuma API configurada ainda.
                </div>`;
                } else {
                    configs.forEach((api, idx) => {
                        const hasCatalog = cloudFullData.some(i => i.apiName === api.name && i.listType === STORE_CATALOG);
                        const hasDown = cloudFullData.some(i => i.apiName === api.name && i.listType === STORE_DOWNLOADED);
                        const safeName = esc(api.name);
                        const safeColor = esc(getApiColor(api.name, configs));
                        const actionBtn = (cls, label, bg) =>
                            `<button data-idx="${idx}" class="${cls}" style="padding:4px 10px;background:${bg};color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:500;">${label}</button>`;
                        listHtml += `
                    <div style="background:rgba(255,255,255,.03);padding:12px 14px;border-radius:10px;margin-bottom:8px;border:1px solid rgba(255,255,255,.06);">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:${api.apiKey ? '10px' : '0'};">
                            <span style="font-size:16px;font-weight:600;color:${safeColor};letter-spacing:.02em;">${safeName}</span>
                            <div style="display:flex;gap:6px;">
                                ${actionBtn("ft-edit-api-btn", "Editar", "rgba(100,116,139,.3)")}
                                ${actionBtn("ft-del-api-btn", "Remover", "rgba(220,38,38,.2)")}
                            </div>
                        </div>
                        ${api.apiKey ? `<div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;padding-top:8px;border-top:1px solid rgba(255,255,255,.05);">
                            <span style="font-size:13px;color:#475569;margin-right:2px;letter-spacing:.06em;text-transform:uppercase;">Gestão:</span>
                            ${actionBtn("ft-restore-btn", "⬇ Restaurar local", "rgba(37,99,235,.25)")}
                            ${hasCatalog ? actionBtn("ft-purge-catalog-btn", "✕ Catálogo", "rgba(14,165,233,.2)") : ''}
                            ${hasDown ? actionBtn("ft-purge-down-btn", "✕ Transferidos", "rgba(194,65,12,.25)") : ''}
                        </div>` : ''}
                        <div style="display:flex;gap:12px;margin-top:7px;font-size:13.5px;">
                            <span style="color:${api.apiKey ? '#10b981' : '#475569'};">${api.apiKey ? '● Write access' : '○ Apenas leitura'}</span>
                            ${api.excludeFromCopy ? `<span style="color:#ef4444;">✕ Não copiar transferidos</span>` : ''}
                            ${api.excludeFromHide ? `<span style="color:#f59e0b;">◎ Não ocultar do ecrã</span>` : ''}
                        </div>
                    </div>`;
                    });
                }

                box.innerHTML = `
            <!-- Header -->
            <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:space-between;background:linear-gradient(105deg,rgba(255,166,26,.1),rgba(8,12,20,0));">
                <div style="display:flex;align-items:center;gap:10px;">
                    <span style="width:7px;height:7px;border-radius:50%;background:#ffa61a;box-shadow:0 0 8px rgba(255,166,26,.8);display:inline-block;"></span>
                    <span style="font-size:15.5px;font-weight:700;letter-spacing:.12em;color:#f1f5f9;">APIS CLOUD</span>
                </div>
                <button type="button" id="ft-tut-btn" style="padding:6px 12px;background:rgba(139,92,246,.2);color:#c4b5fd;border:1px solid rgba(139,92,246,.3);border-radius:7px;font-size:14px;cursor:pointer;font-weight:600;display:flex;align-items:center;gap:5px;">
                    ${iSvg} Passo-a-Passo
                </button>
            </div>

            <!-- Scroll body -->
            <div style="overflow-y:auto;padding:16px 20px;flex:1;">
                <p style="font-size:14.5px;color:#475569;margin:0 0 14px;line-height:1.5;">
                    Adiciona URLs das tuas Worker APIs. Fornece API Key apenas se for a tua base de dados (write access).
                </p>
                <div id="ft-api-list" style="margin-bottom:14px;">${listHtml}</div>

                <!-- Add / Edit form -->
                <div style="background:rgba(255,255,255,.025);padding:14px;border-radius:10px;border:1px solid rgba(255,255,255,.06);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                        <span style="font-size:14.5px;font-weight:600;color:#94a3b8;letter-spacing:.08em;text-transform:uppercase;">${isEditing ? `Editar: ${editingName}` : 'Nova API'}</span>
                        ${isEditing ? `<span id="ft-cancel-edit" style="color:#475569;cursor:pointer;font-size:14px;">Cancelar</span>` : ''}
                    </div>
                    <input id="ft-api-name" placeholder="Nome (ex: A minha cloud)" style="${inputCSS}margin-bottom:8px;">
                    <input id="ft-api-url"  placeholder="URL (ex: https://api.exemplo.workers.dev)" style="${inputCSS}margin-bottom:8px;">
                    <div style="display:flex;gap:6px;margin-bottom:12px;align-items:stretch;">
                        <input type="password" id="ft-api-key" placeholder="API Key Secreta (opcional — write access)" style="${inputCSS}margin-bottom:0;flex:1;">
                        <button type="button" id="ft-api-gen-key" title="Gerar chave aleatória segura"
                            style="padding:0 12px;background:rgba(139,92,246,.2);color:#c4b5fd;border:1px solid rgba(139,92,246,.3);border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;white-space:nowrap;font-family:inherit;">✦ Gerar</button>
                    </div>
                    <label style="display:flex;align-items:center;gap:8px;font-size:14.5px;color:#64748b;margin-bottom:8px;cursor:pointer;">
                        <input type="checkbox" id="ft-api-exc-copy" style="${checkCSS}">Não copiar transferidos desta nuvem
                    </label>
                    <label style="display:flex;align-items:center;gap:8px;font-size:14.5px;color:#64748b;margin-bottom:14px;cursor:pointer;">
                        <input type="checkbox" id="ft-api-exc-hide" style="${checkCSS}">Não esconder filmes desta nuvem ao ocultar
                    </label>
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <button id="ft-api-close" style="padding:8px 14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);color:#94a3b8;border-radius:8px;cursor:pointer;font-size:15px;">Fechar</button>
                        <button id="ft-api-save"  style="padding:8px 18px;background:${isEditing ? 'rgba(16,185,129,.2)' : 'rgba(37,99,235,.25)'};color:${isEditing ? '#6ee7b7' : '#93c5fd'};border:1px solid ${isEditing ? 'rgba(16,185,129,.35)' : 'rgba(37,99,235,.35)'};border-radius:8px;cursor:pointer;font-size:15px;font-weight:600;">${isEditing ? 'Atualizar API' : '+ Guardar API'}</button>
                    </div>
                </div>
            </div>`;

                // Generate random secure API key
                const genBtn = box.querySelector("#ft-api-gen-key");
                if (genBtn) {
                    genBtn.onclick = () => {
                        const arr = new Uint8Array(24);
                        crypto.getRandomValues(arr);
                        const key = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
                        const inp = box.querySelector("#ft-api-key");
                        inp.value = key; inp.type = "text";
                        setTimeout(() => { inp.type = "password"; }, 3000);
                        toast("Chave gerada — copie e guarde no Cloudflare.");
                    };
                }

                // Focus styles on inputs
                box.querySelectorAll("input[id^='ft-api']").forEach(inp => {
                    inp.addEventListener("focus", () => inp.style.borderColor = "rgba(220,38,38,.5)");
                    inp.addEventListener("blur", () => inp.style.borderColor = "rgba(255,255,255,.09)");
                });

                if (isEditing) {
                    const api = configs[editingIdx];
                    box.querySelector("#ft-api-name").value = api.name;
                    box.querySelector("#ft-api-url").value = api.url;
                    box.querySelector("#ft-api-key").value = api.apiKey || "";
                    box.querySelector("#ft-api-exc-copy").checked = !!api.excludeFromCopy;
                    box.querySelector("#ft-api-exc-hide").checked = !!api.excludeFromHide;
                    box.querySelector("#ft-cancel-edit").onclick = () => { editingIdx = -1; renderList(); };
                }

                box.querySelectorAll(".ft-del-api-btn").forEach(btn => {
                    btn.onclick = () => {
                        const i = parseInt(btn.getAttribute("data-idx"), 10);
                        configs.splice(i, 1);
                        if (editingIdx === i) editingIdx = -1;
                        else if (editingIdx > i) editingIdx--;
                        setApiConfigs(configs); renderList(); fetchCloudData();
                    };
                });
                box.querySelectorAll(".ft-edit-api-btn").forEach(btn => {
                    btn.onclick = () => { editingIdx = parseInt(btn.getAttribute("data-idx"), 10); renderList(); };
                });

                const setupPurge = (sel, label, purgeKey) => {
                    box.querySelectorAll(sel).forEach(btn => {
                        btn.onclick = async () => {
                            const i = parseInt(btn.getAttribute("data-idx"), 10);
                            const api = configs[i];
                            if (!await ftConfirm(`Apagar ${label} no servidor de ${api.name}?`, "Apagar na Nuvem")) return;
                            const res = await fetch(api.url, {
                                method: "DELETE",
                                headers: { "Content-Type": "application/json", "x-api-key": api.apiKey },
                                body: JSON.stringify({ purgeKey })
                            });
                            if (res.ok) { toast(`Nuvem de ${api.name} (${label}) limpa!`); btn.style.display = 'none'; fetchCloudData(); }
                            else toast(`Falha ao limpar ${api.name}.`);
                        };
                    });
                };
                setupPurge(".ft-purge-catalog-btn", "CATÁLOGO", STORE_CATALOG);
                setupPurge(".ft-purge-down-btn", "TRANSFERIDOS", STORE_DOWNLOADED);

                box.querySelectorAll(".ft-restore-btn").forEach(btn => {
                    btn.onclick = async () => {
                        const i = parseInt(btn.getAttribute("data-idx"), 10);
                        const api = configs[i];
                        if (!await ftConfirm(`Restaurar LOCAL com dados de ${api.name}?`, "Restaurar Local")) return;
                        const hdrs = api.apiKey ? { "x-api-key": api.apiKey } : undefined;
                        const res = await fetch(`${api.url}?keys=${STORE_CATALOG},${STORE_DOWNLOADED}`, { headers: hdrs });
                        if (!res.ok) { toast(`Falha: ${res.status}`); return; }
                        const data = await res.json();
                        if (data && typeof data === 'object') {
                            if (data[STORE_CATALOG]) setStored(STORE_CATALOG, data[STORE_CATALOG]);
                            if (data[STORE_DOWNLOADED]) setStored(STORE_DOWNLOADED, data[STORE_DOWNLOADED]);
                            toast(`Restauro concluído via ${api.name}.`);
                            updateStats(); highlightSavedLinks(); mod.remove();
                        } else toast("Formato de dados inválido.");
                    };
                });

                box.querySelector("#ft-api-close").onclick = () => mod.remove();
                box.querySelector("#ft-api-save").onclick = () => {
                    const n = box.querySelector("#ft-api-name").value.trim();
                    let u = box.querySelector("#ft-api-url").value.trim();
                    const k = box.querySelector("#ft-api-key").value.trim();
                    const exc = box.querySelector("#ft-api-exc-copy").checked;
                    const excH = box.querySelector("#ft-api-exc-hide").checked;
                    if (!n || !u) return toast("Nome e URL são obrigatórios.");
                    if (!u.startsWith("http")) return toast("URL deve começar por http:// ou https://");
                    if (u.endsWith('/')) u = u.slice(0, -1);
                    if (editingIdx !== -1) {
                        configs[editingIdx] = { name: n, url: u, apiKey: k || null, excludeFromCopy: exc, excludeFromHide: excH };
                        editingIdx = -1;
                    } else {
                        configs.push({ name: n, url: u, apiKey: k || null, excludeFromCopy: exc, excludeFromHide: excH });
                    }
                    setApiConfigs(configs); renderList(); fetchCloudData();
                };

                box.querySelector("#ft-tut-btn").onclick = openWorkerTutorialUI;
            };

            renderList();
            mod.appendChild(box);
            document.body.appendChild(mod);
        }

        /* =====================================================================
           DASHBOARD (Vue 3)
           ===================================================================== */

        async function openDashboardUI() {
            document.getElementById("ft-dashboard")?.remove();

            try {
                if (!unsafeWindow.Vue) {
                    await new Promise((resolve, reject) => {
                        const s = document.createElement('script');
                        s.src = 'https://unpkg.com/vue@3/dist/vue.global.js';
                        s.onload = resolve; s.onerror = () => reject(new Error('Falha ao carregar Vue.js'));
                        document.head.appendChild(s);
                    });
                }
            } catch { toast("Falha ao carregar Vue CDN."); return; }

            const VueLib = unsafeWindow.Vue;

            const localCatalog = getStored(STORE_CATALOG).length;
            const localDown = getStored(STORE_DOWNLOADED).length;
            const localCopy = getStored(STORE_DOWNLOAD_LIST).length;

            const notesMap = new Map();
            mergeDataPreferNewest([...cloudExtraFields, ...getStored(STORE_EXTRA_FIELD)]).forEach(i => {
                if (i.ft_extra_field) notesMap.set(i.url, i.ft_extra_field);
            });

            const allItemsMap = new Map();
            const addOrUpdate = (item, sourceName, sourceColor, isCloud, explicitType = null) => {
                if (!allItemsMap.has(item.url)) {
                    allItemsMap.set(item.url, {
                        ...item, sources: [], cloudDownloaded: {}, cloudHistory: {},
                        isLocalDownloaded: false, isLocalHistory: false, isLocal: false, isCopied: false
                    });
                }
                const r = allItemsMap.get(item.url);
                const activeType = item.listType || explicitType;
                const isDl = activeType === STORE_DOWNLOADED;
                const isCopy = activeType === STORE_DOWNLOAD_LIST;
                const isHist = activeType === STORE_CATALOG;
                if (isCloud) {
                    if (!r.sources.some(s => s.name === sourceName)) r.sources.push({ name: sourceName, color: sourceColor });
                    if (isDl) r.cloudDownloaded[sourceName] = true;
                    if (isHist) r.cloudHistory[sourceName] = true;
                    if (item.saved_at && (!r.saved_at || item.saved_at > r.saved_at)) r.saved_at = item.saved_at;
                } else {
                    r.isLocal = true;
                    if (isDl) r.isLocalDownloaded = true;
                    if (isHist) r.isLocalHistory = true;
                    if (isCopy) r.isCopied = true;
                    if (!r.saved_at && item.saved_at) r.saved_at = item.saved_at;
                }
                if (!r.mediaType) {
                    r.mediaType = r.url.includes("/serie/") ? "Série" : "Filme";
                }
                r.ft_extra_field = notesMap.get(r.url) || "";
            };

            cloudFullData.forEach(item => addOrUpdate(item, item.apiName, item.apiColor, true));
            getStored(STORE_CATALOG).forEach(item => addOrUpdate(item, "Local", null, false, STORE_CATALOG));
            getStored(STORE_DOWNLOADED).forEach(item => addOrUpdate(item, "Local", null, false, STORE_DOWNLOADED));
            getStored(STORE_DOWNLOAD_LIST).forEach(item => addOrUpdate(item, "Local", null, false, STORE_DOWNLOAD_LIST));

            const configs = getApiConfigs();
            const uniqueCloudsArr = [...new Set(configs.map(c => c.name))];
            const cloudStatsData = uniqueCloudsArr.map(cn => ({
                name: cn, color: getApiColor(cn, configs),
                hasKey: !!configs.find(c => c.name === cn)?.apiKey,
                catalog: cloudFullData.filter(i => i.apiName === cn && i.listType === STORE_CATALOG).length,
                downloaded: cloudFullData.filter(i => i.apiName === cn && i.listType === STORE_DOWNLOADED).length,
            }));

            const allDashData = Array.from(allItemsMap.values()).sort((a, b) => (b.saved_at || 0) - (a.saved_at || 0));
            const completeItems = allDashData.filter(i => i.title && i.poster && !i.poster.includes('placehold'));
            const pendingItems = allDashData.filter(i => !i.title || !i.poster || i.poster.includes('placehold'));

            if (pendingItems.length > 0) setTimeout(() => scrapeMissingMetadataInBackground(pendingItems), 800);

            const mod = document.createElement("div");
            mod.id = "ft-dashboard";
            mod.style.cssText = "position:fixed;inset:0;background:#060c18;z-index:2000000;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:32px 40px;overflow-y:auto;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#e2e8f0;";

            const gridCss = document.createElement("style");
            gridCss.textContent = `
            .ft-grid { display:grid; gap:16px; width:100%; margin-bottom:20px; }
            .ft-grid-card   { grid-template-columns: repeat(4, minmax(0, 1fr)); }
            .ft-grid-poster { grid-template-columns: repeat(4, minmax(0, 1fr)); }
            @media (max-width: 900px) { .ft-grid-poster,.ft-grid-card { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; } }
            @media (max-width: 720px)  { .ft-grid-poster,.ft-grid-card { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } }
            .ft-input { background:rgba(255,255,255,.05) !important; border:1px solid rgba(255,255,255,.10) !important;
                color:#e2e8f0 !important; padding:9px 13px !important; border-radius:8px !important;
                outline:none; transition:border-color .15s; font-size:16px;
                color-scheme:dark; }
            .ft-input:focus { border-color:rgba(255,166,26,.5) !important; }
            .ft-input option { background:#0f172a !important; color:#e2e8f0 !important; }
            .ft-btn { border:none;padding:9px 16px;border-radius:8px;cursor:pointer;font-weight:600;font-size:15.5px;
                transition:opacity .15s,transform .1s; }
            .ft-btn:hover { opacity:.85; transform:translateY(-1px); }
            .ft-btn:active { transform:translateY(0); }
        `;
            mod.appendChild(gridCss);
            const mountEl = document.createElement("div"); mountEl.id = "ft-vue-app";
            mod.appendChild(mountEl);
            document.body.appendChild(mod);

            const { createApp, ref, computed } = VueLib;
            const dashboardData = ref(completeItems);
            const pendingRef = ref(pendingItems);

            const app = createApp({
                template: `
<div style="width:100%;max-width:1280px;">

  <!-- Header -->
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:28px;padding-bottom:18px;border-bottom:1px solid rgba(255,255,255,.08);">
    <div style="display:flex;align-items:center;gap:12px;">
      <span style="width:9px;height:9px;border-radius:50%;background:#ffa61a;box-shadow:0 0 10px rgba(255,166,26,.9);display:inline-block;"></span>
      <span style="font-size:18px;font-weight:700;letter-spacing:.12em;color:#f1f5f9;">PANDA+</span>
      <span style="font-size:14px;color:#94a3b8;letter-spacing:.06em;font-weight:500;">DASHBOARD</span>
    </div>
    <button @click="close" class="ft-btn" style="background:rgba(220,38,38,.15);color:#f87171;border:1px solid rgba(220,38,38,.3);">Fechar</button>
  </div>

  <!-- Scraping progress -->
  <div v-if="pendingRef.length > 0" style="background:rgba(234,179,8,.08);color:#fbbf24;padding:12px 16px;border-radius:10px;margin-bottom:24px;font-size:16px;font-weight:500;border:1px solid rgba(234,179,8,.2);">
    <span v-if="scrapeTotal > 0">A processar {{ scrapeCurrent }} de {{ scrapeTotal }} itens...</span>
    <span v-else>A preparar processamento de {{ pendingRef.length }} itens...</span>
  </div>

  <!-- Stat cards -->
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;width:100%;margin-bottom:16px;">
    <div v-for="(v,l) in statCards" :key="l"
         style="background:rgba(255,255,255,.03);padding:18px 20px;border-radius:12px;border:1px solid rgba(255,255,255,.07);display:flex;align-items:center;gap:14px;">
      <div :style="{background:v.color+'1a',borderColor:v.color+'44'}" style="width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:21px;border:1px solid;flex-shrink:0;">{{ v.icon }}</div>
      <div>
        <div :style="{color:v.color}" style="font-size:29px;font-weight:700;line-height:1;">{{ v.count }}</div>
        <div style="font-size:14px;color:#94a3b8;margin-top:3px;letter-spacing:.06em;text-transform:uppercase;">{{ l }}</div>
      </div>
    </div>
  </div>

  <!-- Cloud cards -->
  <div v-if="st.cloudStats.length" style="display:flex;gap:12px;width:100%;margin-bottom:20px;flex-wrap:wrap;">
    <div v-for="c in st.cloudStats" :key="c.name"
         :style="{borderColor:c.color+'44'}"
         style="background:rgba(255,255,255,.02);padding:14px 18px;border-radius:12px;border:1px solid;min-width:200px;flex:1;">
      <div :style="{color:c.color}" style="font-size:15px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-bottom:10px;">☁ {{ c.name }}</div>
      <div style="display:flex;justify-content:space-between;margin-bottom:5px;">
        <span style="font-size:15px;color:#64748b;">Catálogo</span>
        <span style="font-size:16px;font-weight:600;color:#e2e8f0;">{{ c.catalog }}</span>
      </div>
      <div style="display:flex;justify-content:space-between;">
        <span style="font-size:15px;color:#64748b;">Transferidos</span>
        <span style="font-size:16px;font-weight:600;color:#10b981;">{{ c.downloaded }}</span>
      </div>
    </div>
  </div>

  <!-- Toolbar -->
  <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:12px 12px 0 0;padding:12px 14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
    <input type="text" v-model="searchName" placeholder="Pesquisar título..." class="ft-input" style="flex:1;min-width:160px;">
    <select v-model="filterStatus" class="ft-input" style="min-width:150px;cursor:pointer;">
      <option value="all">Todos os estados</option>
      <option value="downloaded">Transferidos</option>
      <option value="history">Catálogo</option>
      <option value="copied">Copiados</option>
    </select>
    <select v-model="filterCloud" class="ft-input" style="min-width:140px;cursor:pointer;">
      <option value="all">Todas as origens</option>
      <option value="local">Apenas local</option>
      <option v-for="c in st.uniqueClouds" :key="c" :value="c">☁ {{ c }}</option>
    </select>
  </div>
  <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-top:1px solid rgba(255,255,255,.04);border-radius:0 0 12px 12px;padding:10px 14px;margin-bottom:20px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
    <button @click="toggleView"     class="ft-btn" style="background:rgba(59,130,246,.15);color:#93c5fd;border:1px solid rgba(59,130,246,.25);">Alternar formato</button>
    <button @click="exportFiltered" class="ft-btn" style="background:rgba(16,185,129,.15);color:#6ee7b7;border:1px solid rgba(16,185,129,.25);">Exportar atuais</button>
    <div style="display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap;">
      <input type="date" v-model="dateStart" class="ft-input" placeholder="dd/mm/aaaa">
      <span style="font-size:14px;color:#94a3b8;">até</span>
      <input type="date" v-model="dateEnd" class="ft-input" placeholder="dd/mm/aaaa">
    </div>
  </div>

  <!-- Grid -->
  <div v-if="filtered.length===0" style="padding:48px;text-align:center;color:#64748b;background:rgba(255,255,255,.02);border:1px dashed rgba(255,255,255,.08);border-radius:12px;">Nenhum título correspondente.</div>
  <div v-else>
    <div style="text-align:center;margin-bottom:14px;font-size:15px;color:#94a3b8;letter-spacing:.04em;">A mostrar {{ displayed.length }} de {{ filtered.length }} resultados</div>
    <div :class="['ft-grid', viewMode==='poster' ? 'ft-grid-poster' : 'ft-grid-card']">
    <div v-for="item in displayed" :key="item.url" :style="cardStyle(item)" @mouseenter="cardHover($event,true)" @mouseleave="cardHover($event,false)">
      <div :style="{aspectRatio:ar}" style="display:block;position:relative;overflow:hidden;background:#000;border-radius:8px 8px 0 0;">
        <a :href="item.url" target="_blank" style="display:block;width:100%;height:100%;">
          <img :src="posterSrc(item)" @error="posterErr($event,item)" alt="Poster" loading="lazy"
               :style="{opacity:isSaved(item)?0.3:1}" style="width:100%;height:100%;object-fit:cover;transition:opacity .2s;"
               @mouseenter="$event.target.style.opacity=1" @mouseleave="$event.target.style.opacity=isSaved(item)?0.3:1">
        </a>
        <div style="position:absolute;top:8px;left:8px;display:flex;flex-wrap:wrap;width:90%;pointer-events:none;">
          <span v-for="src in item.sources" :key="src.name" :style="{color:src.color}"
                style="background:rgba(0,0,0,.88);padding:2px 6px;border-radius:4px;font-size:12.5px;margin-right:4px;margin-bottom:4px;border:1px solid rgba(255,255,255,.15);font-weight:600;letter-spacing:.04em;">
            {{ badgeIcon(item,src.name) }} {{ src.name }}
          </span>
          <span v-if="item.isLocal" style="background:rgba(0,0,0,.88);color:#10b981;padding:2px 6px;border-radius:4px;font-size:12.5px;margin-right:4px;margin-bottom:4px;border:1px solid rgba(16,185,129,.3);font-weight:600;">Local</span>
        </div>
        <div @click.prevent="copyPoster(item)"
             style="position:absolute;bottom:8px;right:8px;background:rgba(0,0,0,.7);color:#94a3b8;padding:4px 7px;border-radius:5px;font-size:13px;cursor:pointer;border:1px solid rgba(255,255,255,.1);transition:color .15s;" title="Copiar poster">${ICONS.poster}</div>
        <div v-if="item.mediaType==='Série'" @click.stop.prevent="openNoteModal(item)"
             style="position:absolute;top:8px;right:8px;background:rgba(15,23,42,.9);color:#fff;padding:5px;border-radius:50%;font-size:15px;cursor:pointer;border:1px solid rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;width:26px;height:26px;z-index:20;">
          <span>{{ item.ft_extra_field ? '📝' : '＋' }}</span>
        </div>
      </div>
      <div style="padding:10px 12px;display:flex;flex-direction:column;flex-grow:1;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:4px;">
          <a :href="item.url" target="_blank" style="flex-grow:1;color:#e2e8f0;text-decoration:none;font-weight:600;font-size:15.5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;"
           @mouseenter="$event.target.style.color='#ffa61a'" @mouseleave="$event.target.style.color='#e2e8f0'">{{ item.title||'Sem Título' }}</a>
          <div v-if="hasWriteAccess(item)" style="display:flex;gap:2px;flex-shrink:0;">
            <button @click.prevent="openEditModal(item)" style="background:transparent;color:#475569;border:none;border-radius:4px;padding:3px;cursor:pointer;font-size:15px;transition:color .15s;" @mouseenter="$event.target.style.color='#e2e8f0'" @mouseleave="$event.target.style.color='#475569'" title="Editar">✏️</button>
            <button @click.prevent="deleteItem(item)"   style="background:transparent;color:#475569;border:none;border-radius:4px;padding:3px;cursor:pointer;font-size:15px;transition:color .15s;" @mouseenter="$event.target.style.color='#ef4444'" @mouseleave="$event.target.style.color='#475569'" title="Eliminar">🗑️</button>
          </div>
        </div>
        <div style="font-size:13.5px;color:#64748b;margin-top:auto;padding-top:7px;border-top:1px solid rgba(255,255,255,.05);">
          {{ fmtDate(item.saved_at) }}
        </div>
      </div>
    </div>
    </div>
    <div ref="sentinel" style="height:1px;"></div>
    <div v-if="displayed.length < filtered.length" style="text-align:center;padding:24px;color:#64748b;font-size:15px;">A carregar mais...</div>
    <div v-else-if="filtered.length > 0" style="text-align:center;padding:24px;color:#64748b;font-size:15px;">{{ filtered.length }} itens carregados</div>
  </div>

  <!-- Modal edição -->
  <div v-if="editingItem" style="position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);">
    <div style="background:#0f172a;padding:28px;border-radius:14px;width:90%;max-width:500px;border:1px solid rgba(255,255,255,.1);">
      <h2 style="margin-top:0;font-size:19px;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:12px;margin-bottom:20px;color:#f1f5f9;">Editar</h2>
      <label style="display:block;margin-bottom:6px;font-size:15px;color:#64748b;letter-spacing:.06em;text-transform:uppercase;">Título</label>
      <input type="text" v-model="editingItem.title" class="ft-input" style="width:100%;box-sizing:border-box;margin-bottom:14px;">
      <label style="display:block;margin-bottom:6px;font-size:15px;color:#64748b;letter-spacing:.06em;text-transform:uppercase;">Poster URL</label>
      <input type="text" v-model="editingItem.poster" class="ft-input" style="width:100%;box-sizing:border-box;margin-bottom:24px;">
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button @click="editingItem=null" class="ft-btn" style="background:rgba(255,255,255,.06);color:#94a3b8;border:1px solid rgba(255,255,255,.1);">Cancelar</button>
        <button @click="saveEdit"         class="ft-btn" style="background:rgba(16,185,129,.15);color:#6ee7b7;border:1px solid rgba(16,185,129,.25);">Guardar</button>
      </div>
    </div>
  </div>

  <!-- Modal nota -->
  <div v-if="editingNoteItem" style="position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);">
    <div style="background:#0f172a;padding:28px;border-radius:14px;width:90%;max-width:400px;border:1px solid rgba(255,255,255,.1);">
      <h2 style="margin-top:0;font-size:19px;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:12px;margin-bottom:20px;color:#f1f5f9;">Nota da Série</h2>
      <textarea v-model="editingNoteItem.ft_extra_field" rows="4" class="ft-input" style="width:100%;box-sizing:border-box;resize:vertical;margin-bottom:20px;" placeholder="Ex: Parei no T1 Ep5..."></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button @click="editingNoteItem=null" class="ft-btn" style="background:rgba(255,255,255,.06);color:#94a3b8;border:1px solid rgba(255,255,255,.1);">Cancelar</button>
        <button @click="saveNoteEdit"         class="ft-btn" style="background:rgba(16,185,129,.15);color:#6ee7b7;border:1px solid rgba(16,185,129,.25);">Guardar</button>
      </div>
    </div>
  </div>
</div>`,
                setup() {
                    const BATCH = 50;
                    const sentinel = ref(null);
                    const searchName = ref("");
                    const filterStatus = ref("all");
                    const filterCloud = ref("all");
                    const dateStart = ref("");
                    const dateEnd = ref("");
                    const viewMode = ref(safeLSGet("panda_dash_view_mode", "card") || "card");
                    const imageCache = ref({});
                    const editingItem = ref(null);
                    const editingNoteItem = ref(null);
                    const scrapeCurrent = ref(0);
                    const scrapeTotal = ref(0);

                    const st = { localCatalog, localDown, localCopy, cloudStats: cloudStatsData, uniqueClouds: uniqueCloudsArr };
                    const statCards = {
                        'Catálogo': { count: localCatalog, color: '#0ea5e9', icon: '🔖' },
                        'Transferidos': { count: localDown, color: '#10b981', icon: '✓' },
                        'Copiados temp': { count: localCopy, color: '#f59e0b', icon: '⋯' },
                    };

                    const ar = computed(() => viewMode.value === 'poster' ? '2/3' : '16/9');

                    const filtered = computed(() => {
                        const q = searchName.value.toLowerCase();
                        const ds = dateStart.value ? new Date(dateStart.value).getTime() : 0;
                        const de = dateEnd.value ? new Date(dateEnd.value).getTime() + 86400000 : Infinity;
                        return dashboardData.value.filter(item => {
                            if (q && !(item.title || '').toLowerCase().includes(q)) return false;
                            const status = filterStatus.value, cloud = filterCloud.value;
                            if (cloud === "local") {
                                if (!item.isLocal) return false;
                                if (status === "downloaded" && !item.isLocalDownloaded) return false;
                                if (status === "history" && !item.isLocalHistory) return false;
                                if (status === "copied" && !item.isCopied) return false;
                            } else if (cloud !== "all") {
                                if (!item.sources.some(s => s.name === cloud)) return false;
                                if (status === "downloaded" && !item.cloudDownloaded[cloud]) return false;
                                if (status === "history" && !item.cloudHistory[cloud]) return false;
                            } else {
                                if (status === "downloaded" && !item.isLocalDownloaded && !Object.keys(item.cloudDownloaded).length) return false;
                                if (status === "history" && !item.isLocalHistory && !Object.keys(item.cloudHistory).length) return false;
                                if (status === "copied" && !item.isCopied) return false;
                            }
                            const t = item.saved_at || 0;
                            return !(t < ds || (t > 0 && t > de));
                        });
                    });

                    const displayCount = ref(BATCH);
                    const displayed = computed(() => filtered.value.slice(0, displayCount.value));
                    const loadMore = () => { if (displayCount.value < filtered.value.length) displayCount.value += BATCH; };

                    VueLib.watch([searchName, filterStatus, filterCloud, dateStart, dateEnd], () => { displayCount.value = BATCH; });
                    VueLib.onMounted(() => {
                        if (!sentinel.value) return;
                        const obs = new IntersectionObserver(entries => { if (entries[0].isIntersecting) loadMore(); }, { root: mod, rootMargin: '200px' });
                        obs.observe(sentinel.value);
                    });

                    const toggleView = () => { viewMode.value = viewMode.value === 'card' ? 'poster' : 'card'; safeLSSet("panda_dash_view_mode", viewMode.value); };
                    const close = () => { delete window._ftDashUpdateItem; delete window._ftDashScrapeProgress; revokeAllObjectURLs(); mod.remove(); };
                    const isSaved = (item) => item.isLocalDownloaded || Object.keys(item.cloudDownloaded).length > 0;
                    const badgeIcon = (item, n) => { let i = ''; if (item.cloudDownloaded[n]) i += ICONS.download; if (item.cloudHistory[n]) i += ICONS.history; return i || ICONS.cloud; };
                    const cardStyle = (item) => {
                        let bs = 'none';
                        if (item.isLocalDownloaded) bs = '0 0 0 3px #10b981';
                        else if (Object.keys(item.cloudDownloaded).length) bs = `0 0 0 3px ${getApiColor(Object.keys(item.cloudDownloaded)[0], configs)}`;
                        return { boxShadow: bs, background: '#111', border: '1px solid #2a2a2a', borderRadius: '10px', overflow: 'hidden', display: 'flex', flexDirection: 'column', transition: 'transform 0.2s' };
                    };
                    const cardHover = (ev, enter) => { ev.currentTarget.style.transform = enter ? 'scale(1.02)' : 'scale(1)'; ev.currentTarget.style.borderColor = enter ? '#555' : '#2a2a2a'; };

                    const posterSrc = (item) => {
                        const raw = item.poster || 'https://placehold.co/280x400?text=Sem+Capa';
                        if (imageCache.value[raw]) return imageCache.value[raw];
                        imageCache.value[raw] = 'https://placehold.co/280x400?text=...';
                        getCachedImageURL(raw).then(url => { imageCache.value[raw] = url; });
                        return imageCache.value[raw];
                    };
                    const posterErr = (ev, item) => { ev.target.onerror = null; ev.target.src = item.poster || 'https://placehold.co/280x400?text=Erro'; };
                    const fmtDate = (ts) => !ts ? 'Desconhecida' : new Date(ts).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                    const copyPoster = (item) => { GM_setClipboard(item.poster || "", { type: "text/plain" }); toast('Poster copiado!'); };
                    const hasWriteAccess = (item) => item.isLocal || item.sources.some(s => configs.find(c => c.name === s.name)?.apiKey);

                    const openEditModal = (item) => { editingItem.value = { ...item }; };
                    const saveEdit = () => {
                        if (!editingItem.value) return;
                        const it = { ...editingItem.value, updated_at: Date.now() };
                        [STORE_CATALOG, STORE_DOWNLOADED, STORE_DOWNLOAD_LIST].forEach(KEY => {
                            const list = getStored(KEY), idx = list.findIndex(u => u.url === it.url);
                            if (idx !== -1) { list[idx] = { ...list[idx], title: it.title, poster: it.poster, updated_at: it.updated_at }; setStored(KEY, list); }
                        });
                        const copy = [...dashboardData.value], dIdx = copy.findIndex(i => i.url === it.url);
                        if (dIdx !== -1) copy[dIdx] = { ...copy[dIdx], ...it };
                        dashboardData.value = copy;
                        saveToCloud(); toast('Item atualizado!'); editingItem.value = null;
                    };

                    const openNoteModal = (item) => { editingNoteItem.value = { url: item.url, ft_extra_field: item.ft_extra_field || '' }; };
                    const saveNoteEdit = () => {
                        if (!editingNoteItem.value) return;
                        const it = editingNoteItem.value, savedAt = Date.now();
                        let list = getStored(STORE_EXTRA_FIELD);
                        const idx = list.findIndex(u => u.url === it.url);
                        if (idx !== -1) list[idx] = { url: it.url, ft_extra_field: it.ft_extra_field, saved_at: savedAt };
                        else list.push({ url: it.url, ft_extra_field: it.ft_extra_field, saved_at: savedAt });
                        setStored(STORE_EXTRA_FIELD, list);
                        const copy = [...dashboardData.value], dIdx = copy.findIndex(i => i.url === it.url);
                        if (dIdx !== -1) copy[dIdx] = { ...copy[dIdx], ft_extra_field: it.ft_extra_field };
                        dashboardData.value = copy;
                        saveToCloud(); toast('Nota guardada!'); editingNoteItem.value = null;
                    };

                    const deleteItem = async (item) => {
                        if (!await ftConfirm(`Apagar "${item.title || item.url}"?`, "Apagar Item")) return;
                        [STORE_CATALOG, STORE_DOWNLOADED, STORE_DOWNLOAD_LIST].forEach(KEY => {
                            setStored(KEY, getStored(KEY).filter(u => u.url !== item.url));
                        });
                        dashboardData.value = dashboardData.value.filter(i => i.url !== item.url);
                        pendingRef.value = pendingRef.value.filter(i => i.url !== item.url);
                        await removeFromCloud(item.url);
                    };

                    const exportFiltered = () => {
                        const data = filtered.value;
                        if (!data.length) return toast('Nada para exportar.');
                        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a"); a.href = url; a.download = `ft_export_${data.length}_${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
                    };

                    return {
                        dashboardData, pendingRef, searchName, filterStatus, filterCloud, dateStart, dateEnd,
                        viewMode, imageCache, st, statCards, ar, filtered, displayed, sentinel,
                        toggleView, close, isSaved, badgeIcon, cardStyle, cardHover, posterSrc, posterErr,
                        fmtDate, copyPoster, editingItem, openEditModal, saveEdit, deleteItem, hasWriteAccess,
                        scrapeCurrent, scrapeTotal, editingNoteItem, openNoteModal, saveNoteEdit, exportFiltered
                    };
                }
            });

            app.mount(mountEl);

            window._ftDashScrapeProgress = (current, total) => {
                const st = app._instance?.setupState;
                if (st?.scrapeCurrent?.value !== undefined) st.scrapeCurrent.value = current;
                if (st?.scrapeTotal?.value !== undefined) st.scrapeTotal.value = total;
            };

            window._ftDashUpdateItem = (url, title, poster, year) => {
                const pIdx = pendingRef.value.findIndex(i => i.url === url);
                if (pIdx !== -1) pendingRef.value = pendingRef.value.filter((_, i) => i !== pIdx);
                const dIdx = dashboardData.value.findIndex(i => i.url === url);
                if (title && poster && !poster.includes('placehold')) {
                    if (dIdx !== -1) {
                        const copy = [...dashboardData.value]; copy[dIdx] = { ...copy[dIdx], title, poster, year: year || copy[dIdx].year };
                        dashboardData.value = copy;
                    }
                }
            };
        }

        /* =====================================================================
           TUTORIAL — Cloudflare Worker
           ===================================================================== */

        function openWorkerTutorialUI() {
            document.getElementById("ft-cloud-tutorial")?.remove();

            const GITHUB_URL = "https://github.com/Blackspirits/media-sync/blob/main/worker/worker.js";
            const GITHUB_REPO_URL = "https://github.com/Blackspirits/media-sync";

            const mod = document.createElement("div");
            mod.id = "ft-cloud-tutorial";
            mod.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:20001;
            display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);`;

            const box = document.createElement("div");
            box.style.cssText = `background:#0a0e16;border:1px solid rgba(255,255,255,.09);padding:0;width:620px;max-width:92%;
            border-radius:14px;color:#e2e8f0;max-height:88vh;overflow:hidden;display:flex;flex-direction:column;
            font-family:system-ui,-apple-system,Segoe UI,sans-serif;
            box-shadow:0 24px 60px rgba(0,0,0,.7),0 0 0 1px rgba(220,38,38,.06);`;

            const codeStyle = "display:inline-block;background:rgba(255,255,255,.07);color:#e2e8f0;padding:2px 7px;border-radius:4px;font-family:monospace;font-size:14.5px;border:1px solid rgba(255,255,255,.1);";
            const stepNumStyle = "display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:rgba(220,38,38,.25);color:#fca5a5;font-size:13px;font-weight:700;margin-right:8px;flex-shrink:0;";
            const steps = [
                ['Criar KV', 'Workers &amp; Pages → KV → criar namespace.'],
                ['Criar Worker', `(Module Worker) → colar código do GitHub → Deploy.`],
                ['Bind KV', `Worker → Settings → Bindings → KV Namespaces → nome <span style="${codeStyle}">MEDIA</span>`],
                ['Secret', `Worker → Settings → Variables → Secrets → nome <span style="${codeStyle}">API_KEY</span>`],
                ['No script', `<b>Gerir APIs cloud</b> → URL do Worker + API Key gerada.`],
            ];
            const stepsHtml = steps.map((s, i) =>
                `<li style="display:flex;align-items:flex-start;margin-bottom:11px;font-size:15.5px;color:#cbd5e1;line-height:1.5;">
                <span style="${stepNumStyle}">${i + 1}</span>
                <span><b style="color:#f1f5f9;">${s[0]}</b>: ${s[1]}</span>
            </li>`
            ).join('');

            const btnLink = (id, href, label, bg, border) =>
                `<a id="${id}" href="${href}" target="_blank" rel="noopener"
                style="display:inline-flex;align-items:center;gap:7px;padding:9px 15px;background:${bg};color:#fff;
                border:1px solid ${border};border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">${label}</a>`;
            const btnCopy = (id, label, bg, border, color) =>
                `<button id="${id}" style="padding:9px 15px;background:${bg};color:${color};border:1px solid ${border};
                border-radius:8px;cursor:pointer;font-weight:600;font-size:15px;font-family:inherit;">${label}</button>`;

            box.innerHTML = `
        <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:space-between;background:linear-gradient(105deg,rgba(220,38,38,.1),rgba(8,12,20,0));">
            <div style="display:flex;align-items:center;gap:10px;">
                <span style="width:7px;height:7px;border-radius:50%;background:#dc2626;box-shadow:0 0 8px rgba(220,38,38,.8);display:inline-block;"></span>
                <span style="font-size:15.5px;font-weight:700;letter-spacing:.12em;color:#f1f5f9;">CLOUDFLARE WORKER — SETUP</span>
            </div>
            <button id="ft-tut-close" style="padding:6px 14px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);color:#94a3b8;border-radius:8px;cursor:pointer;font-size:15px;">Fechar</button>
        </div>
        <div style="overflow-y:auto;padding:20px;flex:1;">
            <ol style="list-style:none;margin:0 0 18px;padding:0;">${stepsHtml}</ol>

            <div style="background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:12px 15px;margin-bottom:18px;">
                <div style="font-size:13.5px;color:#64748b;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px;">⚙ Variáveis de ambiente opcionais (Settings → Variables)</div>
                <div style="display:flex;flex-direction:column;gap:5px;font-size:15px;">
                    <div><span style="${codeStyle}">ALLOWED_PREFIXES</span> <span style="color:#64748b;">— prefixos permitidos (default já inclui</span> <span style="${codeStyle}">panda_</span><span style="color:#64748b;">)</span></div>
                    <div><span style="${codeStyle}">READ_KEY</span> <span style="color:#64748b;">— chave separada para leitura (opcional)</span></div>
                    <div><span style="${codeStyle}">ALLOWED_ORIGIN</span><span style="color:#475569;">,</span> <span style="${codeStyle}">MAX_BODY</span><span style="color:#475569;">,</span> <span style="${codeStyle}">MAX_ITEMS</span></div>
                </div>
            </div>

            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
                ${btnLink("ft-tut-gh-link", GITHUB_URL, "↗ Ver Worker no GitHub", "rgba(37,99,235,.2)", "rgba(37,99,235,.4)")}
                ${btnLink("ft-tut-gh-repo", GITHUB_REPO_URL, "↗ Repositório completo", "rgba(55,65,81,.4)", "rgba(255,255,255,.12)")}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                ${btnCopy("ft-tut-copy-secret", "Copiar nome do Secret (API_KEY)", "rgba(139,92,246,.15)", "rgba(139,92,246,.35)", "#c4b5fd")}
                ${btnCopy("ft-tut-copy-kv", "Copiar KV binding (MEDIA)", "rgba(16,185,129,.15)", "rgba(16,185,129,.35)", "#6ee7b7")}
                ${btnCopy("ft-tut-copy-pfx", "Copiar prefixo (panda_)", "rgba(14,165,233,.15)", "rgba(14,165,233,.35)", "#7dd3fc")}
            </div>
        </div>`;

            mod.appendChild(box);
            document.body.appendChild(mod);

            const close = () => mod.remove();
            box.querySelector("#ft-tut-close").onclick = close;
            mod.addEventListener("click", (e) => { if (e.target === mod) close(); });
            box.querySelector("#ft-tut-copy-secret").onclick = () => { GM_setClipboard("API_KEY", { type: "text/plain" }); toast("Copiado: API_KEY"); };
            box.querySelector("#ft-tut-copy-kv").onclick = () => { GM_setClipboard("MEDIA", { type: "text/plain" }); toast("Copiado: MEDIA"); };
            box.querySelector("#ft-tut-copy-pfx").onclick = () => { GM_setClipboard("panda_", { type: "text/plain" }); toast("Copiado: panda_"); };
        }

        /* =====================================================================
           AUTO SCROLL
           ===================================================================== */

        let autoScrolling = false;
        let autoScrollTimer = null;

        function stopAutoScroll(btn) {
            autoScrolling = false;
            if (autoScrollTimer) clearTimeout(autoScrollTimer);
            autoScrollTimer = null;
            toast("Scroll automático parado.");
        }

        async function startAutoScroll(btn) {
            if (autoScrolling) return;
            autoScrolling = true;
            toast("Scroll automático a iniciar...");
            let stable = 0, lastTotal = collectLinksFromPage().all.length;
            const step = async () => {
                if (!autoScrolling) return;
                window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
                await new Promise(r => setTimeout(r, 1200));
                updateStats();
                const nowTotal = collectLinksFromPage().all.length;
                if (nowTotal <= lastTotal) stable++; else stable = 0;
                lastTotal = nowTotal;
                if (stable >= 6) { stopAutoScroll(); toast("Chegou ao fim."); return; }
                autoScrollTimer = setTimeout(step, 700);
            };
            step();
        }

        function toggleAutoScroll(btn) { if (autoScrolling) stopAutoScroll(); else startAutoScroll(); }

        /* =====================================================================
           MENU COMMANDS
           ===================================================================== */

        GM_registerMenuCommand("Guardar catálogo (Nuvem)", saveHistory);
        GM_registerMenuCommand("Copiar links visíveis", copyLinksToClipboard);
        GM_registerMenuCommand("Marcar Transferidos", markCopiedAsDownloaded);
        GM_registerMenuCommand("Reset Copiados", resetCopiedLinks);
        GM_registerMenuCommand("Gerir APIs Cloud", openApiManagerUI);
        GM_registerMenuCommand("Exportar Backup (JSON)", exportData);
        GM_registerMenuCommand("Importar Backup (JSON)", importData);
        GM_registerMenuCommand("Scroll automático (ON/OFF)", () => toggleAutoScroll());

        /* =====================================================================
           MIGRAÇÃO DE DADOS LEGACY (ft_* → panda_*)
           ===================================================================== */

        function migrateLegacyKeys() {
            const migrations = [
                ["ft_catalog", STORE_CATALOG],
                ["ft_downloaded", STORE_DOWNLOADED],
                ["ft_download_list", STORE_DOWNLOAD_LIST],
                ["ft_extra_field", STORE_EXTRA_FIELD],
            ];
            let migrated = 0;
            for (const [oldKey, newKey] of migrations) {
                let oldData = null;
                try { oldData = localStorage.getItem(oldKey); } catch { /* bloqueado */ }
                if (!oldData) oldData = GM_getValue(oldKey, null);
                if (!oldData || oldData === "[]") continue;
                // Só migra se a nova key ainda não tiver dados
                let newData = null;
                try { newData = localStorage.getItem(newKey); } catch { /* bloqueado */ }
                if (!newData) newData = GM_getValue(newKey, null);
                if (newData && newData !== "[]") continue; // nova key já tem dados, não sobrescrever
                try { localStorage.setItem(newKey, oldData); } catch { /* bloqueado */ }
                GM_setValue(newKey, oldData);
                // Limpar legacy
                try { localStorage.removeItem(oldKey); } catch { /* bloqueado */ }
                GM_setValue(oldKey, "[]");
                migrated++;
            }
            // Migrar api_configs
            const oldApiKey = "ft_api_configs";
            const newApiKey = "tvcine_api_configs";
            const oldApi = GM_getValue(oldApiKey, null);
            const newApi = GM_getValue(newApiKey, null);
            if (oldApi && !newApi) { GM_setValue(newApiKey, oldApi); GM_setValue(oldApiKey, "[]"); migrated++; }
            // Migrar hide/pos keys
            [
                ["ft_hide_downloaded_v1", "tvcine_hide_downloaded_v1"],
                ["ft_hide_history_v1", "tvcine_hide_history_v1"],
                ["ft_ui_pos_v1", "tvcine_ui_pos_v1"],
                ["ft_ui_min_v1", "tvcine_ui_min_v1"],
            ].forEach(([ok, nk]) => {
                const ov = GM_getValue(ok, null);
                const nv = GM_getValue(nk, null);
                if (ov !== null && nv === null) { GM_setValue(nk, ov); GM_setValue(ok, null); }
            });
            if (migrated > 0) console.log(`[TVCine] ${migrated} chave(s) migradas de ft_* para panda_*.`);
        }

        /* =====================================================================
           INIT / AUTO UPDATES
           ===================================================================== */

        let _tAuto = 0;
        let _observer = null;
        let _inited = false;
        let _needsFullScan = false;

        function scheduleUpdate() {
            clearTimeout(_tAuto);
            _tAuto = setTimeout(() => {
                if (!document.getElementById("ft-panel")) {
                    try { injectUI(); } catch (e) { console.error("Falha ao reinjetar UI:", e); }
                }
                try { injectHideButtons(); } catch { }
                try { injectDetailPageButtons(); } catch { }
                try { if (_needsFullScan) { document.querySelectorAll(CARD_ROOT_SELECTOR).forEach(queueCard); _needsFullScan = false; } } catch { }
            }, AUTO_UPDATE_MS);
        }

        function ensureObserver() {
            if (_observer || !document.body) return;
            _observer = new MutationObserver((muts) => {
                let touched = false;
                for (const m of muts) {
                    for (const n of m.addedNodes) {
                        if (!n || n.nodeType !== 1) continue;
                        // Re-aplicar modificações ao header quando o Nuxt o recriar
                        if (n.classList?.contains('header-1') || n.querySelector?.('.header-1')) {
                            try { injectHeaderModifications(); } catch { }
                        }
                        if (n.matches?.(CARD_ROOT_SELECTOR)) { queueCard(n); touched = true; }
                        const found = n.querySelectorAll?.(CARD_ROOT_SELECTOR);
                        if (found?.length) { found.forEach(queueCard); touched = true; }
                    }
                }
                try { injectHideButtons(); } catch { }
                try { injectDetailPageButtons(); } catch { }
                if (touched) scheduleUpdate();
            });
            _observer.observe(document.body, { childList: true, subtree: true });
        }

        function hookSpaNavigation() {
            if (window.__ftSpaHooked) return;
            window.__ftSpaHooked = true;

            const _ps = history.pushState;
            history.pushState = function (...args) {
                const r = _ps.apply(this, args);
                _needsFullScan = true; setTimeout(scheduleUpdate, 50);
                setTimeout(() => { try { injectHeaderModifications(); injectDetailPageButtons(); } catch { } }, 300);
                return r;
            };
            const _rs = history.replaceState;
            history.replaceState = function (...args) {
                const r = _rs.apply(this, args);
                _needsFullScan = true; setTimeout(scheduleUpdate, 50);
                setTimeout(() => { try { injectHeaderModifications(); injectDetailPageButtons(); } catch { } }, 300);
                return r;
            };
            window.addEventListener("popstate", () => {
                _needsFullScan = true; setTimeout(scheduleUpdate, 50);
                setTimeout(() => { try { injectHeaderModifications(); injectDetailPageButtons(); } catch { } }, 300);
            });
        }

        /* =====================================================================
           PANDA+ HEADER MENU MODS (?watch_more=1 & Destaques)
           ===================================================================== */

        function injectHeaderModifications() {
            // Adicionar ?watch_more=1 a todos os links de navegação do header
            // O Nuxt intercepta clicks e usa o router interno — por isso adicionamos
            // um listener de click que navega via window.location para garantir o param
            const allNavLinks = document.querySelectorAll(
                '.header-1 .nav-bar a, .sidebar-mobile a'
            );
            allNavLinks.forEach(a => {
                if (a.dataset.ftWatchMore) return; // já processado
                const rel = a.getAttribute('href') || '';
                const resolved = a.href || '';
                const isFilter = rel.includes('/filters/') || resolved.includes('/filters/');
                if (!isFilter) return;

                // Adicionar ?watch_more=1 ao atributo href (para o tooltip/hover)
                if (!rel.includes('watch_more=1') && !resolved.includes('watch_more=1')) {
                    try {
                        const base = rel.startsWith('/') ? rel : '/' + rel;
                        const urlObj = new URL(base, location.origin);
                        urlObj.searchParams.set('watch_more', '1');
                        const newHref = urlObj.pathname + urlObj.search;
                        a.setAttribute('href', newHref);
                    } catch { /* URL inválida */ }
                }

                // Interceptar o click para forçar navegação com o param
                // (o router Nuxt/Vue ignora alterações ao href no DOM)
                a.dataset.ftWatchMore = '1';
                a.addEventListener('click', (e) => {
                    const currentHref = a.getAttribute('href') || '';
                    if (currentHref.includes('watch_more=1')) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        window.location.href = currentHref;
                    }
                }, true); // capture=true para ser antes do handler do Nuxt
            });

            // Injetar item "Destaques" no menu do header (desktop)
            const desktopMenu = document.querySelector('.header-1 .header-menu-section');
            if (desktopMenu && !desktopMenu.querySelector('.ft-destaques-link')) {
                // Encontrar o link "Início" como base estrutural (clonar o primeiro original)
                const templateLink = desktopMenu.querySelector('a');
                const clone = templateLink?.cloneNode(true);
                if (clone) {
                    clone.classList.add('ft-destaques-link');
                    clone.setAttribute('href', '/filters/destaques?watch_more=1');
                    clone.href = '/filters/destaques?watch_more=1';
                    clone.removeAttribute('aria-current');
                    clone.classList.remove('nuxt-link-exact-active', 'nuxt-link-active');

                    // Atualizar texto e icon
                    const textEl = clone.querySelector('.texts p');
                    if (textEl) textEl.textContent = 'Destaques';
                    const arrow = clone.querySelector('.arrow-active');
                    if (arrow) arrow.remove();

                    // Ícone novo (★ estrela SVG branca, centrada acima do texto)
                    const menuIconBox = clone.querySelector('.menu-icon');
                    if (menuIconBox) {
                        // Trocar a cor de fundo para amarelo (igual ao Aprende)
                        menuIconBox.classList.forEach(cls => {
                            if (cls.startsWith('bg-brand')) menuIconBox.classList.remove(cls);
                        });
                        menuIconBox.classList.add('bg-brandPanda');
                        // Ocultar imagem herdada
                        const iconImg = menuIconBox.querySelector('img');
                        if (iconImg) iconImg.style.display = 'none';
                        // Layout em coluna centrado (igual aos outros itens do header)
                        menuIconBox.style.cssText += ';display:inline-flex;flex-direction:column;align-items:center;justify-content:center;';
                        const starSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                        starSvg.setAttribute('width', '24'); starSvg.setAttribute('height', '24');
                        starSvg.setAttribute('viewBox', '0 0 24 24');
                        starSvg.setAttribute('fill', 'white');
                        starSvg.setAttribute('stroke', 'none');
                        starSvg.innerHTML = '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>';
                        // Inserir ANTES do .texts para ficar por cima do texto
                        const textsDiv = menuIconBox.querySelector('.texts');
                        if (textsDiv) {
                            menuIconBox.insertBefore(starSvg, textsDiv);
                        } else {
                            menuIconBox.appendChild(starSvg);
                        }
                    }

                    // Adicionar separador antes de Destaques
                    const sep = document.createElement('span');
                    sep.className = 'ft-destaques-sep';
                    desktopMenu.appendChild(sep);
                    desktopMenu.appendChild(clone);
                }
            }

            // Injetar item "Destaques" na sidebar mobile
            const sidebar = document.querySelector('.sidebar-mobile .content > .p-10:first-of-type');
            if (sidebar && !sidebar.querySelector('.ft-destaques-link')) {
                const templateLink = sidebar.querySelector('a');
                const clone = templateLink?.cloneNode(true);
                if (clone) {
                    clone.classList.add('ft-destaques-link');
                    clone.setAttribute('href', '/filters/destaques?watch_more=1');
                    clone.href = '/filters/destaques?watch_more=1';
                    clone.removeAttribute('aria-current');
                    clone.classList.remove('nuxt-link-exact-active', 'nuxt-link-active');
                    const textEl = clone.querySelector('.texts p');
                    if (textEl) textEl.textContent = 'Destaques';
                    const arrow = clone.querySelector('.arrow-active-sidebar');
                    if (arrow) arrow.remove();

                    // Ícone estrela branca centrada acima do texto (mobile)
                    const mobileIconBox = clone.querySelector('.menu-icon-wrapper');
                    const mobileImg = clone.querySelector('img.menu-icon-mobile');
                    if (mobileImg) mobileImg.style.display = 'none';
                    if (mobileIconBox) {
                        // Trocar cor de fundo para amarelo
                        const mobileIconEl = mobileIconBox.querySelector('.menu-icon-mobile, [class*="menu-icon"]');
                        if (mobileIconEl) {
                            mobileIconEl.classList.forEach(cls => {
                                if (cls.startsWith('bg-brand')) mobileIconEl.classList.remove(cls);
                            });
                            mobileIconEl.classList.add('bg-brandPanda');
                        }
                        mobileIconBox.style.cssText += ';display:inline-flex;flex-direction:column;align-items:center;justify-content:center;';
                        const starSvgMb = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                        starSvgMb.setAttribute('width', '40'); starSvgMb.setAttribute('height', '40');
                        starSvgMb.setAttribute('viewBox', '0 0 24 24');
                        starSvgMb.setAttribute('fill', 'white');
                        starSvgMb.setAttribute('stroke', 'none');
                        starSvgMb.innerHTML = '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>';
                        // Inserir como primeiro filho para ficar acima do texto
                        mobileIconBox.insertBefore(starSvgMb, mobileIconBox.firstChild);
                    }

                    // Separador antes
                    const sepMb = document.createElement('div');
                    sepMb.style.cssText = 'height:1px;background:rgba(255,255,255,.12);margin:4px 0;';
                    sidebar.appendChild(sepMb);
                    sidebar.appendChild(clone);
                }
            }
        }

        /* =====================================================================
           PANDA+ DETAIL PAGE BUTTONS ("JÁ TEMOS" / "GUARDAR")
           ===================================================================== */

        function injectDetailPageButtons() {
            if (!isRelevantFTItem(window.location.pathname)) return;

            const desktopContainer = document.querySelector('.details-web .buttons-web');
            const mobileContainer = document.querySelector('.details-mobile .secondary-buttons-mobile');

            if (!desktopContainer && !mobileContainer) return;
            if (document.querySelector('.ft-detail-buttons-injected')) return;

            const href = normUrl(window.location.href);
            const cache = buildStoreCache();
            const isDownloaded = cache.setDownloaded.has(href);
            const isCatalog = cache.setCatalog.has(href);

            const title = safeTrim(document.querySelector('.title01')?.textContent || document.querySelector('.mobileTitle01')?.textContent || document.title);
            const posterEl = document.querySelector('.detail-header-web') || document.querySelector('.detail-header-mobile');
            const posterMatch = posterEl?.style.backgroundImage.match(/url\(\s*["']?(.*?)["']?\s*\)/);
            const poster = posterMatch ? posterMatch[1].replace(/["']/g, '') : "";

            const createBtn = (isMb, isDwn) => {
                const btn = document.createElement("button");
                btn.className = `focusable ft-detail-buttons-injected ${isMb ? 'btn-icon-web' : 'btn-icon-left-web'}`;
                btn.style.cssText = isMb
                    ? "margin-left:8px; padding:0 12px; border-radius:24px; font-weight:bold; height:40px; display:inline-flex; align-items:center; font-size:15px; transition:all 0.2s;"
                    : "margin-left:12px; padding:0 24px; border-radius:24px; font-weight:bold; height:48px; display:inline-flex; align-items:center; transition:all 0.2s;";

                if (isDwn) { // Downloaded
                    if (isDownloaded) {
                        btn.innerHTML = isMb ? `✅ <span style="margin-left:4px">Retirar</span>` : `✅ <span style="margin-left:8px">Retirar Transferido</span>`;
                        btn.style.backgroundColor = "#10b981"; // Green
                        btn.style.color = "#fff";
                        btn.style.border = "none";
                    } else {
                        btn.innerHTML = isMb ? `❌ <span style="margin-left:4px">Marcar</span>` : `❌ <span style="margin-left:8px">Marcar Transferido</span>`;
                        btn.style.backgroundColor = "#ef4444"; // Red
                        btn.style.color = "#fff";
                        btn.style.border = "none";
                    }
                } else { // Catalog
                    if (isCatalog) {
                        btn.innerHTML = isMb ? `✓ <span style="margin-left:4px">Retirar</span>` : `✓ <span style="margin-left:8px">Retirar (Catálogo)</span>`;
                        btn.style.backgroundColor = "#e5e7eb";
                        btn.style.color = "#4b5563";
                        btn.style.border = "1px solid #d1d5db";
                    } else {
                        btn.innerHTML = isMb ? `💾 <span style="margin-left:4px">Catálogo</span>` : `💾 <span style="margin-left:8px">Catálogo</span>`;
                        btn.style.backgroundColor = "#3b82f6";
                        btn.style.color = "#fff";
                        btn.style.border = "none";
                    }
                }

                btn.addEventListener("click", async (e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (isDwn) {
                        const existing = getStored(STORE_DOWNLOADED);
                        if (isDownloaded) {
                            setStored(STORE_DOWNLOADED, existing.filter(i => i.url !== href));
                            toast("Removido de 'Já temos'.");
                        } else {
                            setStored(STORE_DOWNLOADED, mergeData([...existing, { url: href, title, poster, saved_at: Date.now() }]));
                            toast("✅ Guardado como 'Já temos'!");
                            const cat = getStored(STORE_CATALOG);
                            setStored(STORE_CATALOG, cat.filter(i => i.url !== href));
                        }
                    } else {
                        const existing = getStored(STORE_CATALOG);
                        if (isCatalog) {
                            setStored(STORE_CATALOG, existing.filter(i => i.url !== href));
                            toast("Removido do catálogo.");
                        } else {
                            setStored(STORE_CATALOG, mergeData([...existing, { url: href, title, poster, saved_at: Date.now() }]));
                            toast("💾 Guardado no catálogo!");
                        }
                    }
                    await saveToCloud();

                    // Forçar renderização de novos botões em vez de update simples
                    document.querySelectorAll('.ft-detail-buttons-injected').forEach(b => b.remove());
                    injectDetailPageButtons();
                    refreshAllCards(); updateStats();
                });
                return btn;
            };

            if (desktopContainer && !desktopContainer.querySelector('.ft-detail-buttons-injected')) {
                desktopContainer.appendChild(createBtn(false, false)); // Catalog
                desktopContainer.appendChild(createBtn(false, true));  // Downloaded
            }
            if (mobileContainer && !mobileContainer.querySelector('.ft-detail-buttons-injected')) {
                mobileContainer.appendChild(createBtn(true, false));
                mobileContainer.appendChild(createBtn(true, true));
            }

            // ---- INJETAR MARCAR VISÍVEIS (Temporada/Área) ----
            // O selector procura pelo swiper-tabs (Temporadas) ou diretamente a grelha de episódios caso o filme/série nao tenha separador
            let gridRoot = document.querySelector('.swiper-tabs');
            if (!gridRoot) {
                const epGrids = document.querySelectorAll('.filters-content.grid');
                if (epGrids.length > 0) gridRoot = epGrids[0]; // fallback
            }

            if (gridRoot && !document.querySelector('.ft-mark-season-btn')) {
                const wrapper = document.createElement("div");
                wrapper.className = "ft-mark-season-btn"; // classe de tracking
                wrapper.style.display = "flex";
                wrapper.style.gap = "8px";
                wrapper.style.margin = "8px 0";

                if (gridRoot.classList.contains('swiper-tabs')) {
                    wrapper.style.justifyContent = "flex-end";
                    wrapper.style.width = "100%";
                }

                const btnSeason = document.createElement("button");
                btnSeason.className = "focusable btn-icon-left-web text-btnText02";
                btnSeason.style.cssText = "padding:0 16px; border-radius:24px; font-weight:bold; height:32px; display:inline-flex; align-items:center; background-color:#ffa61a; color:#000; border:none; font-size:15px; cursor:pointer;";
                btnSeason.innerHTML = `✅ Marcar visíveis`;
                btnSeason.title = "Marca todos os episódios listados abaixo como 'Já temos'";

                const btnUnmark = document.createElement("button");
                btnUnmark.className = "focusable btn-icon-left-web text-btnText02";
                btnUnmark.style.cssText = "padding:0 16px; border-radius:24px; font-weight:bold; height:32px; display:inline-flex; align-items:center; background-color:rgba(255,166,26,0.15); color:#ffa61a; border:1px solid rgba(255,166,26,0.3); font-size:15px; cursor:pointer;";
                btnUnmark.innerHTML = `❌ Desmarcar visíveis`;
                btnUnmark.title = "Remove todos os episódios listados abaixo de 'Já temos'";

                btnSeason.addEventListener("click", async (e) => {
                    e.preventDefault(); e.stopPropagation();
                    // Procura os episódios que estão atualmente visíveis no DOM
                    const episodeCards = [...document.querySelectorAll("a[href^='/vod/']")].filter(a => !!a.closest('.grid'));
                    if (episodeCards.length === 0) {
                        toast("Nenhum episódio localizado nesta vista.");
                        return;
                    }

                    let added = 0;
                    let existing = getStored(STORE_DOWNLOADED);
                    const curCache = buildStoreCache();

                    for (const ep of episodeCards) {
                        const epHref = normUrl(ep.href);
                        if (!curCache.setDownloaded.has(epHref)) {
                            const epTitle = safeTrim(ep.getAttribute("alt") || ep.querySelector('.text-cardText01')?.textContent || "Episódio");
                            const epBg = ep.querySelector('.thumbnail')?.style.backgroundImage || "";
                            const epMatch = epBg.match(/url\(\s*['"]?(.*?)['"]?\s*\)/);
                            const epPoster = epMatch ? epMatch[1].replace(/["']/g, '') : "";
                            existing = mergeData([...existing, { url: epHref, title: epTitle, poster: epPoster, saved_at: Date.now() }]);
                            added++;
                        }
                    }

                    if (added > 0) {
                        setStored(STORE_DOWNLOADED, existing);
                        await saveToCloud();
                        toast(`✅ ${added} episódios marcados como 'Já temos'!`);
                        refreshAllCards(); updateStats();
                    } else {
                        toast("Todos já estavam marcados.");
                    }
                });

                btnUnmark.addEventListener("click", async (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const episodeCards = [...document.querySelectorAll("a[href^='/vod/']")].filter(a => !!a.closest('.grid'));
                    if (episodeCards.length === 0) {
                        toast("Nenhum episódio localizado nesta vista.");
                        return;
                    }

                    let removed = 0;
                    let existing = getStored(STORE_DOWNLOADED);
                    const curCache = buildStoreCache();
                    const toRemove = new Set();

                    for (const ep of episodeCards) {
                        const epHref = normUrl(ep.href);
                        if (curCache.setDownloaded.has(epHref)) {
                            toRemove.add(epHref);
                            removed++;
                        }
                    }

                    if (removed > 0) {
                        setStored(STORE_DOWNLOADED, existing.filter(i => !toRemove.has(i.url)));
                        await saveToCloud();
                        toast(`❌ ${removed} episódios removidos de 'Já temos'!`);
                        refreshAllCards(); updateStats();
                    } else {
                        toast("Nenhum episódio estava marcado.");
                    }
                });

                wrapper.appendChild(btnSeason);
                wrapper.appendChild(btnUnmark);

                if (gridRoot.classList.contains('swiper-tabs')) {
                    gridRoot.parentNode.insertBefore(wrapper, gridRoot.nextSibling);
                } else {
                    gridRoot.parentNode.insertBefore(wrapper, gridRoot);
                }
            }
        }

        function init() {
            if (_inited) return;
            if (document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", init, { once: true });
                return;
            }
            _inited = true;

            try { migrateLegacyKeys(); } catch (e) { console.warn("migrateLegacyKeys falhou:", e); }
            try { injectUI(); } catch (e) { console.error("injectUI falhou:", e); }
            try { injectHeaderModifications(); } catch (e) { console.warn("injectHeaderModifications falhou:", e); }

            try { injectHideButtons(); } catch { }
            try { highlightSavedLinks(); } catch (e) { console.warn("highlightSavedLinks falhou:", e); }

            ensureObserver();
            try { document.querySelectorAll(CARD_ROOT_SELECTOR).forEach(queueCard); } catch { }
            try { fetchCloudData(); } catch (e) { console.warn("fetchCloudData falhou:", e); }

            hookSpaNavigation();
            window.addEventListener("scroll", scheduleUpdate, { passive: true });
            scheduleUpdate();
        }

        init();

})();
