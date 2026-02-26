// ==UserScript==
// @name         FilmTwist.pt — Gestor de Catálogo, Downloads & Sync Cloud
// @namespace    blackspirits.github.io/
// @version      1.8.1
// @description  Conta e guarda filmes/curtas do FilmTwist.pt, sincroniza com Cloudflare Workers (multi-API), gere downloads e copiados, e apresenta uma Dashboard com filtros, posters, notas e exportação.
// @author       BlackSpirits & Leinad4Mind
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=filmtwist.pt
// @match        https://www.filmtwist.pt/*
// @match        https://filmtwist.pt/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// ==/UserScript==

/*
 * CHANGELOG
 * ─────────────────────────────────────────────────────────────────────────────
 * v1.8.1 — Badge catálogo: emoji 📜 → ICONS.history SVG (consistente com Filmin).
 * v1.8.0 — Toasts: slide-in da direita com cubic-bezier, fade-out com animationend;
 *             ICONS{} library (Lucide SVG, sem dependências externas); makeButton
 *             suporta icon:; cloud badges, poster-copy, dashboard badges → SVG.
 * v1.7.0 — Select/dropdown fundo escuro (color-scheme:dark + option bg #0f172a);
 *             labels stat grid #475569→#94a3b8, datas cards #334155→#64748b;
 *             ícone catálogo → bookmark sólido; hide btns estilo nativo + margin-left:auto.
 * v1.6.0 — UX polish: tutorial Passo-a-Passo redesenhado (dark #0a0e16, steps numerados,
 *            env vars formatadas); botão "✦ Gerar" API Key segura (crypto.getRandomValues);
 *            badges on-page visíveis no hover (opacity 0→1), top-left; labels stats mais
 *            legíveis (#64748b); botões hide-btn matching site.
 * v1.5.0 — UX polish: stats grid compacto com ícones SVG nítidos; badge on-page movido
 *           para bottom-left (evita sobreposição de texto "Série"/"Novos Episódios");
 *           API Manager completamente redesenhado (dark #0a0e16, glassmorphism, botões
 *           consistentes com painel, focus ring vermelho nos inputs).
 * v1.4.0 — UX redesign: painel flutuante unificado com Filmin (largura 320px consistente,
 *           stats em grid 2×2 com números em destaque, botões com accent colorido + hover,
 *           ponto de cor no header). Dashboard: fundo #060c18, stat cards com ícone+cor,
 *           cloud cards, toolbar glassmorphism, cards hover suave, modais actualizados.
 * v1.3.0 — Segurança: esc() em openApiManagerUI previne XSS ao renderizar nomes de API
 *           guardados pelo utilizador (api.name já não é interpolado raw em innerHTML).
 *           Rate limit 429: sleep bloqueante de 5min substituído por 60s não bloqueante.
 * v1.2.0 — @match alargado (www + non-www). Breakpoint de 3 colunas: 1000px → 900px
 *           (mantém 4 colunas em janelas desktop reais). Worker POST corrigido (Opção B):
 *           array vazio intencional grava "[]"; array que ficou vazio após validação não
 *           sobrescreve dados existentes na cloud.
 * v1.1.0 — Prefixos corrigidos ft_* → filmtwist_* (evita colisão com outros serviços no
 *           mesmo KV). Migração automática de dados legacy no arranque. Tutorial Worker
 *           simplificado: link GitHub em vez de código embutido. Worker tutorial actualizado
 *           para versão unificada multi-serviço (GET com auth obrigatório, ALLOWED_PREFIXES).
 * v1.0.0 — Versão inicial. Arquitectura baseada no Filmin v5.5.7:
 *           • Observer incremental (WeakSet + RAF + queueCard/_flushCards)
 *           • SPA hooks (pushState/replaceState/popstate)
 *           • Multi-cloud sync (Cloudflare Workers)
 *           • Dashboard (Vue 3) com filtros, poster, notas, exportação
 *           • Sem distinção pago/grátis — FilmTwist é subscription única
 *           • Cards: article.posters-item | link: a.posters-item-link
 *           • Poster: picture img[src] | título: article[title] / img[alt]
 *           • Injecção do painel de ocultar junto a .catalogue-movies-list-sort
 * ─────────────────────────────────────────────────────────────────────────────
 */

(() => {
    "use strict";

    /* =====================================================================
       CONSTANTES
       ===================================================================== */

    const STORE_CATALOG       = "filmtwist_catalog";        // histórico visto/guardado
    const STORE_DOWNLOADED    = "filmtwist_downloaded";     // transferidos definitivamente
    const STORE_DOWNLOAD_LIST = "filmtwist_download_list";  // copiados temporários
    const STORE_EXTRA_FIELD   = "filmtwist_extra_field";    // notas de série
    const STORE_API_CONFIGS   = "filmtwist_api_configs";    // configurações das APIs cloud

    const UI_POS_KEY = "filmtwist_ui_pos_v1";
    const UI_MIN_KEY = "filmtwist_ui_min_v1";

    // Selector raiz dos cards
    const CARD_ROOT_SELECTOR = "article.posters-item";

    // URL base do site
    const SITE_ORIGIN = "https://www.filmtwist.pt";

    const AUTO_UPDATE_MS = 650;

    /* =====================================================================
       ESTADO GLOBAL
       ===================================================================== */

    let cloudSaves       = {};   // url → [apiName, ...]
    let cloudFullData    = [];
    let cloudExtraFields = [];
    let _cloudFetchSeq   = 0;

    let hideDownloaded = GM_getValue("filmtwist_hide_downloaded_v1", false);
    let hideHistory    = GM_getValue("filmtwist_hide_history_v1",    false);

    /* =====================================================================
       CACHE DE IMAGENS (IndexedDB)
       ===================================================================== */

    const IMG_DB_NAME    = "filmtwist_img_cache_db";
    const IMG_STORE_NAME = "images";
    const OBJ_URL_CAP    = 400;

    const _objUrls = new Map();

    function _revokeOldObjectURLs() {
        if (_objUrls.size <= OBJ_URL_CAP) return;
        const inUse = new Set(
            [...document.querySelectorAll('img[src^="blob:"]')].map(img => img.currentSrc || img.src)
        );
        for (const [k, obj] of _objUrls) {
            if (_objUrls.size <= OBJ_URL_CAP) break;
            if (inUse.has(obj)) continue;
            URL.revokeObjectURL(obj);
            _objUrls.delete(k);
        }
    }

    function revokeAllObjectURLs() {
        for (const obj of _objUrls.values()) {
            try { URL.revokeObjectURL(obj); } catch { /* ignora */ }
        }
        _objUrls.clear();
    }

    let _imgDbPromise = null;
    function openImageDB() {
        if (_imgDbPromise) return _imgDbPromise;
        _imgDbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(IMG_DB_NAME, 1);
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
                onerror: () => resolve(url)
            });
        });
    }

    /* =====================================================================
       CSS GLOBAL
       ===================================================================== */

    const globStyle = document.createElement('style');
    globStyle.innerHTML = `
        .ft-cloud-badge { opacity:0; transition:opacity 0.18s ease !important; }
        .posters-item:hover .ft-cloud-badge,
        article:hover .ft-cloud-badge { opacity:1 !important; }
        .ft-hide-btn { padding:6px 12px; border-radius:4px; border:1px solid rgba(255,255,255,0.18);
            background:rgba(26,27,37,0.9); color:#d4d8e0; cursor:pointer; font-size:12px;
            font-family:inherit; display:inline-flex; align-items:center; gap:6px;
            letter-spacing:.01em; transition:background .15s,border-color .15s,color .15s;
            white-space:nowrap; }
        .ft-hide-btn:hover { background:rgba(50,55,70,0.95); border-color:rgba(255,255,255,0.32); color:#fff; }
    `;
    (document.head || document.documentElement).appendChild(globStyle);

    /* =====================================================================
       HELPERS LOCALSTORAGE SEGURO
       ===================================================================== */

    function safeLSGet(key, fallback = null) {
        try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
    }
    function safeLSSet(key, val) {
        try { localStorage.setItem(key, val); } catch { /* bloqueado */ }
    }

    /* =====================================================================
       HELPERS GENÉRICOS
       ===================================================================== */

    const toObj    = (item) => {
        if (!item) return null;
        if (typeof item === "string") return { url: item, title: "", poster: "" };
        if (typeof item === "object") return item;
        return null;
    };
    const safeTrim = (s) => String(s || "").trim();

    const isValidHttpUrl = (v) => {
        const s = safeTrim(v);
        if (!s || (!s.startsWith("http://") && !s.startsWith("https://"))) return false;
        try { new URL(s); return true; } catch { return false; }
    };

    const toAbsUrl = (href) => {
        if (!href) return "";
        if (href.startsWith("http://") || href.startsWith("https://")) return href;
        try { return new URL(href, location.origin).toString(); } catch { return href; }
    };

    const normUrl = (urlStr) => {
        if (!urlStr) return "";
        const abs = toAbsUrl(urlStr);
        try {
            const u = new URL(abs);
            u.search = "";
            let s = u.toString();
            if (s.endsWith('/')) s = s.slice(0, -1);
            return s;
        } catch { return abs; }
    };

    const betterTitle = (n, o) => {
        const nn = safeTrim(n), oo = safeTrim(o);
        if (!nn) return oo;
        if (!oo) return nn;
        return nn.length >= oo.length ? nn : oo;
    };

    const betterPoster = (n, o) => {
        const nn = safeTrim(n), oo = safeTrim(o);
        if (!nn || nn.length <= 8 || !isValidHttpUrl(nn)) return oo;
        return nn;
    };

    function mergeData(arr) {
        const map = new Map();
        for (const raw of (arr || [])) {
            const item = toObj(raw);
            if (!item?.url) continue;
            const url = normUrl(item.url);
            if (!url) continue;
            const ex = map.get(url);
            if (!ex) {
                map.set(url, { ...item, url, title: safeTrim(item.title), poster: safeTrim(item.poster), saved_at: item.saved_at || Date.now() });
            } else {
                map.set(url, {
                    ...ex, ...item, url,
                    saved_at: ex.saved_at || item.saved_at || Date.now(),
                    title:    betterTitle(item.title,  ex.title),
                    poster:   betterPoster(item.poster, ex.poster),
                });
            }
        }
        return Array.from(map.values());
    }

    function mergeDataPreferNewest(arr) {
        const map = new Map();
        for (const raw of (arr || [])) {
            const item = toObj(raw);
            if (!item?.url) continue;
            const url = normUrl(item.url);
            if (!url) continue;
            const ex = map.get(url);
            if (!ex) { map.set(url, { ...item, url, saved_at: item.saved_at || Date.now() }); continue; }
            map.set(url, {
                ...ex, ...item, url,
                saved_at: Math.max(ex.saved_at || 0, item.saved_at || 0) || Date.now(),
                title:   betterTitle(item.title,  ex.title),
                poster:  betterPoster(item.poster, ex.poster),
            });
        }
        return Array.from(map.values());
    }

    function isRelevantFTItem(url) {
        return url.includes("/content/");
    }

    /* =====================================================================
       TOAST / PROGRESS
       ===================================================================== */

    // ── SVG icon library (Lucide-style, no external dependency) ─────────────
    const ICONS = {
        cloud:    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`,
        download: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>`,
        history:  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l3 3"/><path d="M3.05 11a9 9 0 1 0 .5-4"/><polyline points="3 3 3 7 7 7"/></svg>`,
        copy:     `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
        check:    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
        settings: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>`,
        api:      `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
        export:   `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>`,
        poster:   `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`,
        dash:     `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
    };

    function _iconBtn(icon, text) {
        return `<span style="display:inline-flex;align-items:center;gap:6px;">${ICONS[icon]||''}${text}</span>`;
    }

    // ── Toast infrastructure (slide-in from right, CSS keyframes) ────────────
    function _injectToastCSS() {
        if (document.getElementById("ft-toast-css")) return;
        const s = document.createElement("style");
        s.id = "ft-toast-css";
        s.textContent = `
        #ft-toast-container { position:fixed;bottom:20px;right:20px;z-index:1000000;
            display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none; }
        .ft-toast { background:rgba(10,14,22,.97);color:#f1f5f9;padding:11px 18px;
            border-radius:8px;font-size:13.5px;font-weight:500;max-width:340px;
            font-family:system-ui,-apple-system,sans-serif;
            border:1px solid rgba(255,255,255,.1);border-left:3px solid #dc2626;
            box-shadow:0 8px 24px rgba(0,0,0,.6);backdrop-filter:blur(8px);
            animation:ftSlideIn .35s cubic-bezier(.16,1,.3,1) forwards; }
        .ft-toast.ft-toast-out { animation:ftSlideOut .25s ease-in forwards; }
        .ft-toast-progress { width:100%;height:4px;background:rgba(15,23,42,.97);
            border-radius:6px;padding:11px 18px;border:1px solid rgba(255,255,255,.1);
            border-left:3px solid #3b82f6;box-shadow:0 8px 24px rgba(0,0,0,.6);
            animation:ftSlideIn .35s cubic-bezier(.16,1,.3,1) forwards; }
        @keyframes ftSlideIn { from { transform:translateX(calc(100% + 24px));opacity:0; } to { transform:translateX(0);opacity:1; } }
        @keyframes ftSlideOut { from { transform:translateX(0);opacity:1; } to { transform:translateX(calc(100% + 24px));opacity:0; } }
        `;
        (document.head || document.documentElement).appendChild(s);
    }

    function _getToastContainer() {
        _injectToastCSS();
        let c = document.getElementById("ft-toast-container");
        if (!c) {
            c = document.createElement("div");
            c.id = "ft-toast-container";
            document.documentElement.appendChild(c);
        }
        return c;
    }

    function progressToast(id, title, current, total) {
        const container = _getToastContainer();
        let pToast = document.getElementById(id);
        if (!pToast) {
            pToast = document.createElement("div");
            pToast.id = id;
            pToast.className = "ft-toast ft-toast-progress";
            pToast.style.cssText = "width:300px;display:flex;flex-direction:column;gap:8px;";
            pToast.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;">
                    <span class="pt-title" style="font-weight:500;"></span>
                    <span class="pt-pct" style="font-size:11px;color:#94a3b8;">0%</span>
                </div>
                <div style="width:100%;height:4px;background:rgba(255,255,255,.12);border-radius:2px;overflow:hidden;">
                    <div class="pt-fill" style="width:0%;height:100%;background:#3b82f6;transition:width .2s;border-radius:2px;"></div>
                </div>`;
            container.appendChild(pToast);
        }
        if (total > 0) {
            const pct = Math.round((current / total) * 100);
            pToast.querySelector('.pt-title').textContent = title;
            pToast.querySelector('.pt-pct').textContent = `${current}/${total} (${pct}%)`;
            pToast.querySelector('.pt-fill').style.width = `${pct}%`;
            if (current >= total) {
                setTimeout(() => {
                    pToast.classList.add("ft-toast-out");
                    pToast.addEventListener("animationend", () => pToast.remove(), { once: true });
                }, 1000);
            }
        } else if (current === -1) {
            pToast.classList.add("ft-toast-out");
            pToast.addEventListener("animationend", () => pToast.remove(), { once: true });
        }
    }

    function toast(msg, duration = 4000) {
        const container = _getToastContainer();
        const t = document.createElement("div");
        t.className = "ft-toast";
        t.textContent = msg;
        container.appendChild(t);
        const dismiss = () => {
            t.classList.add("ft-toast-out");
            t.addEventListener("animationend", () => t.remove(), { once: true });
        };
        setTimeout(dismiss, duration);
    }

    function downloadFallback(filename, content) {
        const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    }

    /* =====================================================================
       ARMAZENAMENTO LOCAL
       ===================================================================== */

    function getStored(key) {
        let lsData = null, lsError = false;
        try { lsData = localStorage.getItem(key); }
        catch (e) { console.warn("localStorage inacessível.", e); lsError = true; }

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
            return arr.map(item => typeof item === 'string' ? { url: item, title: "", poster: "" } : item);
        } catch { return []; }
    }

    function setStored(key, list) {
        const jsonStr = key === STORE_EXTRA_FIELD
            ? JSON.stringify(mergeDataPreferNewest(list))
            : JSON.stringify(mergeData(list));
        try { localStorage.setItem(key, jsonStr); } catch (e) { console.error("Erro localStorage:", e); }
        GM_setValue(key, jsonStr);
    }

    function buildStoreCache() {
        const catalog  = getStored(STORE_CATALOG);
        const downloaded = getStored(STORE_DOWNLOADED);
        const copyList = getStored(STORE_DOWNLOAD_LIST);
        return {
            catalog, downloaded, copyList,
            setCatalog:    new Set(catalog.map(u => u.url)),
            setDownloaded: new Set(downloaded.map(u => u.url)),
            setCopyList:   new Set(copyList.map(u => u.url)),
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
            const linkEl = art.querySelector("a.posters-item-link[href]");
            if (!linkEl) continue;
            const href = normUrl(linkEl.href || toAbsUrl(linkEl.getAttribute("href") || ""));
            if (!href || !href.startsWith(SITE_ORIGIN) || !isRelevantFTItem(href)) continue;
            if (seen.has(href)) continue;
            seen.add(href);

            const imgEl  = art.querySelector("picture img") || art.querySelector("img");
            const poster = imgEl ? (imgEl.getAttribute("src") || imgEl.getAttribute("data-src") || "") : "";
            const title  = safeTrim(art.getAttribute("title") || imgEl?.getAttribute("alt") || "");

            all.push({ url: href, title, poster });
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
        const merged   = mergeData([...existing, ...all]);
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
        const storedCopy  = getStored(STORE_DOWNLOAD_LIST);
        const storedDown  = getStored(STORE_DOWNLOADED);
        const copiedSet   = new Set(storedCopy.map(u => u.url));
        const downSet     = new Set(storedDown.map(u => u.url));
        const configs     = getApiConfigs();
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
            catalog:       getStored(STORE_CATALOG),
            downloaded:    getStored(STORE_DOWNLOADED),
            download_list: getStored(STORE_DOWNLOAD_LIST),
        };
        const dateStr = new Date().toISOString().split('T')[0];
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href = url; a.download = `filmtwist_backup_${dateStr}.json`; a.click();
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
                    const inDown    = norm(data.downloaded);
                    const inCopy    = norm(data.download_list);

                    if (inCatalog.length) setStored(STORE_CATALOG,       mergeData([...getStored(STORE_CATALOG),       ...inCatalog]));
                    if (inDown.length)    setStored(STORE_DOWNLOADED,     mergeData([...getStored(STORE_DOWNLOADED),    ...inDown]));
                    if (inCopy.length)    setStored(STORE_DOWNLOAD_LIST,  mergeData([...getStored(STORE_DOWNLOAD_LIST), ...inCopy]));

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

        const sleep  = ms => new Promise(r => setTimeout(r, ms));
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
                    title = title.replace(/\s*[\|–-]\s*FilmTwist[\s\S]*/i, '').replace(/\s+/g, ' ').trim();

                    // Poster: og:image
                    let poster = doc.querySelector('meta[property="og:image"]')?.getAttribute('content')
                        || doc.querySelector("picture img")?.getAttribute("src")
                        || "";

                    item.title  = title  || "Sem Título";
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

    const _seenCards    = new WeakSet();
    const _pendingCards = new Set();
    let   _rafId        = 0;

    function queueCard(el) {
        if (!el || _seenCards.has(el)) return;
        _pendingCards.add(el);
        if (!_rafId) _rafId = requestAnimationFrame(_flushCards);
    }

    function _flushCards() {
        _rafId = 0;
        if (!_pendingCards.size) return;

        const cache    = buildStoreCache();
        const cloudMap = _buildCloudMap();
        const configs  = getApiConfigs();
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
        const linkEl = root.querySelector("a.posters-item-link[href]");
        if (!linkEl) return false;

        const href = normUrl(linkEl.href || toAbsUrl(linkEl.getAttribute("href") || ""));
        if (!href || !isRelevantFTItem(href)) return false;

        // Estado local
        const isCatalog    = cache.setCatalog.has(href);
        const isDownloaded = cache.setDownloaded.has(href);
        const isCopied     = cache.setCopyList.has(href);

        // Estado cloud
        const cloudItems        = cloudMap.get(href) || [];
        const dlCloudItems      = cloudItems.filter(i => i.listType === STORE_DOWNLOADED && readableApiNames.has(i.apiName));
        const catalogCloudItems = cloudItems.filter(i => i.listType === STORE_CATALOG    && readableApiNames.has(i.apiName));

        const isSavedInCloud   = dlCloudItems.length > 0;
        const isCatalogCloud   = catalogCloudItems.length > 0;
        const cloudNames       = [...new Set(dlCloudItems.map(i => i.apiName))];
        const isOnlyExcluded   = cloudNames.length > 0 && cloudNames.every(n => excludedFromHide.has(n));

        const visuallySaved    = isDownloaded || isCopied || isSavedInCloud;
        const visuallyCatalog  = isCatalog || isCatalogCloud;
        const meetsHide        = isDownloaded || (isSavedInCloud && !isOnlyExcluded);

        // Container a ocultar — col.posters-infinite-scroll
        const container = root.parentElement?.classList.contains("col") ? root.parentElement : root.parentElement || root;

        root.style.boxShadow  = "";
        root.style.transition = "all 0.2s ease";

        if ((meetsHide && hideDownloaded) || (visuallyCatalog && hideHistory)) {
            container.style.display = "none";
            return true;
        } else {
            container.style.display = "";
        }

        // Badge cloud
        root.querySelector('.ft-cloud-badge')?.remove();
        if (isSavedInCloud || visuallyCatalog) {
            const badge = document.createElement("div");
            badge.className = "ft-cloud-badge";
            badge.style.cssText = "position:absolute;top:8px;left:8px;z-index:100;display:flex;gap:4px;align-items:center;pointer-events:none;";

            if (visuallyCatalog) {
                const icon = document.createElement("div");
                icon.style.cssText = "background:rgba(0,0,0,0.65);color:#38bdf8;display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:4px;border:1px dashed rgba(14,165,233,0.6);";
                icon.title = "No catálogo/histórico"; icon.innerHTML = ICONS.history;
                badge.appendChild(icon);
            }
            if (isSavedInCloud) {
                const pill = document.createElement("div");
                pill.style.cssText = "background:rgba(0,0,0,0.8);color:#fff;font-size:10px;padding:3px 7px;border-radius:4px;border:1px solid rgba(255,255,255,0.2);font-weight:bold;";
                let names = "";
                cloudNames.forEach((n, idx) => {
                    const match = dlCloudItems.find(i => i.apiName === n);
                    names += `<span style="color:${match?.apiColor || '#3b82f6'}">${n}</span>` + (idx < cloudNames.length - 1 ? ", " : "");
                });
                pill.innerHTML = `${ICONS.cloud} <span>${names}</span>`; pill.style.display='flex'; pill.style.alignItems='center'; pill.style.gap='4px';
                badge.appendChild(pill);
            }
            root.style.position = "relative";
            root.appendChild(badge);
        }

        // Opacidade e borda
        const imgWrapper = root.querySelector('.cover') || root.querySelector('picture') || root;
        if (visuallySaved) {
            imgWrapper.style.opacity = "0.35";
            if (isCopied && !isDownloaded)              root.style.boxShadow = "0 0 0 3px #ffc107";
            else if (isSavedInCloud && !isDownloaded)   root.style.boxShadow = `0 0 0 3px ${getApiColor(cloudNames[0], configs)}`;
            else                                         root.style.boxShadow = "0 0 0 3px #10b981";
            root.style.borderRadius = "6px";
        } else {
            imgWrapper.style.opacity = "1";
            root.style.boxShadow = "";
        }

        return false;
    }

    function highlightSavedLinks() {
        _currentHiddenCount = 0;
        const cache    = buildStoreCache();
        const cloudMap = _buildCloudMap();
        const configs  = getApiConfigs();
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
        page:     `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
        catalog:  `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M5 3a2 2 0 0 0-2 2v16l9-4 9 4V5a2 2 0 0 0-2-2H5z"/></svg>`,
        download: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
        copy:     `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    };

    function updateStats() {
        if (!statsEl) return;
        const { all } = collectLinksFromPage();
        const pg  = all.length;
        const cat = getStored(STORE_CATALOG).length;
        const dwn = getStored(STORE_DOWNLOADED).length;
        const cpy = getStored(STORE_DOWNLOAD_LIST).length;
        const cell = (icon, color, val, label) =>
            `<div style="padding:7px 9px;background:rgba(8,12,20,.98);">
                <div style="display:flex;align-items:center;gap:5px;margin-bottom:3px;">
                    <span style="color:${color};opacity:.75;line-height:0;">${icon}</span>
                    <span style="font-size:14px;font-weight:700;color:${color};line-height:1;">${val}</span>
                </div>
                <div style="font-size:9px;color:#64748b;letter-spacing:.07em;text-transform:uppercase;">${label}</div>
            </div>`;
        statsEl.innerHTML =
            `<div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:rgba(255,255,255,.05);border-radius:9px;overflow:hidden;">
                ${cell(STAT_ICONS.page,    '#94a3b8', pg,  'Na página')}
                ${cell(STAT_ICONS.catalog, '#dc2626', cat, 'Catálogo')}
                ${cell(STAT_ICONS.download,'#10b981', dwn, 'Transferidos')}
                ${cell(STAT_ICONS.copy,    cpy > 0 ? '#f59e0b' : '#334155', cpy, 'Copiados')}
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
        const accent = opts.accent || "rgba(239,68,68,.6)";
        const danger  = opts.danger || false;
        b.style.cssText = `padding:10px 12px;border-radius:10px;
            background:rgba(255,255,255,.05);
            color:${danger ? "#f87171" : "#e2e8f0"};
            border:1px solid rgba(255,255,255,.08);
            border-left:2px solid ${danger ? "#ef4444" : accent};
            cursor:pointer;text-align:left;font-size:12.5px;
            font-family:inherit;font-weight:500;letter-spacing:0.01em;
            transition:background .15s,border-color .15s,color .15s;`;
        b.addEventListener("mouseover", () => {
            b.style.background = danger ? "rgba(239,68,68,.1)" : "rgba(255,255,255,.09)";
            b.style.borderLeftColor = danger ? "#f87171" : "rgba(239,68,68,.9)";
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
            box-shadow:0 12px 40px rgba(0,0,0,.5),0 0 0 1px rgba(239,68,68,.05);
            backdrop-filter:blur(12px);overflow:hidden;
            font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#fff;white-space:pre-line;`;

        // Header
        const header = document.createElement("div");
        header.style.cssText = `display:flex;align-items:center;justify-content:space-between;
            padding:11px 10px 11px 13px;cursor:move;user-select:none;
            background:linear-gradient(105deg,rgba(220,38,38,.22) 0%,rgba(8,12,20,0) 65%);
            border-bottom:1px solid rgba(255,255,255,.07);`;

        const title = document.createElement("div");
        title.style.cssText = "display:flex;align-items:center;gap:8px;";
        title.innerHTML = `
            <span style="width:7px;height:7px;border-radius:50%;background:#dc2626;
                box-shadow:0 0 8px rgba(220,38,38,.8);flex-shrink:0;display:inline-block;"></span>
            <span style="font-weight:700;font-size:11.5px;letter-spacing:.14em;color:#f1f5f9;">FILMTWIST</span>`;

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
        minBtn.addEventListener("mouseout",  () => { minBtn.style.background = "rgba(255,255,255,.05)"; minBtn.style.color = "#94a3b8"; });
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
        const btnMark  = makeButton("Marcar transferidos", markCopiedAsDownloaded);
        const btnReset = makeButton("Limpar copiados", resetCopiedLinks, { danger: true });
        btnMark.id = "ft-btn-mark-copied";
        btnMark.style.flex = "1"; btnReset.style.flex = "1";
        rowCopied.append(btnMark, btnReset);

        const btnAPIs = makeButton("Gerir APIs cloud", openApiManagerUI, { accent: "rgba(139,92,246,.7)", icon: "api" });
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
            minBtn.innerHTML   = v ? svgMax : svgMin;
            setMinimized(v);
            panel.style.width  = v ? "180px" : "320px";
        };
        minBtn.addEventListener("click", (e) => { e.stopPropagation(); applyMin(body.style.display !== "none"); });

        // Drag
        let dragging = false, startX = 0, startY = 0, startRight = 0, startTop = 0;
        const startDrag = (e) => {
            const cx = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
            const cy = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            dragging = true; startX = cx; startY = cy;
            startRight = parseInt(panel.style.right, 10) || 14;
            startTop   = parseInt(panel.style.top, 10);
            if (isNaN(startTop)) { startTop = panel.offsetTop; panel.style.bottom = 'auto'; }
            if (!e.type.includes('touch')) e.preventDefault();
        };
        const moveDrag = (e) => {
            if (!dragging) return;
            if (e.type.includes('touch')) e.preventDefault();
            const cx = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
            const cy = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            const nr = Math.max(0, Math.min(startRight + (startX - cx), window.innerWidth  - panel.offsetWidth));
            const nt = Math.max(0, Math.min(startTop  + (cy - startY), window.innerHeight - panel.offsetHeight));
            panel.style.right = `${nr}px`; panel.style.top = `${nt}px`;
        };
        const endDrag = () => {
            if (!dragging) return; dragging = false;
            saveUIPos({ right: parseInt(panel.style.right, 10) || 14, top: parseInt(panel.style.top, 10) });
        };
        header.addEventListener("mousedown",  startDrag);
        header.addEventListener("touchstart", startDrag, { passive: false });
        window.addEventListener("mousemove",  moveDrag);
        window.addEventListener("touchmove",  moveDrag, { passive: false });
        window.addEventListener("mouseup",    endDrag);
        window.addEventListener("touchend",   endDrag);

        updateStats();
    }

    /* =====================================================================
       INJECÇÃO DOS BOTÕES DE OCULTAR (junto ao sort nativo)
       ===================================================================== */

    function injectHideButtons() {
        if (document.getElementById("ft-hide-btns")) return;
        const sortEl = document.querySelector(".catalogue-movies-list-sort");
        if (!sortEl) return;

        const wrapper = document.createElement("div");
        wrapper.id = "ft-hide-btns";
        wrapper.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;margin-left:auto;";

        const svgEye    = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
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
                (v) => { hideDownloaded = v; GM_setValue("filmtwist_hide_downloaded_v1", v); highlightSavedLinks(); }),
            createBtn("ft-hide-hist", "Mostrar catálogo",     "Ocultar catálogo",     hideHistory,
                (v) => { hideHistory    = v; GM_setValue("filmtwist_hide_history_v1",    v); highlightSavedLinks(); })
        );

        // Insere antes do sort
        sortEl.parentElement?.insertBefore(wrapper, sortEl);
    }

    /* =====================================================================
       CLOUD SYNC
       ===================================================================== */

    function __obf(str) {
        const key   = "FT_SEC_KEY_24";
        const bytes = new TextEncoder().encode(str);
        const kbytes= new TextEncoder().encode(key);
        const out   = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ kbytes[i % kbytes.length];
        let bin = ""; out.forEach(b => bin += String.fromCharCode(b));
        return btoa(bin);
    }
    function __deobf(b64) {
        try {
            const key   = "FT_SEC_KEY_24";
            const bin   = atob(b64);
            const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
            const kbytes= new TextEncoder().encode(key);
            const out   = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ kbytes[i % kbytes.length];
            return new TextDecoder().decode(out);
        } catch { return b64; }
    }

    function getApiConfigs() {
        const raw = GM_getValue(STORE_API_CONFIGS, "[]");
        if (raw === "[]") return [];
        try { return JSON.parse(raw.startsWith("[") ? raw : __deobf(raw)); } catch { return []; }
    }
    function setApiConfigs(configs) { GM_setValue(STORE_API_CONFIGS, __obf(JSON.stringify(configs))); }

    function getApiColor(apiName, configs = null) {
        if (!configs) configs = getApiConfigs();
        const api = configs.find(c => c.name === apiName);
        if (api?.apiKey) return '#3b82f6';
        let hash = 0;
        for (let i = 0; i < apiName.length; i++) hash = apiName.charCodeAt(i) + ((hash << 5) - hash);
        const HUES = [0, 190, 240, 265, 290, 315, 340, 355];
        return `hsl(${HUES[Math.abs(hash) % HUES.length]}, 85%, 65%)`;
    }

    async function fetchCloudData() {
        const seq     = ++_cloudFetchSeq;
        const configs = getApiConfigs();
        const nextSaves = {}, nextFull = [], nextExtra = [];

        await Promise.all(configs.map(async (api) => {
            try {
                const hdrs = api.apiKey ? { "x-api-key": api.apiKey } : undefined;
                const res  = await fetch(`${api.url}?keys=${STORE_CATALOG},${STORE_DOWNLOADED},${STORE_EXTRA_FIELD}`, { headers: hdrs });
                if (!res.ok) return;
                const data = await res.json();

                const processArr = (arr, listType) => {
                    if (!Array.isArray(arr)) return;
                    arr.forEach(item => {
                        nextFull.push({ ...item, apiName: api.name, apiColor: getApiColor(api.name, configs), listType });
                        if (!nextSaves[item.url]) nextSaves[item.url] = [];
                        if (!nextSaves[item.url].includes(api.name)) nextSaves[item.url].push(api.name);
                    });
                };

                if (data && typeof data === "object" && !Array.isArray(data)) {
                    processArr(data[STORE_CATALOG],    STORE_CATALOG);
                    processArr(data[STORE_DOWNLOADED],  STORE_DOWNLOADED);
                    if (Array.isArray(data[STORE_EXTRA_FIELD])) nextExtra.push(...data[STORE_EXTRA_FIELD]);
                }
            } catch (err) { console.error(`Falha no GET para ${api.name}:`, err); }
        }));

        if (seq !== _cloudFetchSeq) return;

        cloudSaves       = nextSaves;
        cloudFullData    = nextFull.sort((a, b) => (b.saved_at || 0) - (a.saved_at || 0));
        cloudExtraFields = nextExtra;

        highlightSavedLinks();
    }

    async function saveToCloud() {
        const configs = getApiConfigs();
        let pushed = 0;

        for (const api of configs) {
            if (!api.apiKey) continue;
            try {
                const hdrs = { "x-api-key": api.apiKey };
                const getRes = await fetch(`${api.url}?keys=${STORE_CATALOG},${STORE_DOWNLOADED},${STORE_EXTRA_FIELD}`, { headers: hdrs });
                if (!getRes.ok) throw new Error(`GET falhou ${getRes.status}`);
                let cloudData = {};
                try { cloudData = await getRes.json() || {}; } catch { /* ignora */ }

                const payload = {
                    [STORE_CATALOG]:    mergeData([...(cloudData[STORE_CATALOG]   || []), ...getStored(STORE_CATALOG)]),
                    [STORE_DOWNLOADED]: mergeData([...(cloudData[STORE_DOWNLOADED] || []), ...getStored(STORE_DOWNLOADED)]),
                    [STORE_EXTRA_FIELD]: mergeDataPreferNewest([...(cloudData[STORE_EXTRA_FIELD] || []), ...getStored(STORE_EXTRA_FIELD)]),
                };

                const res = await fetch(api.url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", ...hdrs },
                    body: JSON.stringify(payload)
                });
                if (res.ok) pushed++;
                else toast(`Falha ao sincronizar com ${api.name} (${res.status})`);
            } catch (err) { console.error(`Falha POST para ${api.name}:`, err); toast(`Erro de rede ao enviar para ${api.name}`); }
        }

        if (pushed > 0) { toast("Sincronizado com a Nuvem!"); fetchCloudData(); }
    }

    async function removeFromCloud(url) {
        const configs = getApiConfigs();
        let cnt = 0;
        for (const api of configs) {
            if (!api.apiKey) continue;
            try {
                const res = await fetch(api.url, {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json", "x-api-key": api.apiKey },
                    body: JSON.stringify({ url, keys: [STORE_CATALOG, STORE_DOWNLOADED, STORE_EXTRA_FIELD] })
                });
                if (res.ok) cnt++;
                else toast(`Falha ao remover de ${api.name} (${res.status})`);
            } catch (err) { console.error(`Falha DELETE para ${api.name}:`, err); }
        }
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
            box-shadow:0 24px 60px rgba(0,0,0,.7),0 0 0 1px rgba(220,38,38,.06);`;

        const iSvg = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 7l3 3-3 3"/><path d="M8 13h8"/><rect x="2" y="3" width="20" height="18" rx="2"/>
        </svg>`;

        let editingIdx = -1;

        const inputCSS = `width:100%;padding:9px 12px;background:rgba(255,255,255,.04);color:#e2e8f0;
            border:1px solid rgba(255,255,255,.09);border-radius:8px;box-sizing:border-box;
            font-size:12.5px;font-family:inherit;outline:none;transition:border-color .15s;`;
        const checkCSS = `accent-color:#dc2626;width:14px;height:14px;cursor:pointer;`;

        const renderList = () => {
            const configs = getApiConfigs();
            const isEditing   = editingIdx !== -1;
            const editingName = isEditing ? esc(configs[editingIdx]?.name ?? "") : "";

            let listHtml = "";
            if (!configs.length) {
                listHtml = `<div style="padding:20px;text-align:center;color:#334155;font-size:12px;border:1px dashed rgba(255,255,255,.06);border-radius:10px;">
                    Nenhuma API configurada ainda.
                </div>`;
            } else {
                configs.forEach((api, idx) => {
                    const hasCatalog = cloudFullData.some(i => i.apiName === api.name && i.listType === STORE_CATALOG);
                    const hasDown    = cloudFullData.some(i => i.apiName === api.name && i.listType === STORE_DOWNLOADED);
                    const safeName   = esc(api.name);
                    const safeColor  = esc(getApiColor(api.name, configs));
                    const actionBtn  = (cls, label, bg) =>
                        `<button data-idx="${idx}" class="${cls}" style="padding:4px 10px;background:${bg};color:#fff;border:none;border-radius:6px;font-size:11px;cursor:pointer;font-weight:500;">${label}</button>`;
                    listHtml += `
                    <div style="background:rgba(255,255,255,.03);padding:12px 14px;border-radius:10px;margin-bottom:8px;border:1px solid rgba(255,255,255,.06);">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:${api.apiKey ? '10px' : '0'};">
                            <span style="font-size:13px;font-weight:600;color:${safeColor};letter-spacing:.02em;">${safeName}</span>
                            <div style="display:flex;gap:6px;">
                                ${actionBtn("ft-edit-api-btn","Editar","rgba(100,116,139,.3)")}
                                ${actionBtn("ft-del-api-btn","Remover","rgba(220,38,38,.2)")}
                            </div>
                        </div>
                        ${api.apiKey ? `<div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;padding-top:8px;border-top:1px solid rgba(255,255,255,.05);">
                            <span style="font-size:10px;color:#475569;margin-right:2px;letter-spacing:.06em;text-transform:uppercase;">Gestão:</span>
                            ${actionBtn("ft-restore-btn","⬇ Restaurar local","rgba(37,99,235,.25)")}
                            ${hasCatalog ? actionBtn("ft-purge-catalog-btn","✕ Catálogo","rgba(14,165,233,.2)") : ''}
                            ${hasDown    ? actionBtn("ft-purge-down-btn","✕ Transferidos","rgba(194,65,12,.25)") : ''}
                        </div>` : ''}
                        <div style="display:flex;gap:12px;margin-top:7px;font-size:10.5px;">
                            <span style="color:${api.apiKey ? '#10b981' : '#475569'};">${api.apiKey ? '● Write access' : '○ Apenas leitura'}</span>
                            ${api.excludeFromCopy ? `<span style="color:#ef4444;">✕ Não copiar transferidos</span>` : ''}
                            ${api.excludeFromHide ? `<span style="color:#f59e0b;">◎ Não ocultar do ecrã</span>` : ''}
                        </div>
                    </div>`;
                });
            }

            box.innerHTML = `
            <!-- Header -->
            <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:space-between;background:linear-gradient(105deg,rgba(220,38,38,.1),rgba(8,12,20,0));">
                <div style="display:flex;align-items:center;gap:10px;">
                    <span style="width:7px;height:7px;border-radius:50%;background:#dc2626;box-shadow:0 0 8px rgba(220,38,38,.8);display:inline-block;"></span>
                    <span style="font-size:12.5px;font-weight:700;letter-spacing:.12em;color:#f1f5f9;">APIS CLOUD</span>
                </div>
                <button type="button" id="ft-tut-btn" style="padding:6px 12px;background:rgba(139,92,246,.2);color:#c4b5fd;border:1px solid rgba(139,92,246,.3);border-radius:7px;font-size:11px;cursor:pointer;font-weight:600;display:flex;align-items:center;gap:5px;">
                    ${iSvg} Passo-a-Passo
                </button>
            </div>

            <!-- Scroll body -->
            <div style="overflow-y:auto;padding:16px 20px;flex:1;">
                <p style="font-size:11.5px;color:#475569;margin:0 0 14px;line-height:1.5;">
                    Adiciona URLs das tuas Worker APIs. Fornece API Key apenas se for a tua base de dados (write access).
                </p>
                <div id="ft-api-list" style="margin-bottom:14px;">${listHtml}</div>

                <!-- Add / Edit form -->
                <div style="background:rgba(255,255,255,.025);padding:14px;border-radius:10px;border:1px solid rgba(255,255,255,.06);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                        <span style="font-size:11.5px;font-weight:600;color:#94a3b8;letter-spacing:.08em;text-transform:uppercase;">${isEditing ? `Editar: ${editingName}` : 'Nova API'}</span>
                        ${isEditing ? `<span id="ft-cancel-edit" style="color:#475569;cursor:pointer;font-size:11px;">Cancelar</span>` : ''}
                    </div>
                    <input id="ft-api-name" placeholder="Nome (ex: A minha cloud)" style="${inputCSS}margin-bottom:8px;">
                    <input id="ft-api-url"  placeholder="URL (ex: https://api.exemplo.workers.dev)" style="${inputCSS}margin-bottom:8px;">
                    <div style="display:flex;gap:6px;margin-bottom:12px;align-items:stretch;">
                        <input type="password" id="ft-api-key" placeholder="API Key Secreta (opcional — write access)" style="${inputCSS}margin-bottom:0;flex:1;">
                        <button type="button" id="ft-api-gen-key" title="Gerar chave aleatória segura"
                            style="padding:0 12px;background:rgba(139,92,246,.2);color:#c4b5fd;border:1px solid rgba(139,92,246,.3);border-radius:8px;cursor:pointer;font-size:11px;font-weight:600;white-space:nowrap;font-family:inherit;">✦ Gerar</button>
                    </div>
                    <label style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:#64748b;margin-bottom:8px;cursor:pointer;">
                        <input type="checkbox" id="ft-api-exc-copy" style="${checkCSS}">Não copiar transferidos desta nuvem
                    </label>
                    <label style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:#64748b;margin-bottom:14px;cursor:pointer;">
                        <input type="checkbox" id="ft-api-exc-hide" style="${checkCSS}">Não esconder filmes desta nuvem ao ocultar
                    </label>
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <button id="ft-api-close" style="padding:8px 14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);color:#94a3b8;border-radius:8px;cursor:pointer;font-size:12px;">Fechar</button>
                        <button id="ft-api-save"  style="padding:8px 18px;background:${isEditing ? 'rgba(16,185,129,.2)' : 'rgba(37,99,235,.25)'};color:${isEditing ? '#6ee7b7' : '#93c5fd'};border:1px solid ${isEditing ? 'rgba(16,185,129,.35)' : 'rgba(37,99,235,.35)'};border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;">${isEditing ? 'Atualizar API' : '+ Guardar API'}</button>
                    </div>
                </div>
            </div>`;

            // Generate random secure API key
            const genBtn = box.querySelector("#ft-api-gen-key");
            if (genBtn) {
                genBtn.onclick = () => {
                    const arr = new Uint8Array(24);
                    crypto.getRandomValues(arr);
                    const key = Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
                    const inp = box.querySelector("#ft-api-key");
                    inp.value = key; inp.type = "text";
                    setTimeout(() => { inp.type = "password"; }, 3000);
                    toast("Chave gerada — copie e guarde no Cloudflare.");
                };
            }

            // Focus styles on inputs
            box.querySelectorAll("input[id^='ft-api']").forEach(inp => {
                inp.addEventListener("focus",  () => inp.style.borderColor = "rgba(220,38,38,.5)");
                inp.addEventListener("blur",   () => inp.style.borderColor = "rgba(255,255,255,.09)");
            });

            if (isEditing) {
                const api = configs[editingIdx];
                box.querySelector("#ft-api-name").value       = api.name;
                box.querySelector("#ft-api-url").value        = api.url;
                box.querySelector("#ft-api-key").value        = api.apiKey || "";
                box.querySelector("#ft-api-exc-copy").checked = !!api.excludeFromCopy;
                box.querySelector("#ft-api-exc-hide").checked = !!api.excludeFromHide;
                box.querySelector("#ft-cancel-edit").onclick  = () => { editingIdx = -1; renderList(); };
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
                        if (!confirm(`⚠️ Apagar ${label} no servidor de ${api.name}?`)) return;
                        const res = await fetch(api.url, {
                            method: "DELETE",
                            headers: { "Content-Type": "application/json", "x-api-key": api.apiKey },
                            body: JSON.stringify({ purgeKey })
                        });
                        if (res.ok) { alert(`Nuvem de ${api.name} (${label}) limpa!`); btn.style.display = 'none'; fetchCloudData(); }
                        else alert(`Falha ao limpar ${api.name}.`);
                    };
                });
            };
            setupPurge(".ft-purge-catalog-btn",  "CATÁLOGO",     STORE_CATALOG);
            setupPurge(".ft-purge-down-btn",      "TRANSFERIDOS",  STORE_DOWNLOADED);

            box.querySelectorAll(".ft-restore-btn").forEach(btn => {
                btn.onclick = async () => {
                    const i   = parseInt(btn.getAttribute("data-idx"), 10);
                    const api = configs[i];
                    if (!confirm(`Restaurar LOCAL com dados de ${api.name}?`)) return;
                    const hdrs = api.apiKey ? { "x-api-key": api.apiKey } : undefined;
                    const res  = await fetch(`${api.url}?keys=${STORE_CATALOG},${STORE_DOWNLOADED}`, { headers: hdrs });
                    if (!res.ok) { alert(`Falha: ${res.status}`); return; }
                    const data = await res.json();
                    if (data && typeof data === 'object') {
                        if (data[STORE_CATALOG])    setStored(STORE_CATALOG,    data[STORE_CATALOG]);
                        if (data[STORE_DOWNLOADED])  setStored(STORE_DOWNLOADED,  data[STORE_DOWNLOADED]);
                        toast(`Restauro concluído via ${api.name}.`);
                        updateStats(); highlightSavedLinks(); mod.remove();
                    } else alert("Formato de dados inválido.");
                };
            });

            box.querySelector("#ft-api-close").onclick = () => mod.remove();
            box.querySelector("#ft-api-save").onclick  = () => {
                const n   = box.querySelector("#ft-api-name").value.trim();
                let u     = box.querySelector("#ft-api-url").value.trim();
                const k   = box.querySelector("#ft-api-key").value.trim();
                const exc = box.querySelector("#ft-api-exc-copy").checked;
                const excH= box.querySelector("#ft-api-exc-hide").checked;
                if (!n || !u) return alert("Nome e URL são obrigatórios.");
                if (!u.startsWith("http")) return alert("URL deve começar por http:// ou https://");
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

        const localCatalog  = getStored(STORE_CATALOG).length;
        const localDown     = getStored(STORE_DOWNLOADED).length;
        const localCopy     = getStored(STORE_DOWNLOAD_LIST).length;

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
            const r          = allItemsMap.get(item.url);
            const activeType = item.listType || explicitType;
            const isDl   = activeType === STORE_DOWNLOADED;
            const isCopy = activeType === STORE_DOWNLOAD_LIST;
            const isHist = activeType === STORE_CATALOG;
            if (isCloud) {
                if (!r.sources.some(s => s.name === sourceName)) r.sources.push({ name: sourceName, color: sourceColor });
                if (isDl)   r.cloudDownloaded[sourceName] = true;
                if (isHist) r.cloudHistory[sourceName]    = true;
                if (item.saved_at && (!r.saved_at || item.saved_at > r.saved_at)) r.saved_at = item.saved_at;
            } else {
                r.isLocal = true;
                if (isDl)   r.isLocalDownloaded = true;
                if (isHist) r.isLocalHistory    = true;
                if (isCopy) r.isCopied          = true;
                if (!r.saved_at && item.saved_at) r.saved_at = item.saved_at;
            }
            if (!r.mediaType) {
                r.mediaType = r.url.includes("/serie/") ? "Série" : "Filme";
            }
            r.ft_extra_field = notesMap.get(r.url) || "";
        };

        cloudFullData.forEach(item                => addOrUpdate(item, item.apiName, item.apiColor, true));
        getStored(STORE_CATALOG).forEach(item     => addOrUpdate(item, "Local", null, false, STORE_CATALOG));
        getStored(STORE_DOWNLOADED).forEach(item  => addOrUpdate(item, "Local", null, false, STORE_DOWNLOADED));
        getStored(STORE_DOWNLOAD_LIST).forEach(item => addOrUpdate(item, "Local", null, false, STORE_DOWNLOAD_LIST));

        const configs         = getApiConfigs();
        const uniqueCloudsArr = [...new Set(configs.map(c => c.name))];
        const cloudStatsData  = uniqueCloudsArr.map(cn => ({
            name: cn, color: getApiColor(cn, configs),
            hasKey:   !!configs.find(c => c.name === cn)?.apiKey,
            catalog:  cloudFullData.filter(i => i.apiName === cn && i.listType === STORE_CATALOG).length,
            downloaded: cloudFullData.filter(i => i.apiName === cn && i.listType === STORE_DOWNLOADED).length,
        }));

        const allDashData   = Array.from(allItemsMap.values()).sort((a, b) => (b.saved_at || 0) - (a.saved_at || 0));
        const completeItems = allDashData.filter(i => i.title && i.poster && !i.poster.includes('placehold'));
        const pendingItems  = allDashData.filter(i => !i.title || !i.poster || i.poster.includes('placehold'));

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
                outline:none; transition:border-color .15s; font-size:13px;
                color-scheme:dark; }
            .ft-input:focus { border-color:rgba(220,38,38,.5) !important; }
            .ft-input option { background:#0f172a !important; color:#e2e8f0 !important; }
            .ft-btn { border:none;padding:9px 16px;border-radius:8px;cursor:pointer;font-weight:600;font-size:12.5px;
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
        const pendingRef    = ref(pendingItems);

        const app = createApp({
            template: `
<div style="width:100%;max-width:1280px;">

  <!-- Header -->
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:28px;padding-bottom:18px;border-bottom:1px solid rgba(255,255,255,.08);">
    <div style="display:flex;align-items:center;gap:12px;">
      <span style="width:9px;height:9px;border-radius:50%;background:#dc2626;box-shadow:0 0 10px rgba(220,38,38,.9);display:inline-block;"></span>
      <span style="font-size:15px;font-weight:700;letter-spacing:.12em;color:#f1f5f9;">FILMTWIST</span>
      <span style="font-size:11px;color:#94a3b8;letter-spacing:.06em;font-weight:500;">DASHBOARD</span>
    </div>
    <button @click="close" class="ft-btn" style="background:rgba(220,38,38,.15);color:#f87171;border:1px solid rgba(220,38,38,.3);">Fechar</button>
  </div>

  <!-- Scraping progress -->
  <div v-if="pendingRef.length > 0" style="background:rgba(234,179,8,.08);color:#fbbf24;padding:12px 16px;border-radius:10px;margin-bottom:24px;font-size:13px;font-weight:500;border:1px solid rgba(234,179,8,.2);">
    <span v-if="scrapeTotal > 0">A processar {{ scrapeCurrent }} de {{ scrapeTotal }} itens...</span>
    <span v-else>A preparar processamento de {{ pendingRef.length }} itens...</span>
  </div>

  <!-- Stat cards -->
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;width:100%;margin-bottom:16px;">
    <div v-for="(v,l) in statCards" :key="l"
         style="background:rgba(255,255,255,.03);padding:18px 20px;border-radius:12px;border:1px solid rgba(255,255,255,.07);display:flex;align-items:center;gap:14px;">
      <div :style="{background:v.color+'1a',borderColor:v.color+'44'}" style="width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;border:1px solid;flex-shrink:0;">{{ v.icon }}</div>
      <div>
        <div :style="{color:v.color}" style="font-size:26px;font-weight:700;line-height:1;">{{ v.count }}</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:3px;letter-spacing:.06em;text-transform:uppercase;">{{ l }}</div>
      </div>
    </div>
  </div>

  <!-- Cloud cards -->
  <div v-if="st.cloudStats.length" style="display:flex;gap:12px;width:100%;margin-bottom:20px;flex-wrap:wrap;">
    <div v-for="c in st.cloudStats" :key="c.name"
         :style="{borderColor:c.color+'44'}"
         style="background:rgba(255,255,255,.02);padding:14px 18px;border-radius:12px;border:1px solid;min-width:200px;flex:1;">
      <div :style="{color:c.color}" style="font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-bottom:10px;">☁ {{ c.name }}</div>
      <div style="display:flex;justify-content:space-between;margin-bottom:5px;">
        <span style="font-size:12px;color:#64748b;">Catálogo</span>
        <span style="font-size:13px;font-weight:600;color:#e2e8f0;">{{ c.catalog }}</span>
      </div>
      <div style="display:flex;justify-content:space-between;">
        <span style="font-size:12px;color:#64748b;">Transferidos</span>
        <span style="font-size:13px;font-weight:600;color:#10b981;">{{ c.downloaded }}</span>
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
      <span style="font-size:11px;color:#94a3b8;">até</span>
      <input type="date" v-model="dateEnd" class="ft-input" placeholder="dd/mm/aaaa">
    </div>
  </div>

  <!-- Grid -->
  <div v-if="filtered.length===0" style="padding:48px;text-align:center;color:#64748b;background:rgba(255,255,255,.02);border:1px dashed rgba(255,255,255,.08);border-radius:12px;">Nenhum título correspondente.</div>
  <div v-else>
    <div style="text-align:center;margin-bottom:14px;font-size:12px;color:#94a3b8;letter-spacing:.04em;">A mostrar {{ displayed.length }} de {{ filtered.length }} resultados</div>
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
                style="background:rgba(0,0,0,.88);padding:2px 6px;border-radius:4px;font-size:9.5px;margin-right:4px;margin-bottom:4px;border:1px solid rgba(255,255,255,.15);font-weight:600;letter-spacing:.04em;">
            {{ badgeIcon(item,src.name) }} {{ src.name }}
          </span>
          <span v-if="item.isLocal" style="background:rgba(0,0,0,.88);color:#10b981;padding:2px 6px;border-radius:4px;font-size:9.5px;margin-right:4px;margin-bottom:4px;border:1px solid rgba(16,185,129,.3);font-weight:600;">Local</span>
        </div>
        <div @click.prevent="copyPoster(item)"
             style="position:absolute;bottom:8px;right:8px;background:rgba(0,0,0,.7);color:#94a3b8;padding:4px 7px;border-radius:5px;font-size:10px;cursor:pointer;border:1px solid rgba(255,255,255,.1);transition:color .15s;" title="Copiar poster">${ICONS.poster}</div>
        <div v-if="item.mediaType==='Série'" @click.stop.prevent="openNoteModal(item)"
             style="position:absolute;top:8px;right:8px;background:rgba(15,23,42,.9);color:#fff;padding:5px;border-radius:50%;font-size:12px;cursor:pointer;border:1px solid rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;width:26px;height:26px;z-index:20;">
          <span>{{ item.ft_extra_field ? '📝' : '＋' }}</span>
        </div>
      </div>
      <div style="padding:10px 12px;display:flex;flex-direction:column;flex-grow:1;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:4px;">
          <a :href="item.url" target="_blank" style="flex-grow:1;color:#e2e8f0;text-decoration:none;font-weight:600;font-size:12.5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;"
             @mouseenter="$event.target.style.color='#dc2626'" @mouseleave="$event.target.style.color='#e2e8f0'">{{ item.title||'Sem Título' }}</a>
          <div v-if="hasWriteAccess(item)" style="display:flex;gap:2px;flex-shrink:0;">
            <button @click.prevent="openEditModal(item)" style="background:transparent;color:#475569;border:none;border-radius:4px;padding:3px;cursor:pointer;font-size:12px;transition:color .15s;" @mouseenter="$event.target.style.color='#e2e8f0'" @mouseleave="$event.target.style.color='#475569'" title="Editar">✏️</button>
            <button @click.prevent="deleteItem(item)"   style="background:transparent;color:#475569;border:none;border-radius:4px;padding:3px;cursor:pointer;font-size:12px;transition:color .15s;" @mouseenter="$event.target.style.color='#ef4444'" @mouseleave="$event.target.style.color='#475569'" title="Eliminar">🗑️</button>
          </div>
        </div>
        <div style="font-size:10.5px;color:#64748b;margin-top:auto;padding-top:7px;border-top:1px solid rgba(255,255,255,.05);">
          {{ fmtDate(item.saved_at) }}
        </div>
      </div>
    </div>
    </div>
    <div ref="sentinel" style="height:1px;"></div>
    <div v-if="displayed.length < filtered.length" style="text-align:center;padding:24px;color:#64748b;font-size:12px;">A carregar mais...</div>
    <div v-else-if="filtered.length > 0" style="text-align:center;padding:24px;color:#64748b;font-size:12px;">{{ filtered.length }} itens carregados</div>
  </div>

  <!-- Modal edição -->
  <div v-if="editingItem" style="position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);">
    <div style="background:#0f172a;padding:28px;border-radius:14px;width:90%;max-width:500px;border:1px solid rgba(255,255,255,.1);">
      <h2 style="margin-top:0;font-size:16px;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:12px;margin-bottom:20px;color:#f1f5f9;">Editar</h2>
      <label style="display:block;margin-bottom:6px;font-size:12px;color:#64748b;letter-spacing:.06em;text-transform:uppercase;">Título</label>
      <input type="text" v-model="editingItem.title" class="ft-input" style="width:100%;box-sizing:border-box;margin-bottom:14px;">
      <label style="display:block;margin-bottom:6px;font-size:12px;color:#64748b;letter-spacing:.06em;text-transform:uppercase;">Poster URL</label>
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
      <h2 style="margin-top:0;font-size:16px;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:12px;margin-bottom:20px;color:#f1f5f9;">Nota da Série</h2>
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
                const sentinel    = ref(null);
                const searchName  = ref("");
                const filterStatus = ref("all");
                const filterCloud = ref("all");
                const dateStart   = ref("");
                const dateEnd     = ref("");
                const viewMode    = ref(safeLSGet("filmtwist_dash_view_mode", "card") || "card");
                const imageCache  = ref({});
                const editingItem     = ref(null);
                const editingNoteItem = ref(null);
                const scrapeCurrent   = ref(0);
                const scrapeTotal     = ref(0);

                const st = { localCatalog, localDown, localCopy, cloudStats: cloudStatsData, uniqueClouds: uniqueCloudsArr };
                const statCards = {
                    'Catálogo':       { count: localCatalog, color: '#0ea5e9', icon: '🔖' },
                    'Transferidos':   { count: localDown,    color: '#10b981', icon: '✓'  },
                    'Copiados temp':  { count: localCopy,    color: '#f59e0b', icon: '⋯'  },
                };

                const ar = computed(() => viewMode.value === 'poster' ? '2/3' : '16/9');

                const filtered = computed(() => {
                    const q  = searchName.value.toLowerCase();
                    const ds = dateStart.value ? new Date(dateStart.value).getTime() : 0;
                    const de = dateEnd.value   ? new Date(dateEnd.value).getTime() + 86400000 : Infinity;
                    return dashboardData.value.filter(item => {
                        if (q && !(item.title || '').toLowerCase().includes(q)) return false;
                        const status = filterStatus.value, cloud = filterCloud.value;
                        if (cloud === "local") {
                            if (!item.isLocal) return false;
                            if (status === "downloaded" && !item.isLocalDownloaded) return false;
                            if (status === "history"    && !item.isLocalHistory)    return false;
                            if (status === "copied"     && !item.isCopied)          return false;
                        } else if (cloud !== "all") {
                            if (!item.sources.some(s => s.name === cloud)) return false;
                            if (status === "downloaded" && !item.cloudDownloaded[cloud]) return false;
                            if (status === "history"    && !item.cloudHistory[cloud])    return false;
                        } else {
                            if (status === "downloaded" && !item.isLocalDownloaded && !Object.keys(item.cloudDownloaded).length) return false;
                            if (status === "history"    && !item.isLocalHistory    && !Object.keys(item.cloudHistory).length)    return false;
                            if (status === "copied"     && !item.isCopied) return false;
                        }
                        const t = item.saved_at || 0;
                        return !(t < ds || (t > 0 && t > de));
                    });
                });

                const displayCount = ref(BATCH);
                const displayed    = computed(() => filtered.value.slice(0, displayCount.value));
                const loadMore     = () => { if (displayCount.value < filtered.value.length) displayCount.value += BATCH; };

                VueLib.watch([searchName, filterStatus, filterCloud, dateStart, dateEnd], () => { displayCount.value = BATCH; });
                VueLib.onMounted(() => {
                    if (!sentinel.value) return;
                    const obs = new IntersectionObserver(entries => { if (entries[0].isIntersecting) loadMore(); }, { root: mod, rootMargin: '200px' });
                    obs.observe(sentinel.value);
                });

                const toggleView    = () => { viewMode.value = viewMode.value === 'card' ? 'poster' : 'card'; safeLSSet("filmtwist_dash_view_mode", viewMode.value); };
                const close         = () => { delete window._ftDashUpdateItem; delete window._ftDashScrapeProgress; revokeAllObjectURLs(); mod.remove(); };
                const isSaved       = (item) => item.isLocalDownloaded || Object.keys(item.cloudDownloaded).length > 0;
                const badgeIcon     = (item, n) => { let i = ''; if (item.cloudDownloaded[n]) i += ICONS.download; if (item.cloudHistory[n]) i += ICONS.history; return i || ICONS.cloud; };
                const cardStyle     = (item) => {
                    let bs = 'none';
                    if (item.isLocalDownloaded)                        bs = '0 0 0 3px #10b981';
                    else if (Object.keys(item.cloudDownloaded).length) bs = `0 0 0 3px ${getApiColor(Object.keys(item.cloudDownloaded)[0], configs)}`;
                    return { boxShadow: bs, background: '#111', border: '1px solid #2a2a2a', borderRadius: '10px', overflow: 'hidden', display: 'flex', flexDirection: 'column', transition: 'transform 0.2s' };
                };
                const cardHover     = (ev, enter) => { ev.currentTarget.style.transform = enter ? 'scale(1.02)' : 'scale(1)'; ev.currentTarget.style.borderColor = enter ? '#555' : '#2a2a2a'; };

                const posterSrc = (item) => {
                    const raw = item.poster || 'https://placehold.co/280x400?text=Sem+Capa';
                    if (imageCache.value[raw]) return imageCache.value[raw];
                    imageCache.value[raw] = 'https://placehold.co/280x400?text=...';
                    getCachedImageURL(raw).then(url => { imageCache.value[raw] = url; });
                    return imageCache.value[raw];
                };
                const posterErr = (ev, item) => { ev.target.onerror = null; ev.target.src = item.poster || 'https://placehold.co/280x400?text=Erro'; };
                const fmtDate   = (ts) => !ts ? 'Desconhecida' : new Date(ts).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                const copyPoster = (item) => { GM_setClipboard(item.poster || "", { type: "text/plain" }); toast('Poster copiado!'); };
                const hasWriteAccess = (item) => item.isLocal || item.sources.some(s => configs.find(c => c.name === s.name)?.apiKey);

                const openEditModal = (item) => { editingItem.value = { ...item }; };
                const saveEdit      = () => {
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
                const saveNoteEdit  = () => {
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
                    if (!confirm(`Apagar "${item.title || item.url}"?`)) return;
                    [STORE_CATALOG, STORE_DOWNLOADED, STORE_DOWNLOAD_LIST].forEach(KEY => {
                        setStored(KEY, getStored(KEY).filter(u => u.url !== item.url));
                    });
                    dashboardData.value = dashboardData.value.filter(i => i.url !== item.url);
                    pendingRef.value    = pendingRef.value.filter(i => i.url !== item.url);
                    await removeFromCloud(item.url);
                };

                const exportFiltered = () => {
                    const data = filtered.value;
                    if (!data.length) return toast('Nada para exportar.');
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                    const url  = URL.createObjectURL(blob);
                    const a    = document.createElement("a"); a.href = url; a.download = `ft_export_${data.length}_${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
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
            if (st?.scrapeTotal?.value   !== undefined) st.scrapeTotal.value   = total;
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

        const GITHUB_URL      = "https://github.com/Blackspirits/media-sync/blob/main/worker/worker.js";
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

        const codeStyle = "display:inline-block;background:rgba(255,255,255,.07);color:#e2e8f0;padding:2px 7px;border-radius:4px;font-family:monospace;font-size:11.5px;border:1px solid rgba(255,255,255,.1);";
        const stepNumStyle = "display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:rgba(220,38,38,.25);color:#fca5a5;font-size:10px;font-weight:700;margin-right:8px;flex-shrink:0;";
        const steps = [
            ['Criar KV', 'Workers &amp; Pages → KV → criar namespace.'],
            ['Criar Worker', `(Module Worker) → colar código do GitHub → Deploy.`],
            ['Bind KV', `Worker → Settings → Bindings → KV Namespaces → nome <span style="${codeStyle}">MEDIA</span>`],
            ['Secret', `Worker → Settings → Variables → Secrets → nome <span style="${codeStyle}">API_KEY</span>`],
            ['No script', `<b>Gerir APIs cloud</b> → URL do Worker + API Key gerada.`],
        ];
        const stepsHtml = steps.map((s, i) =>
            `<li style="display:flex;align-items:flex-start;margin-bottom:11px;font-size:12.5px;color:#cbd5e1;line-height:1.5;">
                <span style="${stepNumStyle}">${i+1}</span>
                <span><b style="color:#f1f5f9;">${s[0]}</b>: ${s[1]}</span>
            </li>`
        ).join('');

        const btnLink = (id, href, label, bg, border) =>
            `<a id="${id}" href="${href}" target="_blank" rel="noopener"
                style="display:inline-flex;align-items:center;gap:7px;padding:9px 15px;background:${bg};color:#fff;
                border:1px solid ${border};border-radius:8px;text-decoration:none;font-weight:600;font-size:12px;">${label}</a>`;
        const btnCopy = (id, label, bg, border, color) =>
            `<button id="${id}" style="padding:9px 15px;background:${bg};color:${color};border:1px solid ${border};
                border-radius:8px;cursor:pointer;font-weight:600;font-size:12px;font-family:inherit;">${label}</button>`;

        box.innerHTML = `
        <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:space-between;background:linear-gradient(105deg,rgba(220,38,38,.1),rgba(8,12,20,0));">
            <div style="display:flex;align-items:center;gap:10px;">
                <span style="width:7px;height:7px;border-radius:50%;background:#dc2626;box-shadow:0 0 8px rgba(220,38,38,.8);display:inline-block;"></span>
                <span style="font-size:12.5px;font-weight:700;letter-spacing:.12em;color:#f1f5f9;">CLOUDFLARE WORKER — SETUP</span>
            </div>
            <button id="ft-tut-close" style="padding:6px 14px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);color:#94a3b8;border-radius:8px;cursor:pointer;font-size:12px;">Fechar</button>
        </div>
        <div style="overflow-y:auto;padding:20px;flex:1;">
            <ol style="list-style:none;margin:0 0 18px;padding:0;">${stepsHtml}</ol>

            <div style="background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:12px 15px;margin-bottom:18px;">
                <div style="font-size:10.5px;color:#64748b;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px;">⚙ Variáveis de ambiente opcionais (Settings → Variables)</div>
                <div style="display:flex;flex-direction:column;gap:5px;font-size:12px;">
                    <div><span style="${codeStyle}">ALLOWED_PREFIXES</span> <span style="color:#64748b;">— prefixos permitidos (default já inclui</span> <span style="${codeStyle}">filmtwist_</span><span style="color:#64748b;">)</span></div>
                    <div><span style="${codeStyle}">READ_KEY</span> <span style="color:#64748b;">— chave separada para leitura (opcional)</span></div>
                    <div><span style="${codeStyle}">ALLOWED_ORIGIN</span><span style="color:#475569;">,</span> <span style="${codeStyle}">MAX_BODY</span><span style="color:#475569;">,</span> <span style="${codeStyle}">MAX_ITEMS</span></div>
                </div>
            </div>

            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
                ${btnLink("ft-tut-gh-link", GITHUB_URL,      "↗ Ver Worker no GitHub",     "rgba(37,99,235,.2)",    "rgba(37,99,235,.4)")}
                ${btnLink("ft-tut-gh-repo", GITHUB_REPO_URL, "↗ Repositório completo",    "rgba(55,65,81,.4)",     "rgba(255,255,255,.12)")}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                ${btnCopy("ft-tut-copy-secret", "Copiar nome do Secret (API_KEY)", "rgba(139,92,246,.15)", "rgba(139,92,246,.35)", "#c4b5fd")}
                ${btnCopy("ft-tut-copy-kv",     "Copiar KV binding (MEDIA)",       "rgba(16,185,129,.15)", "rgba(16,185,129,.35)", "#6ee7b7")}
                ${btnCopy("ft-tut-copy-pfx",    "Copiar prefixo (filmtwist_)",     "rgba(14,165,233,.15)", "rgba(14,165,233,.35)", "#7dd3fc")}
            </div>
        </div>`;

        mod.appendChild(box);
        document.body.appendChild(mod);

        const close = () => mod.remove();
        box.querySelector("#ft-tut-close").onclick = close;
        mod.addEventListener("click", (e) => { if (e.target === mod) close(); });
        box.querySelector("#ft-tut-copy-secret").onclick = () => { GM_setClipboard("API_KEY",    { type: "text/plain" }); toast("Copiado: API_KEY"); };
        box.querySelector("#ft-tut-copy-kv").onclick     = () => { GM_setClipboard("MEDIA",      { type: "text/plain" }); toast("Copiado: MEDIA"); };
        box.querySelector("#ft-tut-copy-pfx").onclick    = () => { GM_setClipboard("filmtwist_", { type: "text/plain" }); toast("Copiado: filmtwist_"); };
    }

    /* =====================================================================
       AUTO SCROLL
       ===================================================================== */

    let autoScrolling   = false;
    let autoScrollTimer = null;

    function stopAutoScroll(btn) {
        autoScrolling = false;
        if (autoScrollTimer) clearTimeout(autoScrollTimer);
        autoScrollTimer = null;
        if (btn) btn.textContent = "Scroll automático (iniciar)";
        toast("Scroll automático parado.");
    }

    async function startAutoScroll(btn) {
        if (autoScrolling) return;
        autoScrolling = true;
        if (btn) btn.textContent = "Scroll automático (parar)";
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
            if (stable >= 6) { stopAutoScroll(btn); toast("Chegou ao fim."); return; }
            autoScrollTimer = setTimeout(step, 700);
        };
        step();
    }

    function toggleAutoScroll(btn) { if (autoScrolling) stopAutoScroll(btn); else startAutoScroll(btn); }

    /* =====================================================================
       MENU COMMANDS
       ===================================================================== */

    GM_registerMenuCommand("Guardar catálogo (Nuvem)",      saveHistory);
    GM_registerMenuCommand("Copiar links visíveis",          copyLinksToClipboard);
    GM_registerMenuCommand("Marcar Transferidos",            markCopiedAsDownloaded);
    GM_registerMenuCommand("Reset Copiados",                 resetCopiedLinks);
    GM_registerMenuCommand("Gerir APIs Cloud",               openApiManagerUI);
    GM_registerMenuCommand("Exportar Backup (JSON)",         exportData);
    GM_registerMenuCommand("Importar Backup (JSON)",         importData);
    GM_registerMenuCommand("Scroll automático (ON/OFF)",     () => toggleAutoScroll(null));

    /* =====================================================================
       MIGRAÇÃO DE DADOS LEGACY (ft_* → filmtwist_*)
       ===================================================================== */

    function migrateLegacyKeys() {
        const migrations = [
            ["ft_catalog",        STORE_CATALOG],
            ["ft_downloaded",     STORE_DOWNLOADED],
            ["ft_download_list",  STORE_DOWNLOAD_LIST],
            ["ft_extra_field",    STORE_EXTRA_FIELD],
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
        const newApiKey = "filmtwist_api_configs";
        const oldApi    = GM_getValue(oldApiKey, null);
        const newApi    = GM_getValue(newApiKey, null);
        if (oldApi && !newApi) { GM_setValue(newApiKey, oldApi); GM_setValue(oldApiKey, "[]"); migrated++; }
        // Migrar hide/pos keys
        [
            ["ft_hide_downloaded_v1", "filmtwist_hide_downloaded_v1"],
            ["ft_hide_history_v1",    "filmtwist_hide_history_v1"],
            ["ft_ui_pos_v1",          "filmtwist_ui_pos_v1"],
            ["ft_ui_min_v1",          "filmtwist_ui_min_v1"],
        ].forEach(([ok, nk]) => {
            const ov = GM_getValue(ok, null);
            const nv = GM_getValue(nk, null);
            if (ov !== null && nv === null) { GM_setValue(nk, ov); GM_setValue(ok, null); }
        });
        if (migrated > 0) console.log(`[FilmTwist] ${migrated} chave(s) migradas de ft_* para filmtwist_*.`);
    }

    /* =====================================================================
       INIT / AUTO UPDATES
       ===================================================================== */

    let _tAuto    = 0;
    let _observer = null;
    let _inited   = false;
    let _needsFullScan = false;

    function scheduleUpdate() {
        clearTimeout(_tAuto);
        _tAuto = setTimeout(() => {
            if (!document.getElementById("ft-panel")) {
                try { injectUI(); } catch (e) { console.error("Falha ao reinjetar UI:", e); }
            }
            try { injectHideButtons(); } catch { }
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
                    if (n.matches?.(CARD_ROOT_SELECTOR)) { queueCard(n); touched = true; }
                    const found = n.querySelectorAll?.(CARD_ROOT_SELECTOR);
                    if (found?.length) { found.forEach(queueCard); touched = true; }
                }
            }
            try { injectHideButtons(); } catch { }
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
            return r;
        };
        const _rs = history.replaceState;
        history.replaceState = function (...args) {
            const r = _rs.apply(this, args);
            _needsFullScan = true; setTimeout(scheduleUpdate, 50);
            return r;
        };
        window.addEventListener("popstate", () => { _needsFullScan = true; setTimeout(scheduleUpdate, 50); });
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
