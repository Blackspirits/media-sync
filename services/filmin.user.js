// ==UserScript==
// @name         Filmin.pt — Gestor de Catálogo, Downloads & Sync Cloud
// @namespace    blackspirits.github.io/
// @version      5.5.17
// @description  Conta e guarda filmes/séries (pagos e gratuitos), sincroniza com Cloudflare Workers (multi-API), gere downloads e copiados, e apresenta uma Dashboard com filtros, poster HD, notas de séries e exportação.
// @author       BlackSpirits & Leinad4Mind
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=filmin.pt
// @match        https://www.filmin.pt/*
// @match        https://filmin.pt/*
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
 * v5.5.17 — Badge ícone: classe CSS dedicada com !important para SVG (protege contra
 *             CSS global do Filmin que sobrepõe width/height inline).
 * v5.5.16 — Badge catálogo: estilo do ícone alinhado com FilmTwist (22×22px, cor #38bdf8).
 * v5.5.15 — Toasts: slide-in da direita, CSS keyframes, animationend dismiss;
 *             ICONS{} Lucide SVG library; makeButton icon:; cloud/history badges → SVG.
 * v5.5.14 — Badge Filmin move to top-right (hover-only, no conflict); "Guardar histórico"
 *             renomeado "Guardar catálogo" (comportamento idêntico ao FilmTwist); select
 *             color-scheme:dark (sem fundo branco); labels ilegíveis #334155→#64748b,
 *             #475569→#94a3b8; ícone catálogo → bookmark sólido.
 * v5.5.13 — Mesmo polish do FilmTwist v1.6.0: tutorial redesenhado (verde), botão
 *             "✦ Gerar" API Key, badges hover-only (opacity 0→1), labels legíveis.
 * v5.5.12 — UX polish: stats grid compacto com ícones SVG; badge on-page movido
 *            para bottom-left (evita "Série"/"Novos Episódios" e ícone alugar/comprar);
 *            API Manager redesenhado (dark #0a0e16, glassmorphism, focus ring verde,
 *            botões coloridos por ação, write-access indicator).
 *
 * v5.5.11 — UX redesign: painel idêntico ao FilmTwist (320px, ponto de cor verde, stats
 *            em grid 2×2, botões com accent+hover). Dashboard: fundo #060c18, stat cards
 *            com ícone+cor, cloud cards refinados, toolbar glassmorphism, cards mais leves
 *            com hover no título (verde), modais actualizados.
 *
 * v5.5.10 — Segurança: esc() em openApiManagerUI previne XSS ao renderizar nomes de API
 *            guardados pelo utilizador. Rate limit 429: sleep bloqueante de 5min substituído
 *            por 60s não bloqueante.
 *
 * v5.5.9 — @match alargado (www + non-www). Breakpoint de 3 colunas: 1000px → 900px.
 *
 * v5.5.8 — Tutorial Worker substituído por link GitHub (sem código embutido):
 *           Worker unificado multi-serviço no repo Blackspirits/media-sync.
 *           GET agora requer auth (READ_KEY ou API_KEY). ALLOWED_PREFIXES via
 *           env var suporta filmin_, filmtwist_, e futuros serviços. Poupa ~120
 *           linhas por script ao remover código embutido.
 *
 * v5.5.7 — Dashboard: modo "cards" agora mostra 4 por linha em desktop
 *           (igual ao modo posters), com breakpoints responsivos 3/2.
 *
 * v5.5.6 — Tutorial Worker corrigido: usa worker real deployado (env.MEDIA,
 *           KV binding MEDIA, chaves filmin_* + service_*, MAX_BODY/MAX_ITEMS/
 *           ALLOWED_ORIGIN). ChatGPT usava FILMIN_KV errado.
 *
 * v5.5.5 — openWorkerTutorialUI() reescrito (ChatGPT):
 *           Código do Worker embutido na UI (GET/POST/DELETE compatível com
 *           o script), botões "Copiar Worker/Secret/KV", instruções passo-a-
 *           passo, suporte a REQUIRE_KEY_FOR_READ. Elimina dependência do link
 *           externo do GitHub.
 *
 * v5.5.4 — Grid poster responsivo + race condition fetchCloudData + readableApiNames:
 *           1. Grid poster: CSS classes + @media queries em vez de inline style
 *              — 4 colunas em ≥1001px, 3 em ≤1000px, 2 em ≤720px.
 *           2. fetchCloudData() com token _cloudFetchSeq: race condition
 *              eliminada — fetch antigo já não sobrescreve resultado mais recente.
 *           3. readableApiNames: histórico (📜) de clouds read-only já aparece
 *              no dashboard (antes exigia apiKey para mostrar o ícone).
 *
 * v5.5.3 — Grid poster 4 colunas + fetchCloudData Promise.all:
 *           1. Dashboard: modo poster força 4 colunas fixas (gridStyle computed);
 *              modo card mantém layout responsivo (auto-fill minmax 250px).
 *           2. fetchCloudData() usa Promise.all — fetch de múltiplas clouds em
 *              paralelo; tempo total passa de T1+T2 para max(T1,T2).
 *
 * v5.5.2 — Performance + 3 bugs omitidos no patch anterior:
 *           1. _needsFullScan declarado com `let` — sem ReferenceError em
 *              "use strict" (scan total só em navegação SPA, não em scroll).
 *           2. GM_setClipboard no dashboard usa { type:"text/plain" } —
 *              formato correcto igual ao resto do script.
 *           3. GETs em fetchCloudData/saveToCloud/restore incluem x-api-key
 *              opcional — workers que exigem auth para leitura já funcionam.
 *
 * v5.5.1 — Hotfix: bloco INIT/AUTO UPDATES duplicado removido.
 *
 * v5.5.0 — Arquitectura SPA robusta + gestão segura de blob URLs:
 *           1. hookSpaNavigation(): intercept pushState/replaceState/popstate
 *              — painel já não desaparece ao navegar em SPA.
 *           2. ensureObserver() com guarda _observer + _inited: sem leaks de
 *              MutationObserver acumulados em re-renders SPA.
 *           3. CSS injection: (head || documentElement) — seguro no arranque.
 *           4. _revokeOldObjectURLs() segura: nunca revoga blobs ainda em uso
 *              num <img> — elimina posters partidos ao scrollar no dashboard.
 *           5. revokeAllObjectURLs() no close() do dashboard: RAM limpa ao
 *              fechar, sem leaks de blob URLs da sessão.
 *           6. dashObjectURLs eliminado: tracking unificado em _objUrls —
 *              menos duplicação, menos pontos de falha.
 *
 * v5.4.0 — Polimento visual + fix de arranque (ChatGPT):
 *           1. init() com guarda readyState — script já não tenta injectar UI
 *              antes do DOM estar pronto; queueCard inicial apanha cards já
 *              presentes na página sem esperar pelo MutationObserver.
 *           2. Textos dos botões: apenas primeira palavra com maiúscula inicial.
 *           3. Botão "Guardar histórico" deixou de ter cor verde — idêntico
 *              aos restantes botões do painel.
 *           4. Dashboard: "Alternar formato" e "Exportar atuais" agrupados
 *              numa linha própria abaixo dos filtros.
 *
 * v5.3.0 — Quatro correcções identificadas por revisão externa (ChatGPT):
 *           1. notesMap no Dashboard usa mergeDataPreferNewest() — notas de
 *              séries já não perdem para versões antigas de outras clouds.
 *           2. __obf/__deobf reescritos com TextEncoder/TextDecoder (Unicode-
 *              safe) — nomes com acentos/emojis deixam de corromper configs.
 *           3. scheduleStats() com throttle de 300ms — updateStats() já não
 *              bate no DOM a cada RAF em scroll infinito.
 *           4. openImageDB() repõe _imgDbPromise=null em erro — evita que uma
 *              falha pontual bloqueie o cache de posters para sempre.
 *
 * v5.2.0 — Seis correcções de bugs identificadas por revisão externa:
 *           1. safeLSGet/safeLSSet: dashboard já não crasha quando localStorage
 *              está bloqueado (viewMode ler/escrever era acesso directo).
 *           2. mergeDataPreferNewest(): STORE_EXTRA_FIELD usa merge que prefere
 *              o saved_at mais recente (notas de séries deixam de se perder).
 *           3. mainAnchor determinístico em applyCardState(): cadeia de selectors
 *              específicos evita apanhar links secundários (overlay, botões).
 *           4. updatedCount corrigido com flag `touched`: deixa de contar por
 *              store — um item em 3 stores contava como 3.
 *           5. openImageDB() com promessa cacheada: IndexedDB já não abre uma
 *              nova ligação por cada leitura/escrita de poster.
 *           6. updateStats() no final de _flushCards(): painel de contagens
 *              actualiza em sincronia com novos cards (Gemini estava certo).
 *
 * v5.1.0 — Correcção getStored(): GM_getValue já não é sobrescrito com "[]"
 *           quando o localStorage está vazio mas o GM tem dados (resilência
 *           a ambientes onde o localStorage pode estar bloqueado).
 *
 * v5.0.1 — Três correcções de performance:
 *           • updateStats() deixou de chamar highlightSavedLinks() em cada ciclo.
 *           • _flushCards() conta hidden cards directamente no DOM (sem delta).
 *           • scheduleUpdate() limpo — apenas reinjecta a UI se desapareceu.
 *           + Label corrigida (STORE_DOWNLOADED_FREE → STORE_CATALOG_FREE).
 *           + FIX #7 isSaved → visuallySaved em applyCardState().
 *
 * v5.0.0 — Arquitectura incremental: WeakSet + RAF + queueCard/_flushCards.
 *           Observer envia só cards novos; highlightSavedLinks() apenas na init
 *           e quando os dados cloud chegam.
 * ─────────────────────────────────────────────────────────────────────────────
 */

(() => {
    "use strict";

    /* =====================================================================
       CONSTANTES — chaves de armazenamento e seletores DOM
       ===================================================================== */

    // Chaves do localStorage / GM_getValue
    const STORE_CATALOG_PAID       = "filmin_catalog_paid";
    const STORE_CATALOG_FREE       = "filmin_catalog_free";
    const STORE_DOWNLOADED_FREE    = "filmin_downloaded_free";
    const STORE_DOWNLOADED_PAID    = "filmin_downloaded_paid";
    const STORE_DASH_VIEW_MODE     = "filmin_dash_view_mode";
    const STORE_DOWNLOAD_COPY_FREE = "filmin_download_list";
    const STORE_API_CONFIGS        = "filmin_api_configs";
    const STORE_EXTRA_FIELD        = "filmin_extra_field";

    // Chaves de UI persistente
    const UI_POS_KEY = "filmin_ui_pos_v6";
    const UI_MIN_KEY = "filmin_ui_min_v6";

    // Chave de legado (File System API)
    const FS_API_KEY = "__BS_FILMIN_FS_API_V2__";

    // Selector para o ícone Premier (conteúdo pago)
    const PREMIER_ICON_SELECTOR =
        "figure.card-image svg.card-media--icon-premier, figure.card-image .card-media--icon-premier";

    // Selectors de links, por ordem de prioridade
    const LINK_SELECTORS = [
        "a.card-options-info[href]",
        "figure.card-image a[href]",
        "a[href^='https://www.filmin.pt/']",
        "a[href^='/']",
    ].join(",");

    // Selector raiz dos cards de conteúdo
    const CARD_ROOT_SELECTOR = ".card.card-media, .card-media, .card";

    // Debounce do scheduleUpdate (ms)
    const AUTO_UPDATE_MS = 650;

    /* =====================================================================
       ESTADO GLOBAL
       ===================================================================== */

    let cloudSaves       = {};   // url → [apiName, ...]
    let cloudFullData    = [];   // todos os itens recebidos das clouds
    let cloudExtraFields = [];   // campo extra (notas de séries) das clouds
    let _cloudFetchSeq   = 0;    // token de sequência — descarta fetches obsoletos
    let isScrapingMetadata = false;

    // Flags de ocultação — persistidas entre sessões
    let hideDownloaded = GM_getValue("filmin_hide_downloaded_v1", false);
    let hidePaid       = GM_getValue("filmin_hide_paid_v1",       false);
    let hideHistory    = GM_getValue("filmin_hide_history_v1",    false);

    /* =====================================================================
       CACHE DE IMAGENS (IndexedDB)
       Evita re-download de posters já visitados.
       ===================================================================== */

    const IMG_DB_NAME    = "filmin_img_cache_db";
    const IMG_STORE_NAME = "images";

    // Mapa de objectURLs criados — necessário para revogar e evitar memory leak
    const _objUrls  = new Map();
    const OBJ_URL_CAP = 400;   // máximo de entradas antes de despejar as mais antigas

    /**
     * Revoga blobs antigos quando o Map ultrapassa OBJ_URL_CAP.
     * Verifica primeiro quais os blob: URLs ainda em uso num <img> para não
     * rebentar posters visíveis ao scrollar para cima no dashboard.
     */
    function _revokeOldObjectURLs() {
        if (_objUrls.size <= OBJ_URL_CAP) return;

        // URLs de blob ainda montados no DOM — não tocar nestes
        const inUse = new Set(
            [...document.querySelectorAll('img[src^="blob:"]')]
                .map(img => img.currentSrc || img.src)
        );

        for (const [k, obj] of _objUrls) {
            if (_objUrls.size <= OBJ_URL_CAP) break;
            if (inUse.has(obj)) continue;   // blob ainda em uso — salta
            URL.revokeObjectURL(obj);
            _objUrls.delete(k);
        }
    }

    /** Revoga TODOS os blob URLs do cache — chamado ao fechar o dashboard */
    function revokeAllObjectURLs() {
        for (const obj of _objUrls.values()) {
            try { URL.revokeObjectURL(obj); } catch { /* ignora */ }
        }
        _objUrls.clear();
    }

    // Promessa cacheada — IndexedDB só abre UMA ligação por sessão em vez de uma por chamada.
    // Em caso de erro, _imgDbPromise é reposta a null para que a próxima tentativa possa tentar
    // de novo (evita que uma falha pontual bloqueie o cache para sempre).
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
        if (_objUrls.has(url)) return _objUrls.get(url);   // já em memória

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
       CSS GLOBAL — badge cloud desaparece no hover do card
       ===================================================================== */

    const globStyle = document.createElement('style');
    globStyle.innerHTML = `
        .filmin-cloud-badge { opacity:0; transition:opacity 0.18s ease !important; }
        article:hover .filmin-cloud-badge,
        .card:hover .filmin-cloud-badge,
        .card-media:hover .filmin-cloud-badge,
        figure:hover .filmin-cloud-badge { opacity:1 !important; }
        .filmin-badge-icon { display:flex !important; align-items:center !important; justify-content:center !important;
            width:22px !important; height:22px !important; flex-shrink:0 !important;
            background:rgba(0,0,0,0.65) !important; color:#38bdf8 !important;
            border-radius:4px !important; border:1px dashed rgba(14,165,233,0.6) !important; }
        .filmin-badge-icon svg { width:13px !important; height:13px !important;
            min-width:13px !important; max-width:13px !important;
            min-height:13px !important; max-height:13px !important;
            flex-shrink:0 !important; }
    `;
    // (head || documentElement) — seguro mesmo que o script corra antes do <head> existir
    (document.head || document.documentElement).appendChild(globStyle);

    /* =====================================================================
       HELPERS DE LOCALSTORAGE SEGURO
       Usado em todos os acessos directos ao localStorage fora do getStored(),
       nomeadamente no dashboard (viewMode) onde o getStored() não é chamado.
       ===================================================================== */

    function safeLSGet(key, fallback = null) {
        try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
    }
    function safeLSSet(key, val) {
        try { localStorage.setItem(key, val); } catch { /* localStorage bloqueado — ignora */ }
    }

    /* =====================================================================
       HELPERS GENÉRICOS
       ===================================================================== */

    const toObj     = (item) => {
        if (!item) return null;
        if (typeof item === "string") return { url: item, title: "", poster: "" };
        if (typeof item === "object") return item;
        return null;
    };
    const safeTrim  = (s) => String(s || "").trim();

    const isValidHttpUrl = (value) => {
        const v = safeTrim(value);
        if (!v || (!v.startsWith("http://") && !v.startsWith("https://"))) return false;
        try { new URL(v); return true; } catch { return false; }
    };

    // Converte hrefs relativos ("/filme/x") em absolutos
    const toAbsUrl = (href) => {
        if (!href) return "";
        if (href.startsWith("http://") || href.startsWith("https://")) return href;
        try { return new URL(href, location.origin).toString(); } catch { return href; }
    };

    // Escolhe o título mais longo e sem sufixos "— Filmin"
    const betterTitle = (n, o) => {
        const dirtyRe = /\s*(-\s*Filmin|ver online\s+(em|en)\s+Filmin)[\s\S]*/i;
        const nn = safeTrim(n).replace(dirtyRe, '').trim();
        const oo = safeTrim(o).replace(dirtyRe, '').trim();
        if (!nn) return oo;
        if (!oo) return nn;
        if (nn.length >= 3 && nn !== oo) return nn;
        return oo;
    };

    // Normaliza URL: remove query string e barra final
    const normUrl = (urlStr) => {
        if (!urlStr) return "";
        const abs = toAbsUrl(urlStr);
        try {
            const u = new URL(abs);
            u.search = "";
            let finalUrl = u.toString();
            if (finalUrl.endsWith('/')) finalUrl = finalUrl.slice(0, -1);
            return finalUrl;
        } catch { return abs; }
    };

    // Prefere poster com URL mais longa e válida
    const betterPoster = (n, o) => {
        const nn = safeTrim(n), oo = safeTrim(o);
        if (!nn || nn.length <= 8 || !isValidHttpUrl(nn)) return oo;
        return nn;
    };

    // Funde arrays de itens, deduplicando por URL normalizada
    const mergeData = (arr) => {
        const map = new Map();
        for (const raw of (arr || [])) {
            const item = toObj(raw);
            if (!item?.url) continue;
            const url = normUrl(item.url);
            if (!url) continue;
            const existing = map.get(url);
            if (!existing) {
                map.set(url, { ...item, url, title: safeTrim(item.title), poster: safeTrim(item.poster), saved_at: item.saved_at || Date.now() });
            } else {
                map.set(url, {
                    ...existing, ...item, url,
                    saved_at:  existing.saved_at || item.saved_at || Date.now(),
                    title:     betterTitle(item.title,  existing.title),
                    poster:    betterPoster(item.poster, existing.poster),
                });
            }
        }
        return Array.from(map.values());
    };

    /**
     * Variante de mergeData para stores onde o registo mais recente deve
     * vencer (ex: STORE_EXTRA_FIELD — notas de séries, edições do dashboard).
     * mergeData() normal preserva o saved_at mais antigo (correcto para histórico);
     * aqui preferimos o mais recente para não perder notas editadas depois.
     */
    function mergeDataPreferNewest(arr) {
        const map = new Map();
        for (const raw of (arr || [])) {
            const item = toObj(raw);
            if (!item?.url) continue;
            const url = normUrl(item.url);
            if (!url) continue;
            const existing = map.get(url);
            if (!existing) {
                map.set(url, { ...item, url, saved_at: item.saved_at || Date.now() });
                continue;
            }
            const exTs = existing.saved_at || 0;
            const itTs = item.saved_at     || 0;
            map.set(url, {
                ...existing, ...item, url,
                saved_at: Math.max(exTs, itTs) || Date.now(),
                title:    betterTitle(item.title,   existing.title),
                poster:   betterPoster(item.poster, existing.poster),
            });
        }
        return Array.from(map.values());
    }

    // Testa variantes de poster HD (poster_0_3) e devolve o primeiro URL válido
    async function getTestedHighResPoster(url) {
        if (!url || typeof url !== 'string') return url;
        const match = url.match(/\/media\/(\d+)\//);
        if (!match) return url;
        if (url.includes('poster_0_3.png') || url.includes('poster_0_3.jpg')) return url;

        const mediaId  = match[1];
        const testUrls = [
            `https://static.filmin.pt/images/pt/media/${mediaId}/1/poster_0_3.png`,
            `https://static.filmin.pt/images/pt/media/${mediaId}/1/poster_0_3.jpg`,
            `https://static.filmin.pt/images/pt/media/${mediaId}/3/poster_0_3.png`,
            `https://static.filmin.pt/images/pt/media/${mediaId}/3/poster_0_3.jpg`,
            `https://static.filmin.pt/images/pt/media/${mediaId}/5/poster_0_3.png`,
            `https://static.filmin.pt/images/pt/media/${mediaId}/5/poster_0_3.jpg`,
        ];

        for (const testUrl of testUrls) {
            try { const res = await fetch(testUrl, { method: 'HEAD' }); if (res.ok) return testUrl; }
            catch { /* continua para o próximo */ }
        }
        return url;
    }

    // A página TVOD (?rights=tvod) trata todo o conteúdo como pago
    function isTVODPage() {
        return new URLSearchParams(location.search).get("rights") === "tvod";
    }

    /* =====================================================================
       TOAST / PROGRESS
       ===================================================================== */

    // ── SVG icon library ──────────────────────────────────────────────────────
    const ICONS = {
        cloud:    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`,
        download: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>`,
        history:  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l3 3"/><path d="M3.05 11a9 9 0 1 0 .5-4"/><polyline points="3 3 3 7 7 7"/></svg>`,
        copy:     `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
        check:    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
        api:      `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
        export:   `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>`,
        poster:   `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`,
        dash:     `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
    };

    // ── Toast infrastructure ──────────────────────────────────────────────────
    function _injectToastCSS() {
        if (document.getElementById("fm-toast-css")) return;
        const s = document.createElement("style");
        s.id = "fm-toast-css";
        s.textContent = `
        #bs-filmin-toast-container { position:fixed;bottom:20px;right:20px;z-index:1000000;
            display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none; }
        .fm-toast { background:rgba(10,14,22,.97);color:#f1f5f9;padding:11px 18px;
            border-radius:8px;font-size:13.5px;font-weight:500;max-width:340px;
            font-family:system-ui,-apple-system,sans-serif;
            border:1px solid rgba(255,255,255,.1);border-left:3px solid #00e0a4;
            box-shadow:0 8px 24px rgba(0,0,0,.6);backdrop-filter:blur(8px);
            animation:fmSlideIn .35s cubic-bezier(.16,1,.3,1) forwards; }
        .fm-toast.fm-toast-out { animation:fmSlideOut .25s ease-in forwards; }
        .fm-toast-progress { width:300px;display:flex;flex-direction:column;gap:8px; }
        @keyframes fmSlideIn { from { transform:translateX(calc(100% + 24px));opacity:0; } to { transform:translateX(0);opacity:1; } }
        @keyframes fmSlideOut { from { transform:translateX(0);opacity:1; } to { transform:translateX(calc(100% + 24px));opacity:0; } }
        `;
        (document.head || document.documentElement).appendChild(s);
    }

    function _getToastContainer() {
        _injectToastCSS();
        let c = document.getElementById("bs-filmin-toast-container");
        if (!c) {
            c = document.createElement("div");
            c.id = "bs-filmin-toast-container";
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
            pToast.className = "fm-toast fm-toast-progress";
            pToast.style.cssText = "padding:12px 18px;background:rgba(10,14,22,.97);border:1px solid rgba(255,255,255,.1);border-left:3px solid #3b82f6;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.6);animation:fmSlideIn .35s cubic-bezier(.16,1,.3,1) forwards;";
            pToast.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#f1f5f9;margin-bottom:8px;">
                    <span class="progress-title" style="font-weight:500;"></span>
                    <span class="progress-pct" style="font-size:11px;color:#94a3b8;">0%</span>
                </div>
                <div style="width:100%;height:4px;background:rgba(255,255,255,.12);border-radius:2px;overflow:hidden;">
                    <div class="progress-fill" style="width:0%;height:100%;background:#3b82f6;transition:width .2s;border-radius:2px;"></div>
                </div>`;
            container.appendChild(pToast);
        }
        if (total > 0) {
            const pct = Math.round((current / total) * 100);
            pToast.querySelector('.progress-title').textContent = title;
            pToast.querySelector('.progress-pct').textContent = `${current}/${total} (${pct}%)`;
            pToast.querySelector('.progress-fill').style.width = `${pct}%`;
            if (current >= total) {
                setTimeout(() => {
                    pToast.classList.add("fm-toast-out");
                    pToast.addEventListener("animationend", () => pToast.remove(), { once: true });
                }, 1000);
            }
        } else if (current === -1) {
            pToast.classList.add("fm-toast-out");
            pToast.addEventListener("animationend", () => pToast.remove(), { once: true });
        }
    }

    function toast(msg, duration = 4000) {
        const container = _getToastContainer();
        const t = document.createElement("div");
        t.className = "fm-toast";
        t.textContent = msg;
        container.appendChild(t);
        const dismiss = () => {
            t.classList.add("fm-toast-out");
            t.addEventListener("animationend", () => t.remove(), { once: true });
        };
        setTimeout(dismiss, duration);
    }

    function buildTextFile(links) {
        const urls = links.map(item => typeof item === 'string' ? item : item.url);
        return urls.join("\n") + (urls.length ? "\n" : "");
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

    /**
     * Lê uma lista do localStorage (preferencial) com fallback para GM_getValue.
     *
     * Prioridade de leitura:
     *   1. localStorage  — disponível na maioria dos ambientes
     *   2. GM_getValue   — fallback se localStorage estiver bloqueado
     *
     * Regra de escrita GM:
     *   - Só sincroniza GM com o valor do localStorage se este tiver dados reais.
     *   - Se o localStorage estiver vazio, recupera o que o GM já tem (não sobrescreve
     *     dados válidos do GM com "[]").
     */
    function getStored(key) {
        let lsData = null, lsError = false;
        try { lsData = localStorage.getItem(key); }
        catch (e) { console.warn("localStorage inacessível, usando GM_getValue.", e); lsError = true; }

        let raw;

        if (lsError) {
            // localStorage bloqueado — usa GM como fonte primária
            raw = GM_getValue(key, "[]");
        } else if (lsData !== null && lsData !== "") {
            // localStorage tem dados — sincroniza GM para estar sempre igual
            raw = lsData;
            GM_setValue(key, raw);
        } else {
            // localStorage vazio — recupera GM (pode ter dados de sessão anterior)
            // sem sobrescrever o GM com "[]"
            raw = GM_getValue(key, "[]");
        }

        try {
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return [];
            return arr.map(item => typeof item === 'string' ? { url: item, title: "", poster: "" } : item);
        } catch { return []; }
    }

    function setStored(key, list) {
        const jsonStr = JSON.stringify(mergeData(list));
        try { localStorage.setItem(key, jsonStr); } catch (e) { console.error("Erro ao guardar no localStorage:", e); }
        GM_setValue(key, jsonStr);
    }

    /* =====================================================================
       CACHE DE STORES POR TICK
       Lê cada store UMA vez por ciclo de highlight, devolvendo Sets prontos
       para lookups O(1) em loops sobre centenas de cards.
       ===================================================================== */
    function buildStoreCache() {
        const catPaid    = getStored(STORE_CATALOG_PAID);
        const downPaid   = getStored(STORE_DOWNLOADED_PAID);
        const downFree   = getStored(STORE_DOWNLOADED_FREE);
        const copiedFree = getStored(STORE_DOWNLOAD_COPY_FREE);
        const catFree    = getStored(STORE_CATALOG_FREE);

        return {
            catPaid, downPaid, downFree, copiedFree, catFree,
            setCatPaid:    new Set(catPaid.map(u => u.url)),
            setDownPaid:   new Set(downPaid.map(u => u.url)),
            setDownFree:   new Set(downFree.map(u => u.url)),
            setCopiedFree: new Set(copiedFree.map(u => u.url)),
            setCatFree:    new Set(catFree.map(u => u.url)),
        };
    }

    /* =====================================================================
       LÓGICA DE PÁGINA
       ===================================================================== */

    function getCardRootForAnchor(a) { return a.closest(CARD_ROOT_SELECTOR); }

    function isPremierForAnchor(a) {
        return !!getCardRootForAnchor(a)?.querySelector(PREMIER_ICON_SELECTOR);
    }

    function isRelevantFilminItem(url) {
        return url.includes("/filme/") || url.includes("/serie/") ||
               url.includes("/curta/") || url.includes("/curtas/") ||
               url.includes("/filmes/") || url.includes("/series/");
    }

    // Set de hrefs já processados — limpo a cada chamada para evitar falsos negativos
    const processedNavLinks = new Set();

    function collectLinksFromPage() {
        processedNavLinks.clear();
        const anchors = [...document.querySelectorAll(LINK_SELECTORS)];
        const all = [], paid = [], free = [];

        for (const a of anchors) {
            const href = normUrl(a.href || toAbsUrl(a.getAttribute("href") || ""));
            if (!href) continue;
            if (!href.startsWith("https://www.filmin.pt/")) continue;
            if (!isRelevantFilminItem(href)) continue;
            if (processedNavLinks.has(href)) continue;
            processedNavLinks.add(href);

            const root = getCardRootForAnchor(a);
            let title = "", poster = "", yearInfo = "";
            if (root) {
                const imgEl     = root.querySelector("img");
                poster          = imgEl ? (imgEl.getAttribute("data-src") || imgEl.getAttribute("data-zoom-src") || imgEl.src || "") : "";
                const titleNode = root.querySelector("h3") || imgEl;
                title           = titleNode ? (titleNode.textContent || titleNode.alt || "").trim() : "";
                const yearNode  = root.querySelector(".card-options-info-heading span");
                yearInfo        = yearNode ? yearNode.textContent.trim() : "";
            }

            const item = { url: href, title, poster, year: yearInfo };
            all.push(item);
            if (isTVODPage()) { paid.push(item); }
            else { (isPremierForAnchor(a) ? paid : free).push(item); }
        }

        return { all: mergeData(all), paid: mergeData(paid), free: mergeData(free) };
    }

    /* =====================================================================
       FILE SYSTEM API (showSaveFilePicker)
       ===================================================================== */

    function fsSupported() {
        return typeof window.showSaveFilePicker === "function" ||
               typeof unsafeWindow.showSaveFilePicker === "function";
    }

    const FS_DB    = "bs_filmin_fs_db_v2";
    const FS_STORE = "kv";

    function __openDB() {
        return new Promise((resolve, reject) => {
            const r = indexedDB.open(FS_DB, 1);
            r.onupgradeneeded = () => {
                const db = r.result;
                if (!db.objectStoreNames.contains(FS_STORE)) db.createObjectStore(FS_STORE);
            };
            r.onsuccess = () => resolve(r.result);
            r.onerror   = () => reject(r.error);
        });
    }
    async function __setKV(k, v) {
        const db = await __openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction(FS_STORE, "readwrite");
            tx.objectStore(FS_STORE).put(v, k);
            tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
        });
    }
    async function __getKV(k) {
        const db = await __openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction(FS_STORE, "readonly");
            const r  = tx.objectStore(FS_STORE).get(k);
            r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
    }
    async function __clearKV(k) {
        const db = await __openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction(FS_STORE, "readwrite");
            tx.objectStore(FS_STORE).delete(k);
            tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
        });
    }
    async function __ensurePerm(h) {
        const p = await h.queryPermission({ mode: "readwrite" });
        return p === "granted" || (await h.requestPermission({ mode: "readwrite" })) === "granted";
    }
    async function __chooseInit(slotKey, suggestedName) {
        const pickerFunc = window.showSaveFilePicker || unsafeWindow.showSaveFilePicker;
        const h = await pickerFunc({
            suggestedName,
            types: [{ description: "Base de Dados JSON", accept: { "application/json": [".json"] } }],
            excludeAcceptAllOption: true,
        });
        if (!(await __ensurePerm(h))) return { ok: false, reason: "NO_PERMISSION" };
        await __setKV(slotKey, h);
        return { ok: true, handle: h };
    }
    async function __readJsonFile(slotKey) {
        try {
            const h = await __getKV(slotKey);
            if (!h || !(await __ensurePerm(h))) return null;
            return JSON.parse(await (await h.getFile()).text());
        } catch { return null; }
    }
    async function __writeFile(slotKey, jsonContent) {
        const h = await __getKV(slotKey);
        if (!h) return { ok: false, reason: "NO_HANDLE" };
        if (!(await __ensurePerm(h))) return { ok: false, reason: "NO_PERMISSION" };
        const w = await h.createWritable();
        await w.write(JSON.stringify(jsonContent, null, 2));
        await w.close();
        return { ok: true };
    }
    async function __clearSlot(slotKey) { await __clearKV(slotKey); return { ok: true }; }

    function fsApi() {
        return { chooseInit: __chooseInit, readJsonFile: __readJsonFile, writeFile: __writeFile, clearSlot: __clearSlot };
    }

    /* =====================================================================
       GUARDAR HISTÓRICO (scroll + scrape + persistência + cloud)
       ===================================================================== */

    const FS_SLOT_HISTORY = "handle_history";

    async function autoScrollToBottom() {
        return new Promise((resolve) => {
            let lastScrollHeight = 0, checks = 0;
            const scrollInterval = setInterval(() => {
                window.scrollTo(0, document.body.scrollHeight);
                if (document.body.scrollHeight === lastScrollHeight) {
                    if (++checks >= 3) { clearInterval(scrollInterval); resolve(); }
                } else { checks = 0; lastScrollHeight = document.body.scrollHeight; }
            }, 800);
        });
    }

    async function saveHistory() {
        toast("A iniciar captura. A realizar scroll automático profundo...");
        await autoScrollToBottom();

        const { free: visualFree, paid: visualPaid } = collectLinksFromPage();
        toast(`A analisar ${visualPaid.length + visualFree.length} capas encontradas...`);

        // Converte posters para HD, com concorrência limitada a 6 pedidos simultâneos
        let processedImages = 0;
        const totalImages   = visualPaid.length + visualFree.length;
        if (totalImages > 0) progressToast('save_history_imgs', 'A converter Posters HD...', 0, totalImages);

        const allItems    = [...visualPaid, ...visualFree];
        const CONCURRENCY = 6;
        for (let i = 0; i < allItems.length; i += CONCURRENCY) {
            await Promise.all(allItems.slice(i, i + CONCURRENCY).map(async (item) => {
                if (item.poster) item.poster = await getTestedHighResPoster(item.poster);
                processedImages++;
                progressToast('save_history_imgs', 'A converter Posters HD...', processedImages, totalImages);
            }));
        }

        if (!visualFree.length && !visualPaid.length)
            return toast("Nenhum link encontrado no ecrã para processar.");

        toast(`Scraping completo: ${visualPaid.length} Pagos | ${visualFree.length} Grátis.`);

        let existingJsonData = { catalog_paid: [], catalog_free: [] };
        let hasFsSupport = fsSupported();

        if (hasFsSupport) {
            const handle = await fsApi().readJsonFile(FS_SLOT_HISTORY);
            if (handle) { existingJsonData = handle; }
            else {
                const res = await fsApi().chooseInit(FS_SLOT_HISTORY, "filmin_historico.json");
                if (!res.ok) { toast("Operação de Ficheiro cancelada. Modo de Backup Manual ativado."); hasFsSupport = false; }
            }
        }

        const currentLocalPaid    = getStored(STORE_CATALOG_PAID);
        const currentLocalCatFree = getStored(STORE_CATALOG_FREE);

        const mergedPaid    = mergeData([...(existingJsonData.catalog_paid  || []), ...currentLocalPaid,    ...visualPaid]);
        const mergedCatFree = mergeData([...(existingJsonData.catalog_free  || []), ...currentLocalCatFree, ...visualFree]);

        setStored(STORE_CATALOG_PAID, mergedPaid);
        setStored(STORE_CATALOG_FREE, mergedCatFree);

        const finalPayload = { catalog_paid: mergedPaid, catalog_free: mergedCatFree };

        if (hasFsSupport) {
            try {
                await fsApi().writeFile(FS_SLOT_HISTORY, finalPayload);
                toast(`Ficheiro gravado! Pagos: ${mergedPaid.length} | Catálogo Grátis: ${mergedCatFree.length}`);
            } catch (e) {
                console.error(e); hasFsSupport = false;
                toast("Falha ao escrever Ficheiro Json. Modo Downloader Manual.");
            }
        }

        if (!hasFsSupport) {
            const dateStr = new Date().toISOString().split('T')[0];
            downloadFallback(`filmin_historico_${dateStr}.json`, JSON.stringify(finalPayload, null, 2));
            toast(`Backup manual gerado. Pagos: ${mergedPaid.length} | Catálogo Grátis: ${mergedCatFree.length}`);
        }

        toast("A enviar itens para a Cloudflare...");
        await saveToCloud();
    }

    /* =====================================================================
       COPIAR GRÁTIS
       ===================================================================== */

    async function copyFreeLinksToClipboard() {
        const { free } = collectLinksFromPage();
        const storedCopied      = getStored(STORE_DOWNLOAD_COPY_FREE);
        const storedCopiedSet   = new Set(storedCopied.map(u => u.url));
        const storedDownFreeSet = new Set(getStored(STORE_DOWNLOADED_FREE).map(u => u.url));
        const configs           = getApiConfigs();
        const excludedApiNames  = new Set(configs.filter(c => c.excludeFromCopy).map(c => c.name));

        let skippedByExclusion = 0;
        const newOnes = free.filter(u => {
            if (storedCopiedSet.has(u.url) || storedDownFreeSet.has(u.url)) return false;
            const urlClouds = cloudSaves[u.url] || [];
            if (urlClouds.some(name => excludedApiNames.has(name))) { skippedByExclusion++; return false; }
            return true;
        });

        if (newOnes.length === 0) {
            GM_setClipboard("", { type: "text/plain" });
            return toast(skippedByExclusion > 0
                ? `🚫 Nada copiado. ${skippedByExclusion} links com restrição de exclusão.`
                : "Nenhum link novo grátis para copiar. Área de Transferência esvaziada.");
        }

        const merged = mergeData([...storedCopied, ...newOnes]);
        setStored(STORE_DOWNLOAD_COPY_FREE, merged);
        GM_setClipboard(buildTextFile(merged), { type: "text/plain" });

        if (newOnes.length > 0) { toast(`A enviar ${newOnes.length} grátis para a Nuvem...`); await saveToCloud(); }

        refreshAllCards();
        updateStats();
        toast(`Copiados: ${merged.length} (Novos: ${newOnes.length})${skippedByExclusion > 0 ? ` 🚫 Omitidos: ${skippedByExclusion}` : ''}`);
    }

    async function markCopiedAsDownloaded() {
        const copiedFree = getStored(STORE_DOWNLOAD_COPY_FREE);
        if (copiedFree.length === 0)
            return toast("Não tens filmes marcados como 'Copiados' para transferir.");

        setStored(STORE_DOWNLOADED_FREE, mergeData([...getStored(STORE_DOWNLOADED_FREE), ...copiedFree]));
        setStored(STORE_DOWNLOAD_COPY_FREE, []);

        refreshAllCards();
        updateStats();
        toast(`A sincronizar ${copiedFree.length} filmes na Nuvem...`);
        await saveToCloud();
        toast(`${copiedFree.length} filmes movidos de 'Copiados' para 'Transferidos'!`);
    }

    function resetCopiedLinks() {
        const copiedFree = getStored(STORE_DOWNLOAD_COPY_FREE);
        if (copiedFree.length === 0) return toast("A lista de copiados já está vazia.");
        if (confirm(`Tem a certeza que deseja esvaziar a lista atual de ${copiedFree.length} links copiados?`)) {
            setStored(STORE_DOWNLOAD_COPY_FREE, []);
            toast("Lista de links copiados esvaziada.");
            updateStats(); refreshAllCards();
        }
    }

    /* =====================================================================
       BACKUP — exportar / importar
       ===================================================================== */

    function exportData() {
        const payload = {
            downloaded_free: getStored(STORE_DOWNLOADED_FREE),
            downloaded_paid: getStored(STORE_DOWNLOADED_PAID),
            catalog_paid:    getStored(STORE_CATALOG_PAID),
            catalog_free:    getStored(STORE_CATALOG_FREE),
            copied_free:     getStored(STORE_DOWNLOAD_COPY_FREE),
        };
        const dateStr = new Date().toISOString().split('T')[0];
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href = url; a.download = `filmin_backup_${dateStr}.json`; a.click();
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
            if (!file) { toast("Nenhum ficheiro selecionado."); return; }
            const reader = new FileReader();
            reader.onload = (ev) => {
                const textContent = ev.target.result.trim();
                let data;
                try {
                    try { data = JSON.parse(textContent); }
                    catch {
                        // Tenta interpretar como lista de URLs em texto simples
                        if (textContent.includes('filmin.pt/')) {
                            const lines = textContent.split(/\r?\n/).map(l => l.trim())
                                .filter(l => l.includes('filmin.pt/') && isValidHttpUrl(l));
                            if (lines.length > 0) {
                                const importArray = lines.map(url => ({ url, title: "", poster: "" }));
                                setStored(STORE_DOWNLOAD_COPY_FREE, mergeData([...getStored(STORE_DOWNLOAD_COPY_FREE), ...importArray]));
                                refreshAllCards(); updateStats();
                                toast(`Importados ${lines.length} links. A extrair metadados...`);
                                scrapeMissingMetadataInBackground(importArray.filter(i => !i.title || !i.poster));
                                return;
                            }
                        }
                        throw new Error("Formato inválido");
                    }

                    if (!data || typeof data !== 'object') throw new Error("Formato JSON inválido.");

                    const normalizeData = (arr) => {
                        if (!Array.isArray(arr)) return [];
                        return arr.map(item => typeof item === 'string' ? { url: item, title: "", poster: "" } : item);
                    };

                    const inPaid        = normalizeData(data.catalog_paid);
                    const inFree        = normalizeData(data.downloaded_free);
                    const inCatalogFree = normalizeData(data.catalog_free);
                    const inCopied      = normalizeData(data.copied_free);
                    const inDownPaid    = normalizeData(data.downloaded_paid);

                    const totalSegments = 5;
                    let seg = 0;

                    if (inPaid.length)        { progressToast('json_import', 'A mesclar Histórico Pago...',    ++seg, totalSegments); setStored(STORE_CATALOG_PAID,       mergeData([...getStored(STORE_CATALOG_PAID),       ...inPaid]));       }
                    if (inFree.length)        { progressToast('json_import', 'A mesclar Downloads Grátis...', ++seg, totalSegments); setStored(STORE_DOWNLOADED_FREE,    mergeData([...getStored(STORE_DOWNLOADED_FREE),    ...inFree]));       }
                    if (inCatalogFree.length) { progressToast('json_import', 'A mesclar Histórico Grátis...',  ++seg, totalSegments); setStored(STORE_CATALOG_FREE,       mergeData([...getStored(STORE_CATALOG_FREE),       ...inCatalogFree]));}
                    if (inCopied.length)      { progressToast('json_import', 'A mesclar Temporários...',       ++seg, totalSegments); setStored(STORE_DOWNLOAD_COPY_FREE, mergeData([...getStored(STORE_DOWNLOAD_COPY_FREE), ...inCopied]));     }
                    if (inDownPaid.length)    { progressToast('json_import', 'A mesclar Downloads Pagos...',   ++seg, totalSegments); setStored(STORE_DOWNLOADED_PAID,    mergeData([...getStored(STORE_DOWNLOADED_PAID),    ...inDownPaid]));   }

                    progressToast('json_import', 'JSON Processado!', totalSegments, totalSegments);

                    const importedAll = mergeData([...inPaid, ...inFree, ...inCatalogFree, ...inCopied, ...inDownPaid]);
                    const dirtyRe     = /\s*(-\s*Filmin|ver online\s+(em|en)\s+Filmin)[\s\S]*/i;
                    const incompleteItems = importedAll.filter(item => !item.title || !item.poster || dirtyRe.test(item.title));

                    if (importedAll.some(i => i.title && i.poster)) saveToCloud();

                    refreshAllCards(); updateStats();
                    toast("Listagens importadas com sucesso!");

                    if (window._filminDashUpdateItem)
                        importedAll.forEach(item => window._filminDashUpdateItem(item.url, item.title || '', item.poster || '', item.year || ''));

                    if (incompleteItems.length > 0) {
                        toast(`${incompleteItems.length} links sem metadados. A extrair...`);
                        scrapeMissingMetadataInBackground(incompleteItems);
                    }
                } catch (err) {
                    console.error(err);
                    toast("Erro: Ficheiro JSON corrompido ou formato inválido.");
                }
            };
            reader.onerror = () => toast("Erro ao ler o ficheiro.");
            reader.readAsText(file);
        };

        document.body.appendChild(fileInput); fileInput.click(); document.body.removeChild(fileInput);
    }

    /* =====================================================================
       SCRAPE DE METADADOS EM BACKGROUND
       Preenchimento de títulos e posters em falta, com rate-limit e backoff.
       ===================================================================== */

    async function scrapeMissingMetadataInBackground(items) {
        if (isScrapingMetadata) return;
        isScrapingMetadata = true;

        const totalItems = items.length;
        let updatedCount = 0;
        if (totalItems > 0) progressToast('metadata_scrape', 'A extrair dados...', 0, totalItems);

        const dashDirtyHookRe = /\s*(-\s*Filmin|ver online\s+(em|en)\s+Filmin)[\s\S]*/i;
        const sleep  = ms => new Promise(r => setTimeout(r, ms));
        let baseDelay = 1200;
        const ALL_KEYS = [STORE_CATALOG_PAID, STORE_DOWNLOADED_FREE, STORE_DOWNLOAD_COPY_FREE, STORE_CATALOG_FREE, STORE_DOWNLOADED_PAID];

        for (let i = 0; i < totalItems; i++) {
            const item = items[i];
            progressToast('metadata_scrape', 'A extrair dados...', i + 1, totalItems);
            if (window._filminDashScrapeProgress) window._filminDashScrapeProgress(i + 1, totalItems);

            // Se entretanto já foi resolvido por outra via, propaga e salta
            let alreadyComplete = false;
            for (const KEY of ALL_KEYS) {
                const found = getStored(KEY).find(u => u.url === item.url);
                if (found?.title && found?.poster && found.title !== "Sem Título" && !dashDirtyHookRe.test(found.title)) {
                    Object.assign(item, { title: found.title, poster: found.poster, year: found.year });
                    alreadyComplete = true; break;
                }
            }

            if (alreadyComplete) {
                let touched = false;
                ALL_KEYS.forEach(KEY => {
                    const list = getStored(KEY), idx = list.findIndex(u => u.url === item.url);
                    if (idx !== -1) { list[idx] = { ...list[idx], ...item }; setStored(KEY, list); touched = true; }
                });
                if (touched) updatedCount++;
                if (window._filminDashUpdateItem) window._filminDashUpdateItem(item.url, item.title, item.poster, item.year);
                continue;
            }

            try {
                await sleep(baseDelay);
                const res = await fetch(item.url);
                if (res.ok) {
                    const doc    = new DOMParser().parseFromString(await res.text(), "text/html");
                    const dirtyRe = /\s*(-\s*Filmin|ver online\s+(em|en)\s+Filmin)[\s\S]*/i;

                    const h1  = doc.querySelector("h1.display-1") || doc.querySelector("h1, h2.title");
                    let title = h1 ? h1.textContent.trim().replace(dirtyRe, '') : "";
                    if (!title) title = (doc.querySelector("title")?.textContent || "").trim().replace(dirtyRe, '');
                    title = title.replace(/\s+/g, ' ').trim();

                    const timeNode = doc.querySelector(".year-labels__container time");
                    let yearInfo   = timeNode ? timeNode.textContent.trim() : (doc.querySelector(".year-labels__container")?.textContent.trim().replace(/\s+/g, ' ') || "");
                    yearInfo       = (yearInfo.match(/\b(19|20)\d{2}\b/) || [""])[0];

                    const metaImage = doc.querySelector('meta[property="og:image"]');
                    let poster      = metaImage?.getAttribute('content') || doc.querySelector("img[data-src]")?.getAttribute('data-src') || "";

                    if (!title && !poster) { title = "Página Inválida"; poster = "https://placehold.co/280x400?text=Invalido"; }

                    item.title  = title || "Sem Título";
                    item.year   = yearInfo || item.year || "";
                    item.poster = (poster && !poster.includes('placehold.co'))
                        ? await getTestedHighResPoster(poster)
                        : (poster || "https://placehold.co/280x400?text=Sem+Capa");

                    // touched=true se actualizado em pelo menos 1 store — evita contar por store
                    let touchedOk = false;
                    ALL_KEYS.forEach(KEY => {
                        const list = getStored(KEY), idx = list.findIndex(u => u.url === item.url);
                        if (idx !== -1) { list[idx] = item; setStored(KEY, list); touchedOk = true; }
                    });
                    if (touchedOk) updatedCount++;
                    if (window._filminDashUpdateItem) window._filminDashUpdateItem(item.url, item.title, item.poster, item.year);
                } else {
                    if (res.status === 429) { baseDelay += 2000; console.warn("Rate limit (429). Cooldown 60s..."); await new Promise(r => setTimeout(r, 60000)); }
                    else { baseDelay = Math.min(baseDelay + 500, 5000); }

                    item.title = "Página Inativa / Erro (Rever)";
                    item.poster = "https://placehold.co/280x400?text=Inativo";
                    item.year   = "";
                    let touchedErr = false;
                    ALL_KEYS.forEach(KEY => {
                        const list = getStored(KEY), idx = list.findIndex(u => u.url === item.url);
                        if (idx !== -1) { list[idx] = item; setStored(KEY, list); touchedErr = true; }
                    });
                    if (touchedErr) updatedCount++;
                    if (window._filminDashUpdateItem) window._filminDashUpdateItem(item.url, item.title, item.poster, item.year);
                }
            } catch (err) {
                console.error(`Erro ao fazer scrape de ${item.url}`, err);
                if (window._filminDashUpdateItem) window._filminDashUpdateItem(item.url, "Erro de Rede", "https://placehold.co/280x400?text=Erro", "");
            }
            await sleep(1100);
        }

        if (updatedCount > 0) {
            saveToCloud();
            setTimeout(() => toast(`Recuperação concluída! ${updatedCount} metadados atualizados.`), 1500);
        }
        isScrapingMetadata = false;
    }

    /* =====================================================================
       OBSERVER INCREMENTAL + applyCardState()

       Modelo de actualização em dois níveis:
         • INCREMENTAL (scroll / DOM mutations)
             queueCard → _pendingCards → _flushCards() via RAF
             Processa apenas cards novos; WeakSet impede reprocessamento.

         • FULL SWEEP (init + chegada de dados cloud + botões de ocultar)
             highlightSavedLinks() varre todos os cards do DOM.
             refreshAllCards() descarta o WeakSet e reencaminha tudo.
       ===================================================================== */

    const _seenCards    = new WeakSet();  // cards já processados nesta sessão
    const _pendingCards = new Set();      // cards aguardando o próximo RAF
    let   _rafId        = 0;

    /** Adiciona um card à fila de processamento (se ainda não visto) */
    function queueCard(el) {
        if (!el || _seenCards.has(el)) return;
        _pendingCards.add(el);
        if (!_rafId) _rafId = requestAnimationFrame(_flushCards);
    }

    /**
     * Processa todos os cards pendentes num único frame.
     * Conta hidden cards directamente no DOM para evitar erros de delta acumulado.
     */
    function _flushCards() {
        _rafId = 0;
        if (_pendingCards.size === 0) return;

        const cache            = buildStoreCache();
        const cloudMap         = _buildCloudMap();
        const configs          = getApiConfigs();
        const excludedFromHide = new Set(configs.filter(c => c.excludeFromHide).map(c => c.name));
        const readableApiNames = new Set(configs.map(c => c.name)); // todas as clouds, com ou sem key

        for (const card of _pendingCards) {
            _seenCards.add(card);
            applyCardState(card, cache, cloudMap, configs, excludedFromHide, readableApiNames);
        }
        _pendingCards.clear();

        // Conta no DOM em vez de acumular delta — evita dupla contagem
        _currentHiddenCount = [...document.querySelectorAll(CARD_ROOT_SELECTOR)].filter(card => {
            const container = card.parentElement?.parentElement || card;
            return container.style.display === "none";
        }).length;
        updateNativeResultsText(_currentHiddenCount);
        // Throttle de 300ms — evita DOM thrashing em scroll infinito
        scheduleStats();
    }

    // Contador global de cards ocultos (para o texto nativo de resultados)
    let _currentHiddenCount = 0;

    /**
     * Throttle de 300ms para updateStats() — evita bater no DOM a cada RAF
     * durante scroll infinito. O intervalo é curto o suficiente para parecer
     * responsivo mas elimina centenas de querySelectorAll desnecessários.
     */
    let _statsThrottle = 0;
    function scheduleStats() {
        if (_statsThrottle) return;
        _statsThrottle = setTimeout(() => { _statsThrottle = 0; updateStats(); }, 300);
    }

    /** Descarta o WeakSet e reencaminha todos os cards — chamado quando os dados mudam */
    function refreshAllCards() {
        document.querySelectorAll(CARD_ROOT_SELECTOR).forEach(card => {
            _seenCards.delete(card);
            queueCard(card);
        });
        _currentHiddenCount = 0;
    }

    function _buildCloudMap() {
        const cloudMap = new Map();
        for (const item of cloudFullData) {
            if (!cloudMap.has(item.url)) cloudMap.set(item.url, []);
            cloudMap.get(item.url).push(item);
        }
        return cloudMap;
    }

    /**
     * Aplica estado visual a um único card (opacidade, borda, badge cloud, botão inline).
     * Retorna true se o card foi ocultado.
     */
    function applyCardState(root, cache, cloudMap, configs, excludedFromHide, readableApiNames) {
        // Selector em cascata: do mais específico para o mais genérico,
        // para não apanhar links secundários (overlays, botões de opções, etc.)
        const mainAnchor =
            root.querySelector("a.card-options-info[href]") ||
            root.querySelector("figure.card-image a[href]") ||
            root.querySelector("a[href*='/filme/'], a[href*='/serie/'], a[href*='/curta/'], a[href*='/curtas/']");
        if (!mainAnchor) return false;

        const href = normUrl(mainAnchor.href || toAbsUrl(mainAnchor.getAttribute("href") || ""));
        if (!href || !isRelevantFilminItem(href)) return false;

        const isPaid    = isTVODPage() || !!root.querySelector(PREMIER_ICON_SELECTOR);
        const STORE_KEY = isPaid ? STORE_DOWNLOADED_PAID : STORE_DOWNLOADED_FREE;

        // Estado local
        const isSavedFree    = cache.setDownFree.has(href);
        const isSavedPaid    = cache.setDownPaid.has(href);
        const isCopiedFree   = cache.setCopiedFree.has(href);
        const isCatalogLocal = cache.setCatFree.has(href) || cache.setCatPaid.has(href);

        // Estado cloud
        const cloudItems         = cloudMap.get(href) || [];
        const dlCloudItems       = cloudItems.filter(i => i.listType === STORE_DOWNLOADED_FREE || i.listType === STORE_DOWNLOADED_PAID);
        const catalogCloudItems  = cloudItems.filter(i => (i.listType === STORE_CATALOG_FREE || i.listType === STORE_CATALOG_PAID) && readableApiNames.has(i.apiName));

        const isSavedInCloud   = dlCloudItems.length > 0;
        const visuallyCatalog  = catalogCloudItems.length > 0 || isCatalogLocal;
        const cloudNames       = [...new Set(dlCloudItems.map(i => i.apiName))];
        const isOnlyInExcludedClouds = cloudNames.length > 0 && cloudNames.every(n => excludedFromHide.has(n));

        const isSavedLocally     = isSavedFree || isSavedPaid || isCopiedFree;
        const visuallySaved      = isSavedLocally || isSavedInCloud;
        const isSavedPermanently = isSavedFree || isSavedPaid;
        const meetsHideCriteria  = isSavedPermanently || (isSavedInCloud && !isOnlyInExcludedClouds);

        const containerToHide = root.parentElement?.parentElement || root;

        root.style.boxShadow  = "";
        root.style.transition = "all 0.2s ease";

        // Ocultar card segundo as flags activas
        if ((meetsHideCriteria && hideDownloaded) || (isPaid && hidePaid) || (visuallyCatalog && hideHistory)) {
            containerToHide.style.display = "none";
            return true;
        } else {
            containerToHide.style.display = "";
        }

        // Badge cloud (☁️ / 📜)
        root.querySelector('.filmin-cloud-badge')?.remove();
        if (isSavedInCloud || visuallyCatalog) {
            const badge = document.createElement("div");
            badge.className = "filmin-cloud-badge";
            badge.style.cssText = "position:absolute;top:8px;right:8px;z-index:100;display:flex;gap:4px;align-items:center;pointer-events:none;";

            if (visuallyCatalog) {
                const icon = document.createElement("div");
                icon.className = "filmin-badge-icon";
                icon.title = "Presente no Histórico"; icon.innerHTML = ICONS.history;
                badge.appendChild(icon);
            }
            if (isSavedInCloud) {
                const pill = document.createElement("div");
                pill.style.cssText = "background:rgba(0,0,0,0.75);color:#fff;font-size:10px;padding:4px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.2);backdrop-filter:blur(2px);font-weight:bold;";
                let colorfulNames = "";
                cloudNames.forEach((n, idx) => {
                    const match = dlCloudItems.find(i => i.apiName === n);
                    colorfulNames += `<span style="color:${match.apiColor}">${n}</span>` + (idx < cloudNames.length - 1 ? ", " : "");
                });
                pill.innerHTML = `${ICONS.cloud} <span style='display:inline-flex;align-items:center;gap:3px;'>${colorfulNames}</span>`; pill.style.display='flex'; pill.style.alignItems='center'; pill.style.gap='4px';
                badge.appendChild(pill);
            }
            root.style.position = "relative";
            root.appendChild(badge);
        }

        // Opacidade e borda colorida conforme estado
        if (visuallySaved) {
            const poster = root.querySelector('.card-image') || root.querySelector('figure') || root;
            poster.style.opacity = "0.35";
            if (isCopiedFree && !isSavedFree && !isSavedPaid)        root.style.boxShadow = "0 0 0 3px #ffc107";
            else if (isSavedInCloud && !isSavedFree && !isSavedPaid) root.style.boxShadow = `0 0 0 3px ${getApiColor(cloudNames[0], configs)}`;
            else                                                       root.style.boxShadow = "0 0 0 3px #10b981";
            root.style.borderRadius = "6px";
        } else {
            const poster = root.querySelector('.card-image') || root.querySelector('figure') || root;
            poster.style.opacity = "1"; poster.style.filter = "none";
            root.style.boxShadow = "";
        }

        // Botão inline de guardar/remover por card
        const controls = root.querySelector('.card-options-controls');
        if (controls) {
            controls.querySelectorAll('.filmin-btn-downloaded').forEach(b => b.remove());

            const imgEl     = root.querySelector("img");
            const poster    = imgEl ? (imgEl.getAttribute("data-src") || imgEl.src) : "";
            const titleNode = root.querySelector("h3") || imgEl;
            const title     = titleNode ? (titleNode.textContent || titleNode.alt || "Sem Título") : "Sem Título";
            const yearNode  = root.querySelector(".card-options-info-heading span");
            const yearInfo  = yearNode ? yearNode.textContent.trim() : "";

            let color = 'currentColor';
            let label = `Guardar Local (${isPaid ? 'Pago' : 'Grátis'})`;
            if (isCopiedFree && !isSavedFree && !isSavedPaid) { color = '#ffc107'; label = `Marcar como Guardado (Copiado)`; }
            else if (isSavedFree)    { color = '#10b981'; label = `Remover da lista (Transferidos Grátis)`; }
            else if (isSavedPaid)    { color = '#3b82f6'; label = `Remover da lista (Transferidos Pagos)`; }
            else if (isSavedInCloud) { color = '#8b5cf6'; label = `Guardar Local (Já está na nuvem)`; }

            const opacity = visuallySaved ? '1' : '0.6';
            const btnHtml = `
            <span class="c-button c-button--sm c-button--text filmin-btn-downloaded" aria-label="${label}" role="button" title="${label}" style="cursor:pointer;opacity:${opacity};">
                <svg class="o-svg-icon icon--sm c-button__icon" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
            </span>`;

            const calificationBtn = controls.querySelector('[aria-label="calification"]');
            if (calificationBtn) calificationBtn.insertAdjacentHTML('beforebegin', btnHtml);
            else controls.insertAdjacentHTML('beforeend', btnHtml);

            const newBtn = controls.querySelector('.filmin-btn-downloaded');
            if (newBtn) {
                newBtn.onmousedown = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
                newBtn.onclick = async (ev) => {
                    ev.preventDefault(); ev.stopPropagation();
                    toast("A verificar Capa em Alta Definição...");
                    const finalPoster   = await getTestedHighResPoster(poster);
                    let currentList     = getStored(STORE_KEY);
                    let copiedList      = getStored(STORE_DOWNLOAD_COPY_FREE);
                    const isCurrentlySaved  = currentList.some(u => u.url === href);
                    const isCurrentlyCopied = copiedList.some(u => u.url === href);
                    const mediaLabel = href.includes("/serie/") ? "Série" : href.includes("/curta/") ? "Curta" : "Filme";
                    const art        = mediaLabel === "Filme" ? "o" : "a";

                    if (isCurrentlySaved) {
                        currentList = currentList.filter(u => u.url !== href);
                        setStored(STORE_KEY, currentList);
                        if (isCurrentlyCopied) setStored(STORE_DOWNLOAD_COPY_FREE, copiedList.filter(u => u.url !== href));
                        toast(`${mediaLabel} removid${art} da lista local!`);
                        removeFromCloud(href);
                    } else if (isCurrentlyCopied) {
                        setStored(STORE_DOWNLOAD_COPY_FREE, copiedList.filter(u => u.url !== href));
                        setStored(STORE_KEY, [...currentList, { url: href, title, poster: finalPoster }]);
                        toast(`${mediaLabel} movid${art} de 'Copiado' para 'Guardado'!`);
                        saveToCloud();
                    } else {
                        setStored(STORE_KEY, [...currentList, { url: href, title, poster: finalPoster }]);
                        toast(`${mediaLabel} guardad${art} localmente!`);
                        saveToCloud();
                    }

                    // Reprocessa apenas este card
                    _seenCards.delete(root);
                    queueCard(root);
                    updateStats();
                };
            }
        } else if (visuallySaved) {
            // Sem controls visíveis — aplica só borda colorida
            if (isCopiedFree && !isSavedFree && !isSavedPaid) { root.style.boxShadow = "0 0 0 3px #ffc107"; root.style.borderRadius = "6px"; }
            else if (isSavedFree)  { root.style.boxShadow = "0 0 0 3px #10b981"; root.style.borderRadius = "6px"; }
            else if (isSavedPaid)  { root.style.boxShadow = "0 0 0 3px #3b82f6"; root.style.borderRadius = "6px"; }
        }

        return false;
    }

    /**
     * Full sweep — varre todos os cards do DOM.
     * Chamado apenas na init e quando os dados cloud chegam.
     * Em scroll/mutations é substituído pelo modelo incremental (queueCard).
     */
    function highlightSavedLinks() {
        _currentHiddenCount = 0;
        const cache            = buildStoreCache();
        const cloudMap         = _buildCloudMap();
        const configs          = getApiConfigs();
        const excludedFromHide = new Set(configs.filter(c => c.excludeFromHide).map(c => c.name));
        const readableApiNames = new Set(configs.map(c => c.name)); // todas as clouds, com ou sem key

        for (const card of document.querySelectorAll(CARD_ROOT_SELECTOR)) {
            _seenCards.delete(card);   // força reprocessamento mesmo de cards já vistos
            if (applyCardState(card, cache, cloudMap, configs, excludedFromHide, readableApiNames)) _currentHiddenCount++;
            _seenCards.add(card);
        }
        updateNativeResultsText(_currentHiddenCount);
    }

    /* =====================================================================
       UI UTILS
       ===================================================================== */

    function updateNativeResultsText(hiddenCount) {
        const filtersContainer = document.querySelector('.d-flex.order-last');
        if (!filtersContainer?.parentElement) return;
        const resultsEl = filtersContainer.parentElement.querySelector('p');
        if (!resultsEl || !resultsEl.textContent.toLowerCase().includes('resultados')) return;
        if (!resultsEl.hasAttribute('data-original-text'))
            resultsEl.setAttribute('data-original-text', resultsEl.textContent);
        const originalText = resultsEl.getAttribute('data-original-text');
        if (hiddenCount > 0) {
            const match = originalText.match(/([\d.,\s]+)\s+resultados/i);
            if (match) {
                const newNum = Math.max(0, parseInt(match[1].replace(/\D/g, ''), 10) - hiddenCount);
                resultsEl.textContent = originalText.replace(match[1].trim(), newNum.toLocaleString('pt-PT'));
            }
        } else { resultsEl.textContent = originalText; }
    }

    let panel, body, statsEl;

    function loadUIState() {
        const pos = JSON.parse(GM_getValue(UI_POS_KEY, '{"right":14,"bottom":14}'));
        const min = GM_getValue(UI_MIN_KEY, false);
        return { pos, min };
    }
    function saveUIPos(pos) { GM_setValue(UI_POS_KEY, JSON.stringify(pos)); }
    function setMinimized(v) { GM_setValue(UI_MIN_KEY, !!v); }
    function fmtStats(s)   { return `Itens: ${s.all}  |  Pagos: ${s.paid}  |  Grátis: ${s.free}`; }
    function currentStats() { const { all, paid, free } = collectLinksFromPage(); return { all: all.length, paid: paid.length, free: free.length }; }

    /**
     * Actualiza o painel de estatísticas.
     * Nota: NÃO chama highlightSavedLinks() — o observer incremental trata os cards.
     * O highlight completo só acontece na init e na chegada de dados cloud.
     */
    // SVG icons para stats — nítidos em qualquer DPI
    const STAT_ICONS = {
        page:     `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
        catalog:  `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M5 3a2 2 0 0 0-2 2v16l9-4 9 4V5a2 2 0 0 0-2-2H5z"/></svg>`,
        download: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
        copy:     `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    };

    function updateStats() {
        if (!statsEl) return;
        const s = currentStats();
        const pg   = s.all;
        const catF = getStored(STORE_CATALOG_FREE).length;
        const catP = getStored(STORE_CATALOG_PAID).length;
        const cpy  = getStored(STORE_DOWNLOAD_COPY_FREE).length;
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
                ${cell(STAT_ICONS.page,    '#94a3b8', pg,   'Na página')}
                ${cell(STAT_ICONS.catalog, '#00e0a4', catF, 'Ficheiro Grátis')}
                ${cell(STAT_ICONS.download,'#a78bfa', catP, 'Ficheiro Pagos')}
                ${cell(STAT_ICONS.copy,    cpy > 0 ? '#f59e0b' : '#64748b', cpy, 'Copiados')}
            </div>`;

        const btnMarkCopied = document.getElementById("btn-mark-copied-filmin");
        if (btnMarkCopied?.parentElement)
            btnMarkCopied.parentElement.style.display = cpy > 0 ? "flex" : "none";
    }

    function makeButton(label, onClick, opts = {}) {
        const b = document.createElement("button");
        b.type = "button";
        if (opts.icon && ICONS[opts.icon]) {
            b.innerHTML = `<span style="display:inline-flex;align-items:center;gap:7px;">${ICONS[opts.icon]}<span>${label}</span></span>`;
        } else {
            b.textContent = label;
        }
        const accent = opts.accent || "rgba(0,224,164,.55)";
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
            b.style.borderLeftColor = danger ? "#f87171" : "rgba(0,224,164,.9)";
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
        panel.id = "bs-filmin-panel";
        panel.style.cssText = `position:fixed;right:${state.pos.right !== undefined ? state.pos.right : 14}px;${topOrBottom}
            z-index:999999;width:${state.min ? 180 : 320}px;border-radius:14px;
            background:rgba(8,12,20,.95);border:1px solid rgba(255,255,255,.09);
            box-shadow:0 12px 40px rgba(0,0,0,.5),0 0 0 1px rgba(0,224,164,.04);
            backdrop-filter:blur(12px);overflow:hidden;
            font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#fff;white-space:pre-line;`;

        // Header
        const header = document.createElement("div");
        header.style.cssText = `display:flex;align-items:center;justify-content:space-between;
            padding:11px 10px 11px 13px;cursor:move;user-select:none;
            background:linear-gradient(105deg,rgba(0,224,164,.18) 0%,rgba(8,12,20,0) 65%);
            border-bottom:1px solid rgba(255,255,255,.07);`;

        const title = document.createElement("div");
        title.style.cssText = "display:flex;align-items:center;gap:8px;";
        title.innerHTML = `
            <span style="width:7px;height:7px;border-radius:50%;background:#00e0a4;
                box-shadow:0 0 8px rgba(0,224,164,.8);flex-shrink:0;display:inline-block;"></span>
            <span style="font-weight:700;font-size:11.5px;letter-spacing:.14em;color:#f1f5f9;">FILMIN</span>`;

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

        statsEl = document.createElement("div");
        statsEl.style.cssText = "margin-bottom:1px;";

        const btnSaveHistory = makeButton("Guardar catálogo (scroll + nuvem)", saveHistory, { icon: "cloud" });
        btnSaveHistory.style.flex = "1";

        const btnCopyFree = makeButton("Copiar links e guardar gratuitos na nuvem", copyFreeLinksToClipboard);
        btnCopyFree.style.flex = "1";

        const rowCopied = document.createElement("div"); rowCopied.style.cssText = "display:flex;gap:7px;";
        const btnMarkCopied  = makeButton("Marcar transferidos", markCopiedAsDownloaded);
        const btnResetCopied = makeButton("Limpar copiados", resetCopiedLinks, { danger: true });
        btnMarkCopied.id  = "btn-mark-copied-filmin";
        btnResetCopied.id = "btn-reset-copied-filmin";
        btnMarkCopied.style.flex  = "1"; btnResetCopied.style.flex = "1";
        rowCopied.append(btnMarkCopied, btnResetCopied);

        const btnManageAPIs = makeButton("Gerir APIs cloud", openApiManagerUI, { accent: "rgba(139,92,246,.7)" });
        btnManageAPIs.style.flex = "1";

        const rowBackup = document.createElement("div"); rowBackup.style.cssText = "display:flex;gap:7px;";
        const btnExport = makeButton("Exportar", exportData, { accent: "rgba(100,116,139,.7)" });
        const btnImport = makeButton("Importar", importData, { accent: "rgba(100,116,139,.7)" });
        btnExport.style.flex = "1"; btnImport.style.flex = "1";
        rowBackup.append(btnExport, btnImport);

        const btnAutoScroll = makeButton("Scroll automático (iniciar)", () => toggleAutoScroll(btnAutoScroll), { accent: "rgba(251,191,36,.6)" });

        const btnDashboard = makeButton("Visualizar dashboard", openDashboardUI, { accent: "rgba(59,130,246,.7)" });
        btnDashboard.style.flex = "1";

        body.append(statsEl, btnSaveHistory, btnCopyFree, rowCopied, btnManageAPIs, rowBackup, btnAutoScroll, btnDashboard);
        panel.append(header, body);
        document.documentElement.appendChild(panel);

        const applyMin = (v) => {
            body.style.display = v ? "none" : "flex";
            minBtn.innerHTML   = v ? svgMax : svgMin;
            setMinimized(v);
            panel.style.width  = v ? "180px" : "320px";
        };
        minBtn.addEventListener("click", (e) => { e.stopPropagation(); applyMin(body.style.display !== "none"); });

        // Drag (rato e toque)
        let dragging = false, startX = 0, startY = 0, startRight = 0, startTop = 0;
        const startDrag = (e) => {
            const cx = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
            const cy = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            dragging = true; startX = cx; startY = cy;
            startRight = parseInt(panel.style.right, 10) || 14;
            startTop   = parseInt(panel.style.top,   10);
            if (isNaN(startTop)) { startTop = panel.offsetTop; panel.style.bottom = 'auto'; }
            if (!e.type.includes('touch')) e.preventDefault();
        };
        const moveDrag = (e) => {
            if (!dragging) return;
            if (e.type.includes('touch')) e.preventDefault();
            const cx = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
            const cy = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            let nr = Math.max(0, Math.min(startRight + (startX - cx), window.innerWidth  - panel.offsetWidth));
            let nt = Math.max(0, Math.min(startTop  + (cy - startY), window.innerHeight - panel.offsetHeight));
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
       CLOUD SYNC
       ===================================================================== */

    // Ofuscação simples da API Key em GM_setValue (não é encriptação forte).
    // Usa TextEncoder/TextDecoder para ser Unicode-safe — nomes com acentos
    // ou emojis já não corrompem o valor armazenado (btoa() falha com chars > Latin1).
    function __obf(str) {
        const key    = "FLM_SEC_KEY_24";
        const bytes  = new TextEncoder().encode(str);
        const kbytes = new TextEncoder().encode(key);
        const out    = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ kbytes[i % kbytes.length];
        let bin = "";
        out.forEach(b => bin += String.fromCharCode(b));
        return btoa(bin);
    }
    function __deobf(b64) {
        try {
            const key    = "FLM_SEC_KEY_24";
            const bin    = atob(b64);
            const bytes  = Uint8Array.from(bin, c => c.charCodeAt(0));
            const kbytes = new TextEncoder().encode(key);
            const out    = new Uint8Array(bytes.length);
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

    /** Carrega dados de todas as APIs cloud em paralelo e despoleta um full sweep */
    async function fetchCloudData() {
        const seq = ++_cloudFetchSeq;
        const configs = getApiConfigs();

        // Buffers locais — só promovidos a globais se não houver fetch mais recente
        const nextCloudSaves       = {};
        const nextCloudFullData    = [];
        const nextCloudExtraFields = [];

        // Fetch em paralelo — com 2+ clouds o tempo total passa de T1+T2 para max(T1,T2)
        await Promise.all(configs.map(async (api) => {
            try {
                const hdrs = api.apiKey ? { "x-api-key": api.apiKey } : undefined;
                const res = await fetch(`${api.url}?keys=${STORE_DOWNLOADED_FREE},${STORE_DOWNLOADED_PAID},${STORE_CATALOG_PAID},${STORE_CATALOG_FREE},${STORE_EXTRA_FIELD}`, { headers: hdrs });
                if (!res.ok) return;
                const data = await res.json();

                const processArray = (arr, listType) => {
                    if (!Array.isArray(arr)) return;
                    arr.forEach(item => {
                        nextCloudFullData.push({ ...item, apiName: api.name, apiColor: getApiColor(api.name, configs), listType });
                        if (!nextCloudSaves[item.url]) nextCloudSaves[item.url] = [];
                        if (!nextCloudSaves[item.url].includes(api.name)) nextCloudSaves[item.url].push(api.name);
                    });
                };

                if (data && typeof data === "object" && !Array.isArray(data)) {
                    processArray(data[STORE_DOWNLOADED_FREE], STORE_DOWNLOADED_FREE);
                    processArray(data[STORE_DOWNLOADED_PAID], STORE_DOWNLOADED_PAID);
                    processArray(data[STORE_CATALOG_PAID],    STORE_CATALOG_PAID);
                    processArray(data[STORE_CATALOG_FREE],    STORE_CATALOG_FREE);
                    if (Array.isArray(data[STORE_EXTRA_FIELD])) nextCloudExtraFields.push(...data[STORE_EXTRA_FIELD]);
                } else if (Array.isArray(data)) { processArray(data, STORE_DOWNLOADED_FREE); }
            } catch (err) { console.error(`Falha no GET para ${api.name}:`, err); }
        }));

        // Descarta resultado se entretanto já começou um fetch mais recente
        if (seq !== _cloudFetchSeq) return;

        cloudSaves       = nextCloudSaves;
        cloudFullData    = nextCloudFullData.sort((a, b) => (b.saved_at || 0) - (a.saved_at || 0));
        cloudExtraFields = nextCloudExtraFields;

        // Full sweep após chegada de dados cloud — necessário para actualizar badges
        highlightSavedLinks();
    }

    async function saveToCloud() {
        const configs = getApiConfigs();
        let apiPushedCount = 0;

        for (const api of configs) {
            if (!api.apiKey) continue;
            try {
                const getRes = await fetch(`${api.url}?keys=${STORE_DOWNLOADED_FREE},${STORE_DOWNLOADED_PAID},${STORE_CATALOG_PAID},${STORE_CATALOG_FREE},${STORE_EXTRA_FIELD}`, { headers: { "x-api-key": api.apiKey } });
                if (!getRes.ok) throw new Error(`GET falhou ${getRes.status}`);
                let cloudData = {};
                try { cloudData = await getRes.json() || {}; } catch { console.warn(`JSON inválido de ${api.name}.`); }

                const payload = {
                    [STORE_DOWNLOADED_FREE]: mergeData([...(cloudData[STORE_DOWNLOADED_FREE] || []), ...getStored(STORE_DOWNLOADED_FREE)]),
                    [STORE_DOWNLOADED_PAID]: mergeData([...(cloudData[STORE_DOWNLOADED_PAID] || []), ...getStored(STORE_DOWNLOADED_PAID)]),
                    [STORE_CATALOG_PAID]:    mergeData([...(cloudData[STORE_CATALOG_PAID]    || []), ...getStored(STORE_CATALOG_PAID)]),
                    [STORE_CATALOG_FREE]:    mergeData([...(cloudData[STORE_CATALOG_FREE]    || []), ...getStored(STORE_CATALOG_FREE)]),
                    [STORE_EXTRA_FIELD]:     mergeDataPreferNewest([...(cloudData[STORE_EXTRA_FIELD] || []), ...getStored(STORE_EXTRA_FIELD)]),
                };

                const res = await fetch(api.url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-api-key": api.apiKey },
                    body: JSON.stringify(payload)
                });
                if (res.ok) apiPushedCount++;
                else toast(`Falha ao sincronizar com ${api.name} (Status: ${res.status})`);
            } catch (err) { console.error(`Falha no POST para ${api.name}:`, err); toast(`Erro de rede ao enviar para ${api.name}`); }
        }

        if (apiPushedCount > 0) { toast("Sincronizado com a Nuvem!"); fetchCloudData(); }
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
                    body: JSON.stringify({ url, keys: [STORE_DOWNLOADED_FREE, STORE_DOWNLOADED_PAID, STORE_CATALOG_PAID, STORE_CATALOG_FREE, STORE_EXTRA_FIELD] })
                });
                if (res.ok) cnt++;
                else toast(`Falha ao remover de ${api.name} (Status: ${res.status})`);
            } catch (err) { console.error(`Falha no DELETE para ${api.name}:`, err); }
        }
        if (cnt > 0) { toast(`Removido de ${cnt} Nuvem(s)!`); fetchCloudData(); }
    }

    /* =====================================================================
       API MANAGER UI
       ===================================================================== */

    function openApiManagerUI() {
        document.getElementById("filmin-cloud-api-mgr")?.remove();

        const esc = (s) => String(s ?? "")
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

        const mod = document.createElement("div");
        mod.id = "filmin-cloud-api-mgr";
        mod.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:20000;
            display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);`;

        const box = document.createElement("div");
        box.style.cssText = `background:#0a0e16;border:1px solid rgba(255,255,255,.09);padding:0;width:680px;max-width:95%;
            border-radius:14px;color:#e2e8f0;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;
            font-family:system-ui,-apple-system,Segoe UI,sans-serif;
            box-shadow:0 24px 60px rgba(0,0,0,.7),0 0 0 1px rgba(0,224,164,.05);`;

        const iSvg = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 7l3 3-3 3"/><path d="M8 13h8"/><rect x="2" y="3" width="20" height="18" rx="2"/>
        </svg>`;

        let editingIdx = -1;

        const inputCSS = `width:100%;padding:9px 12px;background:rgba(255,255,255,.04);color:#e2e8f0;
            border:1px solid rgba(255,255,255,.09);border-radius:8px;box-sizing:border-box;
            font-size:12.5px;font-family:inherit;outline:none;transition:border-color .15s;`;
        const checkCSS = `accent-color:#00e0a4;width:14px;height:14px;cursor:pointer;`;

        const renderList = () => {
            const configs     = getApiConfigs();
            const isEditing   = editingIdx !== -1;
            const editingName = isEditing ? esc(configs[editingIdx]?.name ?? "") : "";

            let listHtml = "";
            if (!configs.length) {
                listHtml = `<div style="padding:20px;text-align:center;color:#64748b;font-size:12px;border:1px dashed rgba(255,255,255,.08);border-radius:10px;">
                    Nenhuma API configurada ainda.
                </div>`;
            } else {
                configs.forEach((api, idx) => {
                    const hasFree     = cloudFullData.some(i => i.apiName === api.name && i.listType === STORE_DOWNLOADED_FREE);
                    const hasDownPaid = cloudFullData.some(i => i.apiName === api.name && i.listType === STORE_DOWNLOADED_PAID);
                    const hasPaid     = cloudFullData.some(i => i.apiName === api.name && i.listType === STORE_CATALOG_PAID);
                    const hasCatalog  = cloudFullData.some(i => i.apiName === api.name && i.listType === STORE_CATALOG_FREE);
                    const safeName    = esc(api.name);
                    const safeColor   = esc(getApiColor(api.name, configs));
                    const actionBtn   = (cls, label, bg, textColor = '#fff') =>
                        `<button data-idx="${idx}" class="${cls}" style="padding:4px 10px;background:${bg};color:${textColor};border:none;border-radius:6px;font-size:11px;cursor:pointer;font-weight:500;">${label}</button>`;
                    listHtml += `
                    <div style="background:rgba(255,255,255,.03);padding:12px 14px;border-radius:10px;margin-bottom:8px;border:1px solid rgba(255,255,255,.06);">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:${api.apiKey ? '10px' : '0'};">
                            <span style="font-size:13px;font-weight:600;color:${safeColor};letter-spacing:.02em;">${safeName}</span>
                            <div style="display:flex;gap:6px;">
                                ${actionBtn("edit-api-btn","Editar","rgba(100,116,139,.3)")}
                                ${actionBtn("del-api-btn","Remover","rgba(220,38,38,.2)","#fca5a5")}
                            </div>
                        </div>
                        ${api.apiKey ? `<div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;padding-top:8px;border-top:1px solid rgba(255,255,255,.05);">
                            <span style="font-size:10px;color:#475569;margin-right:2px;letter-spacing:.06em;text-transform:uppercase;">Gestão:</span>
                            ${actionBtn("restore-api-btn","⬇ Restaurar local","rgba(37,99,235,.25)","#93c5fd")}
                            ${hasFree     ? actionBtn("purge-free-btn","✕ Transf. Grátis","rgba(194,65,12,.25)","#fca5a5") : ''}
                            ${hasDownPaid ? actionBtn("purge-downpaid-btn","✕ Transf. Pagos","rgba(217,119,6,.2)","#fcd34d") : ''}
                            ${hasPaid     ? actionBtn("purge-paid-btn","✕ Hist. Pagos","rgba(147,51,234,.2)","#d8b4fe") : ''}
                            ${hasCatalog  ? actionBtn("purge-catalog-btn","✕ Hist. Grátis","rgba(14,165,233,.2)","#7dd3fc") : ''}
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
            <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:space-between;background:linear-gradient(105deg,rgba(0,224,164,.08),rgba(8,12,20,0));">
                <div style="display:flex;align-items:center;gap:10px;">
                    <span style="width:7px;height:7px;border-radius:50%;background:#00e0a4;box-shadow:0 0 8px rgba(0,224,164,.8);display:inline-block;"></span>
                    <span style="font-size:12.5px;font-weight:700;letter-spacing:.12em;color:#f1f5f9;">APIS CLOUD</span>
                </div>
                <button type="button" id="tutorial-api-btn" style="padding:6px 12px;background:rgba(139,92,246,.2);color:#c4b5fd;border:1px solid rgba(139,92,246,.3);border-radius:7px;font-size:11px;cursor:pointer;font-weight:600;display:flex;align-items:center;gap:5px;">
                    ${iSvg} Passo-a-Passo
                </button>
            </div>

            <!-- Scroll body -->
            <div style="overflow-y:auto;padding:16px 20px;flex:1;">
                <p style="font-size:11.5px;color:#475569;margin:0 0 14px;line-height:1.5;">
                    Adiciona URLs das tuas Worker APIs. Fornece API Key apenas se for a tua base de dados (write access).
                </p>
                <div id="api-list-wrapper" style="margin-bottom:14px;">${listHtml}</div>

                <!-- Add / Edit form -->
                <div style="background:rgba(255,255,255,.025);padding:14px;border-radius:10px;border:1px solid rgba(255,255,255,.06);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                        <span style="font-size:11.5px;font-weight:600;color:#94a3b8;letter-spacing:.08em;text-transform:uppercase;">${isEditing ? `Editar: ${editingName}` : 'Nova API'}</span>
                        ${isEditing ? `<span id="cancel-edit-btn" style="color:#475569;cursor:pointer;font-size:11px;">Cancelar</span>` : ''}
                    </div>
                    <input id="new-api-name" placeholder="Nome (ex: Eu, João)" style="${inputCSS}margin-bottom:8px;">
                    <input id="new-api-url"  placeholder="URL (ex: https://api.exemplo.workers.dev)" style="${inputCSS}margin-bottom:8px;">
                    <div style="display:flex;gap:6px;margin-bottom:12px;align-items:stretch;">
                        <input type="password" id="new-api-key" placeholder="API Key Secreta (opcional — write access)" style="${inputCSS}margin-bottom:0;flex:1;">
                        <button type="button" id="filmin-api-gen-key" title="Gerar chave aleatória segura"
                            style="padding:0 12px;background:rgba(0,224,164,.15);color:#6ee7b7;border:1px solid rgba(0,224,164,.3);border-radius:8px;cursor:pointer;font-size:11px;font-weight:600;white-space:nowrap;font-family:inherit;">✦ Gerar</button>
                    </div>
                    <label style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:#64748b;margin-bottom:8px;cursor:pointer;">
                        <input type="checkbox" id="new-api-exclude" style="${checkCSS}">Não copiar transferidos desta nuvem
                    </label>
                    <label style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:#64748b;margin-bottom:14px;cursor:pointer;">
                        <input type="checkbox" id="new-api-exclude-hide" style="${checkCSS}">Não esconder filmes desta nuvem ao ocultar
                    </label>
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <button id="close-api-btn"  style="padding:8px 14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);color:#94a3b8;border-radius:8px;cursor:pointer;font-size:12px;">Fechar</button>
                        <button id="save-api-btn"   style="padding:8px 18px;background:${isEditing ? 'rgba(16,185,129,.2)' : 'rgba(37,99,235,.25)'};color:${isEditing ? '#6ee7b7' : '#93c5fd'};border:1px solid ${isEditing ? 'rgba(16,185,129,.35)' : 'rgba(37,99,235,.35)'};border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;">${isEditing ? 'Atualizar API' : '+ Guardar API'}</button>
                    </div>
                </div>
            </div>`;

            // Generate random secure API key
            const genBtn = box.querySelector("#filmin-api-gen-key");
            if (genBtn) {
                genBtn.onclick = () => {
                    const arr = new Uint8Array(24);
                    crypto.getRandomValues(arr);
                    const key = Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
                    const inp = box.querySelector("#new-api-key");
                    inp.value = key; inp.type = "text";
                    setTimeout(() => { inp.type = "password"; }, 3000);
                    toast("Chave gerada — copie e guarde no Cloudflare.");
                };
            }

            // Focus styles on inputs
            box.querySelectorAll("input[id^='new-api']").forEach(inp => {
                inp.addEventListener("focus",  () => inp.style.borderColor = "rgba(0,224,164,.5)");
                inp.addEventListener("blur",   () => inp.style.borderColor = "rgba(255,255,255,.09)");
            });

            if (isEditing) {
                const api = configs[editingIdx];
                box.querySelector("#new-api-name").value           = api.name;
                box.querySelector("#new-api-url").value            = api.url;
                box.querySelector("#new-api-key").value            = api.apiKey || "";
                box.querySelector("#new-api-exclude").checked      = !!api.excludeFromCopy;
                box.querySelector("#new-api-exclude-hide").checked = !!api.excludeFromHide;
                box.querySelector("#cancel-edit-btn").onclick      = () => { editingIdx = -1; renderList(); };
            }

            box.querySelectorAll(".del-api-btn").forEach(btn => {
                btn.onclick = () => {
                    const i = parseInt(btn.getAttribute("data-idx"), 10);
                    configs.splice(i, 1);
                    if (editingIdx === i) editingIdx = -1;
                    else if (editingIdx > i) editingIdx--;
                    setApiConfigs(configs); renderList(); fetchCloudData();
                };
            });
            box.querySelectorAll(".edit-api-btn").forEach(btn => {
                btn.onclick = () => { editingIdx = parseInt(btn.getAttribute("data-idx"), 10); renderList(); };
            });

            const setupPurge = (sel, name, payload) => {
                box.querySelectorAll(sel).forEach(btn => {
                    btn.onclick = async () => {
                        const i = parseInt(btn.getAttribute("data-idx"), 10);
                        const api = configs[i];
                        if (!confirm(`⚠️ Apagar ${name} no servidor de ${api.name}?`)) return;
                        const res = await fetch(api.url, {
                            method: "DELETE",
                            headers: { "Content-Type": "application/json", "x-api-key": api.apiKey },
                            body: JSON.stringify(payload)
                        });
                        if (res.ok) { alert(`Nuvem de ${api.name} (${name}) limpa!`); btn.style.display = 'none'; fetchCloudData(); }
                        else alert(`Falha ao limpar ${api.name}.`);
                    };
                });
            };
            setupPurge(".purge-free-btn",     "TRANSF. GRATUITAS",   { purgeKey: STORE_DOWNLOADED_FREE });
            setupPurge(".purge-downpaid-btn", "TRANSF. PAGAS",        { purgeKey: STORE_DOWNLOADED_PAID });
            setupPurge(".purge-paid-btn",     "HISTÓRICO PAGAS",      { purgeKey: STORE_CATALOG_PAID });
            setupPurge(".purge-catalog-btn",  "HISTÓRICO GRATUITAS",  { purgeKey: STORE_CATALOG_FREE });

            box.querySelectorAll(".restore-api-btn").forEach(btn => {
                btn.onclick = async () => {
                    const i = parseInt(btn.getAttribute("data-idx"), 10);
                    const api = configs[i];
                    if (!confirm(`Restaurar LOCAL com dados do servidor ${api.name}? Sobrescreve o Local Storage atual.`)) return;
                    const restoreHdrs = api.apiKey ? { "x-api-key": api.apiKey } : undefined;
                    const res = await fetch(`${api.url}?keys=${STORE_DOWNLOADED_FREE},${STORE_DOWNLOADED_PAID},${STORE_CATALOG_PAID},${STORE_CATALOG_FREE}`, { headers: restoreHdrs });
                    if (!res.ok) { alert(`Falha: ${res.status}`); return; }
                    const data = await res.json();
                    if (data && typeof data === 'object' && !Array.isArray(data)) {
                        setStored(STORE_DOWNLOADED_FREE, data[STORE_DOWNLOADED_FREE] || []);
                        setStored(STORE_DOWNLOADED_PAID, data[STORE_DOWNLOADED_PAID] || []);
                        setStored(STORE_CATALOG_PAID,    data[STORE_CATALOG_PAID]    || []);
                        setStored(STORE_CATALOG_FREE,    data[STORE_CATALOG_FREE]    || []);
                        toast(`Restauro concluído via ${api.name}.`);
                        updateStats(); highlightSavedLinks(); mod.remove();
                    } else { alert("Formato de dados inválido."); }
                };
            });

            box.querySelector("#close-api-btn").onclick  = () => mod.remove();
            box.querySelector("#save-api-btn").onclick   = () => {
                const n   = box.querySelector("#new-api-name").value.trim();
                let u     = box.querySelector("#new-api-url").value.trim();
                const k   = box.querySelector("#new-api-key").value.trim();
                const exc = box.querySelector("#new-api-exclude").checked;
                const excH= box.querySelector("#new-api-exclude-hide").checked;
                if (!n || !u) return alert("O Nome e o URL são obrigatórios.");
                if (!u.startsWith("http")) return alert("URL deve começar por http:// ou https://");
                if (k) {
                    const existPrimary = configs.findIndex(c => c.apiKey);
                    if (existPrimary !== -1 && existPrimary !== editingIdx)
                        return alert("Apenas podes ter UMA Nuvem com API Key.");
                }
                if (u.endsWith('/')) u = u.slice(0, -1);
                if (editingIdx !== -1) {
                    configs[editingIdx] = { name: n, url: u, apiKey: k || null, excludeFromCopy: exc, excludeFromHide: excH };
                    editingIdx = -1;
                } else {
                    configs.push({ name: n, url: u, apiKey: k || null, excludeFromCopy: exc, excludeFromHide: excH });
                }
                setApiConfigs(configs); renderList(); fetchCloudData();
            };

            box.querySelector("#tutorial-api-btn").onclick = openWorkerTutorialUI;
        };

        renderList();
        mod.appendChild(box);
        document.body.appendChild(mod);
    }

    /* =====================================================================
       DASHBOARD (Vue 3)
       ===================================================================== */

    async function openDashboardUI() {
        document.getElementById("filmin-dashboard")?.remove();

        try {
            if (!unsafeWindow.Vue) {
                await new Promise((resolve, reject) => {
                    const s = document.createElement('script');
                    s.src     = 'https://unpkg.com/vue@3/dist/vue.global.js';
                    s.onload  = resolve;
                    s.onerror = () => reject(new Error('Failed to load Vue.js'));
                    document.head.appendChild(s);
                });
            }
        } catch {
            toast("Falha ao carregar Vue CDN. Tenta mais tarde.");
            return;
        }
        const VueLib = unsafeWindow.Vue;

        const localFreeCount     = getStored(STORE_DOWNLOADED_FREE).length;
        const localDownPaidCount = getStored(STORE_DOWNLOADED_PAID).length;
        const localPaidCount     = getStored(STORE_CATALOG_PAID).length;
        const localCopiedCount   = getStored(STORE_DOWNLOAD_COPY_FREE).length;
        const localCatFreeCount  = getStored(STORE_CATALOG_FREE).length;

        const notesMap = new Map();
        // mergeDataPreferNewest garante que uma nota editada recentemente
        // não perde para uma versão antiga vinda de outra cloud
        mergeDataPreferNewest([...cloudExtraFields, ...getStored(STORE_EXTRA_FIELD)]).forEach(i => {
            if (i.filmin_extra_field) notesMap.set(i.url, i.filmin_extra_field);
        });

        // Agrega todas as fontes (cloud + local) num mapa por URL
        const allItemsMap = new Map();
        const addOrUpdate = (item, sourceName, sourceColor, isCloud, explicitType = null) => {
            if (!allItemsMap.has(item.url)) {
                allItemsMap.set(item.url, {
                    ...item, sources: [], cloudDownloaded: {}, cloudHistory: {},
                    isLocalDownloaded: false, isLocalHistory: false, isLocal: false, isPaid: false, isCopied: false
                });
            }
            const r          = allItemsMap.get(item.url);
            const activeType = item.listType || explicitType;
            if (activeType === STORE_CATALOG_PAID || activeType === STORE_DOWNLOADED_PAID) r.isPaid = true;
            const isDl   = activeType === STORE_DOWNLOADED_FREE || activeType === STORE_DOWNLOADED_PAID;
            const isCopy = activeType === STORE_DOWNLOAD_COPY_FREE;
            const isHist = activeType === STORE_CATALOG_FREE || activeType === STORE_CATALOG_PAID;
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
                r.mediaType = r.url.includes("/filme/") ? "Filme" : r.url.includes("/serie/") ? "Série" : r.url.includes("/curta/") ? "Curta" : "Vídeo";
            }
            if (r.mediaType === "Série") r.filmin_extra_field = notesMap.get(r.url) || "";
        };

        cloudFullData.forEach(item => addOrUpdate(item, item.apiName, item.apiColor, true));
        getStored(STORE_DOWNLOADED_FREE).forEach(item    => addOrUpdate(item, "Local", null, false, STORE_DOWNLOADED_FREE));
        getStored(STORE_DOWNLOADED_PAID).forEach(item    => addOrUpdate(item, "Local", null, false, STORE_DOWNLOADED_PAID));
        getStored(STORE_CATALOG_PAID).forEach(item       => addOrUpdate(item, "Local", null, false, STORE_CATALOG_PAID));
        getStored(STORE_DOWNLOAD_COPY_FREE).forEach(item => addOrUpdate(item, "Local", null, false, STORE_DOWNLOAD_COPY_FREE));
        getStored(STORE_CATALOG_FREE).forEach(item       => addOrUpdate(item, "Local", null, false, STORE_CATALOG_FREE));

        const allDashboardData = Array.from(allItemsMap.values()).sort((a, b) => (b.saved_at || 0) - (a.saved_at || 0));
        const dashDirtyRe      = /\s*(-\s*Filmin|ver online\s+(em|en)\s+Filmin)[\s\S]*/i;
        const completeItems    = allDashboardData.filter(i => i.title && i.poster && !dashDirtyRe.test(i.title));
        const pendingItemsData = allDashboardData.filter(i => !i.title || !i.poster || dashDirtyRe.test(i.title));

        if (pendingItemsData.length > 0) setTimeout(() => scrapeMissingMetadataInBackground(pendingItemsData), 800);

        const configs          = getApiConfigs();
        const uniqueCloudsArr  = [...new Set(configs.map(c => c.name))];
        const cloudStatsData   = uniqueCloudsArr.map(cn => ({
            name: cn, color: getApiColor(cn, configs),
            hasKey:   !!configs.find(c => c.name === cn)?.apiKey,
            downFree: cloudFullData.filter(i => i.apiName === cn && i.listType === STORE_DOWNLOADED_FREE).length,
            downPaid: cloudFullData.filter(i => i.apiName === cn && i.listType === STORE_DOWNLOADED_PAID).length,
            catFree:  cloudFullData.filter(i => i.apiName === cn && i.listType === STORE_CATALOG_FREE).length,
            catPaid:  cloudFullData.filter(i => i.apiName === cn && i.listType === STORE_CATALOG_PAID).length,
        }));

        const mod = document.createElement("div");
        mod.id = "filmin-dashboard";
        mod.style.cssText = "position:fixed;inset:0;background:#060c18;z-index:2000000;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:32px 40px;overflow-y:auto;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#e2e8f0;";

        // Estilos responsivos para a grelha — media queries não funcionam em inline style
        const gridCss = document.createElement("style");
        gridCss.textContent = `
            .filmin-grid { display:grid; gap:16px; width:100%; margin-bottom:20px; }
            .filmin-grid-card   { grid-template-columns: repeat(4, minmax(0, 1fr)); }
            .filmin-grid-poster { grid-template-columns: repeat(4, minmax(0, 1fr)); }
            @media (max-width: 900px) { .filmin-grid-poster { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; } .filmin-grid-card { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; } }
            @media (max-width: 720px)  { .filmin-grid-poster { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } .filmin-grid-card { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } }
            .filmin-input { background:rgba(255,255,255,.05) !important; border:1px solid rgba(255,255,255,.10) !important;
                color:#e2e8f0 !important; padding:9px 13px !important; border-radius:8px !important;
                outline:none; transition:border-color .15s; font-size:13px;
                color-scheme:dark; }
            .filmin-input:focus { border-color:rgba(0,224,164,.5) !important; }
            .filmin-input option { background:#0f172a !important; color:#e2e8f0 !important; }
            .filmin-btn { border:none;padding:9px 16px;border-radius:8px;cursor:pointer;font-weight:600;font-size:12.5px;
                transition:opacity .15s,transform .1s; }
            .filmin-btn:hover { opacity:.85; transform:translateY(-1px); }
            .filmin-btn:active { transform:translateY(0); }
        `;
        mod.appendChild(gridCss);
        const mountEl = document.createElement("div");
        mountEl.id = "filmin-vue-app";
        mod.appendChild(mountEl);
        document.body.appendChild(mod);

        // Rastreia objectURLs criados pelo dashboard para revogar ao fechar
        // blob URLs geridos centralmente por _objUrls + revokeAllObjectURLs()

        const { createApp, ref, computed } = VueLib;
        const dashboardData = ref(completeItems);
        const pendingItems  = ref(pendingItemsData);

        const app = createApp({
            template: `
<div style="width:100%;max-width:1280px;">

  <!-- Header -->
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:28px;padding-bottom:18px;border-bottom:1px solid rgba(255,255,255,.08);">
    <div style="display:flex;align-items:center;gap:12px;">
      <span style="width:9px;height:9px;border-radius:50%;background:#00e0a4;box-shadow:0 0 10px rgba(0,224,164,.9);display:inline-block;"></span>
      <span style="font-size:15px;font-weight:700;letter-spacing:.12em;color:#f1f5f9;">FILMIN</span>
      <span style="font-size:11px;color:#94a3b8;letter-spacing:.06em;font-weight:500;">DASHBOARD</span>
    </div>
    <button @click="close" class="filmin-btn" style="background:rgba(220,38,38,.15);color:#f87171;border:1px solid rgba(220,38,38,.3);">Fechar</button>
  </div>

  <!-- Scraping progress -->
  <div v-if="pendingItems.length > 0" style="background:rgba(234,179,8,.08);color:#fbbf24;padding:12px 16px;border-radius:10px;margin-bottom:24px;font-size:13px;font-weight:500;border:1px solid rgba(234,179,8,.2);">
    <span v-if="scrapeTotal > 0">A processar {{ scrapeCurrent }} de {{ scrapeTotal }} itens...</span>
    <span v-else>A preparar processamento de {{ pendingItems.length }} itens...</span>
  </div>

  <!-- Stat cards (5 colunas) -->
  <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;width:100%;margin-bottom:14px;">
    <div v-for="(v,l) in statCards" :key="l"
         style="background:rgba(255,255,255,.03);padding:14px 16px;border-radius:12px;border:1px solid rgba(255,255,255,.07);display:flex;align-items:center;gap:10px;">
      <div :style="{background:v.color+'1a',borderColor:v.color+'44'}" style="width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;border:1px solid;flex-shrink:0;">{{ v.icon }}</div>
      <div>
        <div :style="{color:v.color}" style="font-size:22px;font-weight:700;line-height:1;">{{ v.count }}</div>
        <div style="font-size:10px;color:#94a3b8;margin-top:2px;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;">{{ l }}</div>
      </div>
    </div>
  </div>

  <!-- Cloud cards -->
  <div v-if="st.cloudStats.length" style="display:flex;gap:12px;width:100%;margin-bottom:20px;flex-wrap:wrap;">
    <div v-for="c in st.cloudStats" :key="c.name"
         :style="{borderColor:c.color+'44'}"
         style="background:rgba(255,255,255,.02);padding:14px 18px;border-radius:12px;border:1px solid;min-width:220px;flex:1;">
      <div :style="{color:c.color}" style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-bottom:10px;">☁ {{ c.name }}</div>
      <div style="display:flex;justify-content:space-between;margin-bottom:5px;"><span style="font-size:12px;color:#64748b;">Transf. Grátis</span><span style="font-size:13px;font-weight:600;color:#10b981;">{{ c.downFree }}</span></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:5px;"><span style="font-size:12px;color:#64748b;">Transf. Pagos</span><span style="font-size:13px;font-weight:600;color:#f59e0b;">{{ c.downPaid }}</span></div>
      <template v-if="c.hasKey">
        <div style="display:flex;justify-content:space-between;margin-bottom:5px;"><span style="font-size:12px;color:#64748b;">Hist. Grátis</span><span style="font-size:13px;font-weight:600;color:#0ea5e9;">{{ c.catFree }}</span></div>
        <div style="display:flex;justify-content:space-between;"><span style="font-size:12px;color:#64748b;">Hist. Pagos</span><span style="font-size:13px;font-weight:600;color:#9333ea;">{{ c.catPaid }}</span></div>
      </template>
    </div>
  </div>

  <!-- Toolbar -->
  <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:12px 12px 0 0;padding:12px 14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
    <input type="text" v-model="searchName" placeholder="Pesquisar título..." class="filmin-input" style="flex:1;min-width:150px;">
    <select v-model="filterPaid"   class="filmin-input" style="min-width:140px;cursor:pointer;">
      <option value="all">Pagos e gratuitos</option>
      <option value="paid">Apenas pagos</option>
      <option value="free">Apenas gratuitos</option>
    </select>
    <select v-model="filterStatus" class="filmin-input" style="min-width:140px;cursor:pointer;">
      <option value="all">Todos os estados</option>
      <option value="downloaded">Transferidos</option>
      <option value="history">Histórico</option>
      <option value="copied">Copiados</option>
    </select>
    <select v-model="filterType"   class="filmin-input" style="min-width:110px;cursor:pointer;">
      <option value="all">Todos os tipos</option>
      <option value="Filme">Filmes</option>
      <option value="Série">Séries</option>
      <option value="Curta">Curtas</option>
    </select>
    <select v-model="filterCloud"  class="filmin-input" style="min-width:130px;cursor:pointer;">
      <option value="all">Todas as origens</option>
      <option value="local">Apenas local</option>
      <option v-for="c in st.uniqueClouds" :key="c" :value="c">☁ {{ c }}</option>
    </select>
  </div>
  <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-top:1px solid rgba(255,255,255,.04);border-radius:0 0 12px 12px;padding:10px 14px;margin-bottom:20px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
    <button @click="toggleView"     class="filmin-btn" style="background:rgba(59,130,246,.15);color:#93c5fd;border:1px solid rgba(59,130,246,.25);">Alternar formato</button>
    <button @click="exportFiltered" class="filmin-btn" style="background:rgba(16,185,129,.15);color:#6ee7b7;border:1px solid rgba(16,185,129,.25);">Exportar atuais</button>
    <div style="display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap;">
      <input type="date" v-model="dateStart" class="filmin-input" style="cursor:pointer;">
      <span style="font-size:11px;color:#94a3b8;">até</span>
      <input type="date" v-model="dateEnd"   class="filmin-input" style="cursor:pointer;">
    </div>
  </div>

  <!-- Grid -->
  <div v-if="filtered.length===0" style="padding:48px;text-align:center;color:#64748b;background:rgba(255,255,255,.02);border:1px dashed rgba(255,255,255,.08);border-radius:12px;">Nenhum ficheiro correspondente.</div>
  <div v-else>
    <div style="text-align:center;margin-bottom:14px;font-size:12px;color:#94a3b8;letter-spacing:.04em;">A mostrar {{ displayed.length }} de {{ filtered.length }} resultados</div>
    <div :class="['filmin-grid', viewMode === 'poster' ? 'filmin-grid-poster' : 'filmin-grid-card']">
    <div v-for="item in displayed" :key="item.url" :style="cardStyle(item)" @mouseenter="cardHover($event,true)" @mouseleave="cardHover($event,false)">
      <div :style="{aspectRatio:ar}" style="display:block;position:relative;overflow:hidden;background:#000;border-radius:8px 8px 0 0;">
        <a :href="item.url" target="_blank" style="display:block;width:100%;height:100%;">
          <img :src="posterSrc(item)" @error="posterErr($event,item)" alt="Poster" loading="lazy"
               :style="{opacity:isSaved(item)?0.3:1}" style="width:100%;height:100%;object-fit:cover;transition:opacity .2s;"
               @mouseenter="$event.target.style.opacity=1"
               @mouseleave="$event.target.style.opacity=isSaved(item)?0.3:1">
        </a>
        <div style="position:absolute;top:8px;left:8px;display:flex;flex-wrap:wrap;width:86%;pointer-events:none;">
          <span v-for="src in item.sources" :key="src.name" :style="{color:src.color,borderStyle:item.cloudDownloaded[src.name]?'solid':'dashed'}"
                style="background:rgba(0,0,0,.88);padding:2px 6px;border-radius:4px;font-size:9.5px;margin-right:4px;margin-bottom:4px;border-width:1px;border-color:rgba(255,255,255,.15);font-weight:600;letter-spacing:.04em;">
            {{ badgeIcons(item,src.name) }} {{ src.name }}
          </span>
          <span v-if="item.isLocal" style="background:rgba(0,0,0,.88);color:#10b981;padding:2px 6px;border-radius:4px;font-size:9.5px;margin-right:4px;margin-bottom:4px;border:1px solid rgba(16,185,129,.3);font-weight:600;">Local</span>
        </div>
        <div :style="{background:typeColor(item.mediaType)+'cc'}" style="position:absolute;bottom:8px;right:8px;color:#fff;padding:2px 7px;border-radius:4px;font-size:9.5px;font-weight:700;pointer-events:none;letter-spacing:.05em;">{{ item.mediaType }}</div>
        <div v-if="item.mediaType==='Série'" @click.stop.prevent="openNoteModal(item)"
             style="position:absolute;top:8px;right:8px;background:rgba(15,23,42,.9);color:#fff;padding:5px;border-radius:50%;font-size:12px;cursor:pointer;border:1px solid rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;width:26px;height:26px;z-index:20;"
             @mouseenter="hoverNote=item.url" @mouseleave="hoverNote=null">
          <span>{{ item.filmin_extra_field ? '📝' : '＋' }}</span>
          <div v-if="hoverNote===item.url && item.filmin_extra_field"
               style="position:absolute;top:32px;right:0;background:rgba(6,12,24,.98);color:#e2e8f0;padding:10px 14px;border-radius:8px;font-size:12px;width:max-content;max-width:240px;white-space:pre-wrap;border:1px solid rgba(0,224,164,.3);z-index:100;pointer-events:none;">{{ item.filmin_extra_field }}</div>
        </div>
        <div @click.prevent="copyPoster(item)"
             style="position:absolute;bottom:8px;right:52px;background:rgba(0,0,0,.7);color:#94a3b8;padding:4px 7px;border-radius:5px;font-size:10px;cursor:pointer;border:1px solid rgba(255,255,255,.1);"
             title="Copiar URL do Poster">📋</div>
      </div>
      <div style="padding:10px 12px;display:flex;flex-direction:column;flex-grow:1;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:4px;">
          <a :href="item.url" target="_blank" style="flex-grow:1;color:#e2e8f0;text-decoration:none;font-weight:600;font-size:12.5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;"
             @mouseenter="$event.target.style.color='#00e0a4'" @mouseleave="$event.target.style.color='#e2e8f0'">{{ item.title||'Sem Título' }}</a>
          <div v-if="hasWriteAccess(item)" style="display:flex;gap:2px;flex-shrink:0;">
            <button @click.prevent="openEditModal(item)" style="background:transparent;color:#475569;border:none;border-radius:4px;padding:3px;cursor:pointer;font-size:12px;" @mouseenter="$event.target.style.color='#e2e8f0'" @mouseleave="$event.target.style.color='#475569'" title="Editar">✏️</button>
            <button @click.prevent="deleteItem(item)"   style="background:transparent;color:#475569;border:none;border-radius:4px;padding:3px;cursor:pointer;font-size:12px;" @mouseenter="$event.target.style.color='#ef4444'" @mouseleave="$event.target.style.color='#475569'" title="Eliminar">🗑️</button>
          </div>
        </div>
        <div style="font-size:10.5px;color:#64748b;margin-top:auto;padding-top:7px;border-top:1px solid rgba(255,255,255,.05);display:flex;align-items:center;justify-content:space-between;">
          <span>{{ fmtDate(item.saved_at) }}</span>
          <span v-if="item.year" style="background:rgba(255,255,255,.06);color:#64748b;padding:1px 6px;border-radius:4px;font-size:10px;">{{ item.year }}</span>
        </div>
      </div>
    </div>
    </div>
    <div ref="sentinel" style="height:1px;"></div>
    <div v-if="displayed.length < filtered.length" style="text-align:center;padding:24px;color:#64748b;font-size:12px;">A carregar mais...</div>
    <div v-else-if="filtered.length > 0" style="text-align:center;padding:24px;color:#64748b;font-size:12px;">{{ filtered.length }} itens carregados</div>
  </div>

  <!-- Modal de edição de item -->
  <div v-if="editingItem" style="position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);">
    <div style="background:#0f172a;padding:28px;border-radius:14px;width:90%;max-width:500px;border:1px solid rgba(255,255,255,.1);">
      <h2 style="margin-top:0;margin-bottom:20px;font-size:16px;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:12px;color:#f1f5f9;">Editar Item</h2>
      <div style="margin-bottom:12px;"><label style="display:block;margin-bottom:6px;font-size:12px;color:#64748b;letter-spacing:.06em;text-transform:uppercase;">Título</label>
        <input type="text" v-model="editingItem.title" class="filmin-input" style="width:100%;box-sizing:border-box;"></div>
      <div style="margin-bottom:12px;"><label style="display:block;margin-bottom:6px;font-size:12px;color:#64748b;letter-spacing:.06em;text-transform:uppercase;">Poster URL</label>
        <input type="text" v-model="editingItem.poster" class="filmin-input" style="width:100%;box-sizing:border-box;"></div>
      <div style="margin-bottom:22px;"><label style="display:block;margin-bottom:6px;font-size:12px;color:#64748b;letter-spacing:.06em;text-transform:uppercase;">Ano</label>
        <input type="text" v-model="editingItem.year" class="filmin-input" style="width:100%;box-sizing:border-box;"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button @click="editingItem=null" class="filmin-btn" style="background:rgba(255,255,255,.06);color:#94a3b8;border:1px solid rgba(255,255,255,.1);">Cancelar</button>
        <button @click="saveEdit"         class="filmin-btn" style="background:rgba(16,185,129,.15);color:#6ee7b7;border:1px solid rgba(16,185,129,.25);">Guardar</button>
      </div>
    </div>
  </div>

  <!-- Modal de nota de série -->
  <div v-if="editingNoteItem" style="position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);">
    <div style="background:#0f172a;padding:28px;border-radius:14px;width:90%;max-width:400px;border:1px solid rgba(255,255,255,.1);">
      <h2 style="margin-top:0;margin-bottom:20px;font-size:16px;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:12px;color:#f1f5f9;">Nota da Série</h2>
      <div style="margin-bottom:20px;"><label style="display:block;margin-bottom:6px;font-size:12px;color:#64748b;letter-spacing:.06em;text-transform:uppercase;">Estado / Eps em falta</label>
        <textarea v-model="editingNoteItem.filmin_extra_field" rows="4" class="filmin-input" style="width:100%;box-sizing:border-box;resize:vertical;" placeholder="Ex: Parei no T1 Ep5..."></textarea></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button @click="editingNoteItem=null" class="filmin-btn" style="background:rgba(255,255,255,.06);color:#94a3b8;border:1px solid rgba(255,255,255,.1);">Cancelar</button>
        <button @click="saveNoteEdit"         class="filmin-btn" style="background:rgba(16,185,129,.15);color:#6ee7b7;border:1px solid rgba(16,185,129,.25);">Guardar</button>
      </div>
    </div>
  </div>
</div>`,
            setup() {
                const BATCH       = 50;
                const sentinel    = ref(null);
                const searchName  = ref("");
                const filterPaid  = ref("all");
                const filterType  = ref("all");
                const filterCloud = ref("all");
                const filterStatus = ref("all");
                const dateStart   = ref("");
                const dateEnd     = ref("");
                const viewMode    = ref(safeLSGet(STORE_DASH_VIEW_MODE, 'card') || 'card');
                const imageCache  = ref({});
                const scrapeCurrent = ref(0);
                const scrapeTotal   = ref(0);
                const editingItem     = ref(null);
                const editingNoteItem = ref(null);
                const hoverNote = ref(null);

                const st = {
                    localFreeCount, localDownPaidCount, localCopiedCount, localCatFreeCount, localPaidCount,
                    cloudStats: cloudStatsData, uniqueClouds: uniqueCloudsArr
                };

                const statCards = {
                    'Transf. Grátis':  { count: localFreeCount,     color: '#10b981', icon: '✓' },
                    'Transf. Pagos':   { count: localDownPaidCount,  color: '#f59e0b', icon: '★' },
                    'Copiados Temp':   { count: localCopiedCount,    color: '#fbbf24', icon: '⋯' },
                    'Hist. Grátis':    { count: localCatFreeCount,   color: '#0ea5e9', icon: '🔖' },
                    'Hist. Pagos':     { count: localPaidCount,      color: '#9333ea', icon: '♦' },
                };

                const ar = computed(() => viewMode.value === 'poster' ? '2/3' : '16/9');

                const filtered = computed(() => {
                    const q  = searchName.value.toLowerCase();
                    const ds = dateStart.value ? new Date(dateStart.value).getTime() : 0;
                    const de = dateEnd.value   ? new Date(dateEnd.value).getTime() + 86400000 : Infinity;
                    return dashboardData.value.filter(item => {
                        if (q && !(item.title || '').toLowerCase().includes(q)) return false;
                        if (filterPaid.value === "paid" && !item.isPaid) return false;
                        if (filterPaid.value === "free" && item.isPaid)  return false;
                        if (filterType.value !== "all" && item.mediaType !== filterType.value) return false;
                        const cloud = filterCloud.value, status = filterStatus.value;
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

                VueLib.watch([searchName, filterPaid, filterStatus, filterType, filterCloud, dateStart, dateEnd], () => { displayCount.value = BATCH; });
                VueLib.onMounted(() => {
                    if (!sentinel.value) return;
                    const obs = new IntersectionObserver(entries => {
                        if (entries[0].isIntersecting) loadMore();
                    }, { root: mod, rootMargin: '200px' });
                    obs.observe(sentinel.value);
                });

                const toggleView    = () => { viewMode.value = viewMode.value === 'card' ? 'poster' : 'card'; safeLSSet(STORE_DASH_VIEW_MODE, viewMode.value); };
                const close         = () => { delete window._filminDashUpdateItem; delete window._filminDashScrapeProgress; revokeAllObjectURLs(); mod.remove(); };
                const isSaved       = (item) => item.isLocalDownloaded || Object.keys(item.cloudDownloaded).length > 0;
                const badgeIcons    = (item, srcName) => { let i = ''; if (item.cloudDownloaded[srcName]) i += ICONS.download; if (item.cloudHistory[srcName]) i += ICONS.history; return i || ICONS.cloud; };
                const cardStyle     = (item) => {
                    let bs = 'none';
                    if (item.isLocalDownloaded)                        bs = '0 0 0 3px #10b981';
                    else if (Object.keys(item.cloudDownloaded).length) bs = `0 0 0 3px ${getApiColor(Object.keys(item.cloudDownloaded)[0], configs)}`;
                    return { boxShadow: bs, background: '#111', border: '1px solid #2a2a2a', borderRadius: '10px', overflow: 'hidden', display: 'flex', flexDirection: 'column', transition: 'transform 0.2s' };
                };
                const cardHover     = (ev, enter) => { ev.currentTarget.style.transform = enter ? 'scale(1.02)' : 'scale(1)'; ev.currentTarget.style.borderColor = enter ? '#555' : '#2a2a2a'; };
                const typeColor     = (mt) => mt === "Série" ? "#3b82f6" : mt === "Curta" ? "#eab308" : mt === "Filme" ? "#ec4899" : "#8b5cf6";

                const posterSrc = (item) => {
                    const rawUrl = item.poster || 'https://placehold.co/280x400?text=Sem+Capa';
                    let safe = rawUrl;
                    if (viewMode.value === 'poster' && safe.includes('/card_')) {
                        const m = safe.match(/\/media\/(\d+)\//);
                        if (m) safe = `https://static.filmin.pt/images/pt/media/${m[1]}/1/poster_0_3.png`;
                    } else if (viewMode.value === 'card') {
                        if (/\/[135]\/poster_/.test(safe)) {
                            const m = safe.match(/\/media\/(\d+)\//);
                            if (m) safe = `https://static.filmin.pt/images/pt/media/${m[1]}/4/card_0_3_0x0.png`;
                        }
                    }
                    if (imageCache.value[safe]) return imageCache.value[safe];
                    imageCache.value[safe] = 'https://placehold.co/280x400?text=...';
                    getCachedImageURL(safe).then(url => { imageCache.value[safe] = url; });
                    return imageCache.value[safe];
                };

                const posterErr = (ev, item) => {
                    const img  = ev.target;
                    const safe = item.poster || '';
                    if (viewMode.value === 'poster') {
                        const m = safe.match(/\/media\/(\d+)\//);
                        if (m) {
                            const mid   = m[1];
                            const chain = [
                                `https://static.filmin.pt/images/pt/media/${mid}/1/poster_0_3.jpg`,
                                `https://static.filmin.pt/images/pt/media/${mid}/1/poster_0_3.png`,
                                `https://static.filmin.pt/images/pt/media/${mid}/3/poster_0_3.png`,
                                `https://static.filmin.pt/images/pt/media/${mid}/3/poster_0_3.jpg`,
                                safe
                            ];
                            if (!img._fbIdx) img._fbIdx = 0;
                            if (img._fbIdx < chain.length) { img.src = chain[img._fbIdx++]; return; }
                        }
                    }
                    img.onerror = null; img.src = safe || 'https://placehold.co/280x400?text=Erro';
                };

                const fmtDate    = (ts) => !ts ? 'Desconhecida' : new Date(ts).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                const copyPoster = (item) => { GM_setClipboard(item.poster || "", { type: "text/plain" }); toast('Link do poster copiado!'); };
                const hasWriteAccess = (item) => item.isLocal || item.sources.some(src => configs.find(c => c.name === src.name)?.apiKey);

                const openEditModal = (item) => { editingItem.value = { ...item }; };
                const saveEdit      = () => {
                    if (!editingItem.value) return;
                    const it = { ...editingItem.value, updated_at: Date.now() };
                    const ALL_KEYS = [STORE_CATALOG_PAID, STORE_DOWNLOADED_FREE, STORE_DOWNLOAD_COPY_FREE, STORE_CATALOG_FREE, STORE_DOWNLOADED_PAID];
                    ALL_KEYS.forEach(KEY => {
                        const list = getStored(KEY), idx = list.findIndex(u => u.url === it.url);
                        if (idx !== -1) { list[idx] = { ...list[idx], title: it.title, poster: it.poster, year: it.year, updated_at: it.updated_at }; setStored(KEY, list); }
                    });
                    const copy  = [...dashboardData.value], dIdx = copy.findIndex(i => i.url === it.url);
                    if (dIdx !== -1) copy[dIdx] = { ...copy[dIdx], ...it };
                    dashboardData.value = copy;
                    saveToCloud(); toast('Item atualizado!'); editingItem.value = null;
                };

                const openNoteModal = (item) => { editingNoteItem.value = { url: item.url, filmin_extra_field: item.filmin_extra_field || '' }; };
                const saveNoteEdit  = () => {
                    if (!editingNoteItem.value) return;
                    const it = editingNoteItem.value, savedAt = Date.now();
                    let list = getStored(STORE_EXTRA_FIELD);
                    const idx = list.findIndex(u => u.url === it.url);
                    if (idx !== -1) list[idx] = { url: it.url, filmin_extra_field: it.filmin_extra_field, saved_at: savedAt };
                    else list.push({ url: it.url, filmin_extra_field: it.filmin_extra_field, saved_at: savedAt });
                    setStored(STORE_EXTRA_FIELD, list);
                    const copy = [...dashboardData.value], dIdx = copy.findIndex(i => i.url === it.url);
                    if (dIdx !== -1) copy[dIdx] = { ...copy[dIdx], filmin_extra_field: it.filmin_extra_field };
                    dashboardData.value = copy;
                    saveToCloud(); toast('Nota guardada!'); editingNoteItem.value = null;
                };

                const deleteItem = async (item) => {
                    if (!confirm(`Apagar "${item.title || item.url}" de todas as listas?`)) return;
                    const ALL_KEYS = [STORE_CATALOG_PAID, STORE_DOWNLOADED_FREE, STORE_DOWNLOAD_COPY_FREE, STORE_CATALOG_FREE, STORE_DOWNLOADED_PAID];
                    ALL_KEYS.forEach(KEY => { const f = getStored(KEY).filter(u => u.url !== item.url); setStored(KEY, f); });
                    dashboardData.value = dashboardData.value.filter(i => i.url !== item.url);
                    pendingItems.value  = pendingItems.value.filter(i => i.url !== item.url);
                    await removeFromCloud(item.url);
                };

                const exportFiltered = () => {
                    const data = filtered.value;
                    if (!data.length) return toast('Nada para exportar.');
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                    const url  = URL.createObjectURL(blob);
                    const a    = document.createElement("a"); a.href = url; a.download = `filmin_export_${data.length}_${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
                };

                return {
                    dashboardData, pendingItems, searchName, filterPaid, filterStatus, filterType, filterCloud,
                    dateStart, dateEnd, viewMode, imageCache, st, statCards, ar, filtered, displayed, sentinel,
                    toggleView, close, isSaved, badgeIcons, cardStyle, cardHover, typeColor, posterSrc, posterErr,
                    fmtDate, copyPoster, editingItem, openEditModal, saveEdit, deleteItem, hasWriteAccess,
                    scrapeCurrent, scrapeTotal, editingNoteItem, hoverNote, openNoteModal, saveNoteEdit, exportFiltered
                };
            }
        });
        app.mount(mountEl);

        // Hooks globais para comunicação com scrapeMissingMetadataInBackground
        window._filminDashScrapeProgress = (current, total) => {
            const st = app._instance?.setupState;
            if (st?.scrapeCurrent?.value !== undefined) st.scrapeCurrent.value = current;
            if (st?.scrapeTotal?.value   !== undefined) st.scrapeTotal.value   = total;
        };

        window._filminDashUpdateItem = (url, title, poster, year) => {
            const dashDirtyHookRe = /\s*(-\s*Filmin|ver online\s+(em|en)\s+Filmin)[\s\S]*/i;
            const isComplete = title && poster && title !== 'A resolver...' && !dashDirtyHookRe.test(title);
            let baseItem = null;
            const pIdx = pendingItems.value.findIndex(i => i.url === url);
            if (pIdx !== -1) { baseItem = pendingItems.value[pIdx]; pendingItems.value = pendingItems.value.filter((_, i) => i !== pIdx); }
            const dIdx = dashboardData.value.findIndex(i => i.url === url);
            if (!isComplete) {
                if (dIdx !== -1) dashboardData.value = dashboardData.value.filter((_, i) => i !== dIdx);
                if (!baseItem) {
                    const mediaType = url.includes('/filme/') ? 'Filme' : url.includes('/serie/') ? 'Série' : url.includes('/curta/') ? 'Curta' : 'Vídeo';
                    pendingItems.value = [{ url, title: title || 'A resolver...', poster: poster || '', year: year || '', sources: [], cloudDownloaded: {}, cloudHistory: {}, isLocalDownloaded: false, isLocalHistory: false, isLocal: true, isPaid: false, isCopied: false, mediaType, saved_at: Date.now() }, ...pendingItems.value];
                }
            } else {
                if (dIdx !== -1) {
                    const copy = [...dashboardData.value]; copy[dIdx] = { ...copy[dIdx], title, poster, year }; dashboardData.value = copy;
                } else {
                    const mediaType = url.includes('/filme/') ? 'Filme' : url.includes('/serie/') ? 'Série' : url.includes('/curta/') ? 'Curta' : 'Vídeo';
                    const newItem = baseItem ? { ...baseItem, title, poster, year } : { url, title, poster, year, sources: [], cloudDownloaded: {}, cloudHistory: {}, isLocalDownloaded: false, isLocalHistory: false, isLocal: true, isPaid: false, isCopied: false, mediaType, saved_at: Date.now() };
                    dashboardData.value = [newItem, ...dashboardData.value];
                }
            }
            dashboardData.value.sort((a, b) => (b.updated_at || b.saved_at || 0) - (a.updated_at || a.saved_at || 0));
        };
    }

    /* =====================================================================
       TUTORIAL — Cloudflare Worker
       ===================================================================== */

    function openWorkerTutorialUI() {
        document.getElementById("filmin-cloud-tutorial")?.remove();

        const GITHUB_URL      = "https://github.com/Blackspirits/media-sync/blob/main/worker/worker.js";
        const GITHUB_REPO_URL = "https://github.com/Blackspirits/media-sync";

        const mod = document.createElement("div");
        mod.id = "filmin-cloud-tutorial";
        mod.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:20001;
            display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);`;

        const box = document.createElement("div");
        box.style.cssText = `background:#0a0e16;border:1px solid rgba(255,255,255,.09);padding:0;width:620px;max-width:92%;
            border-radius:14px;color:#e2e8f0;max-height:88vh;overflow:hidden;display:flex;flex-direction:column;
            font-family:system-ui,-apple-system,Segoe UI,sans-serif;
            box-shadow:0 24px 60px rgba(0,0,0,.7),0 0 0 1px rgba(0,224,164,.05);`;

        const codeStyle = "display:inline-block;background:rgba(255,255,255,.07);color:#e2e8f0;padding:2px 7px;border-radius:4px;font-family:monospace;font-size:11.5px;border:1px solid rgba(255,255,255,.1);";
        const stepNumStyle = "display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:rgba(0,224,164,.15);color:#6ee7b7;font-size:10px;font-weight:700;margin-right:8px;flex-shrink:0;";
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
        <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:space-between;background:linear-gradient(105deg,rgba(0,224,164,.08),rgba(8,12,20,0));">
            <div style="display:flex;align-items:center;gap:10px;">
                <span style="width:7px;height:7px;border-radius:50%;background:#00e0a4;box-shadow:0 0 8px rgba(0,224,164,.8);display:inline-block;"></span>
                <span style="font-size:12.5px;font-weight:700;letter-spacing:.12em;color:#f1f5f9;">CLOUDFLARE WORKER — SETUP</span>
            </div>
            <button id="tut-close" style="padding:6px 14px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);color:#94a3b8;border-radius:8px;cursor:pointer;font-size:12px;">Fechar</button>
        </div>
        <div style="overflow-y:auto;padding:20px;flex:1;">
            <ol style="list-style:none;margin:0 0 18px;padding:0;">${stepsHtml}</ol>

            <div style="background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:12px 15px;margin-bottom:18px;">
                <div style="font-size:10.5px;color:#64748b;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px;">⚙ Variáveis de ambiente opcionais (Settings → Variables)</div>
                <div style="display:flex;flex-direction:column;gap:5px;font-size:12px;">
                    <div><span style="${codeStyle}">ALLOWED_PREFIXES</span> <span style="color:#64748b;">— prefixos permitidos (default já inclui</span> <span style="${codeStyle}">filmin_</span><span style="color:#64748b;">)</span></div>
                    <div><span style="${codeStyle}">READ_KEY</span> <span style="color:#64748b;">— chave separada para leitura (opcional)</span></div>
                    <div><span style="${codeStyle}">ALLOWED_ORIGIN</span><span style="color:#475569;">,</span> <span style="${codeStyle}">MAX_BODY</span><span style="color:#475569;">,</span> <span style="${codeStyle}">MAX_ITEMS</span></div>
                </div>
            </div>

            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
                ${btnLink("tut-gh-link", GITHUB_URL,      "↗ Ver Worker no GitHub",     "rgba(37,99,235,.2)",    "rgba(37,99,235,.4)")}
                ${btnLink("tut-gh-repo", GITHUB_REPO_URL, "↗ Repositório completo",    "rgba(55,65,81,.4)",     "rgba(255,255,255,.12)")}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                ${btnCopy("tut-copy-secret", "Copiar nome do Secret (API_KEY)", "rgba(139,92,246,.15)", "rgba(139,92,246,.35)", "#c4b5fd")}
                ${btnCopy("tut-copy-kv",     "Copiar KV binding (MEDIA)",       "rgba(16,185,129,.15)", "rgba(16,185,129,.35)", "#6ee7b7")}
                ${btnCopy("tut-copy-pfx",    "Copiar prefixo (filmin_)",        "rgba(14,165,233,.15)", "rgba(14,165,233,.35)", "#7dd3fc")}
            </div>
        </div>`;

        mod.appendChild(box);
        document.body.appendChild(mod);

        const close = () => mod.remove();
        box.querySelector("#tut-close").onclick = close;
        mod.addEventListener("click", (e) => { if (e.target === mod) close(); });
        box.querySelector("#tut-copy-secret").onclick = () => { GM_setClipboard("API_KEY", { type: "text/plain" }); toast("Copiado: API_KEY"); };
        box.querySelector("#tut-copy-kv").onclick     = () => { GM_setClipboard("MEDIA",   { type: "text/plain" }); toast("Copiado: MEDIA"); };
        box.querySelector("#tut-copy-pfx").onclick    = () => { GM_setClipboard("filmin_", { type: "text/plain" }); toast("Copiado: filmin_"); };
    }

    function injectHideButton() {
        if (document.getElementById("bs-filmin-native-filters")) return;
        const filtersContainer = document.querySelector('.d-flex.order-last');
        if (!filtersContainer) return;

        const wrapper = document.createElement("div");
        wrapper.id = "bs-filmin-native-filters";
        wrapper.style.cssText = "display:flex;gap:8px;";

        const svgEye    = `<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle>`;
        const svgEyeOff = `<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"></path><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"></path><line x1="2" y1="2" x2="22" y2="22"></line>`;

        // Cria botão toggle com ícone de olho
        const createFilterBtn = (id, textOn, textOff, isHidden, onChange) => {
            const btn = document.createElement("button");
            btn.id = id; btn.type = "button";
            btn.className = "c-button c-button--md c-button--default c-button--outline";
            let current = isHidden;
            const render = () => {
                btn.innerHTML = `<svg class="o-svg-icon c-button__icon icon--md" style="fill:transparent;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${current ? svgEyeOff : svgEye}</svg>
                    <div class="ml-2 font-base text-initial font-weight-normal c-button__text">${current ? textOn : textOff}</div>`;
            };
            render();
            btn.addEventListener("click", (e) => { e.preventDefault(); current = !current; render(); onChange(current); });
            return btn;
        };

        wrapper.append(
            createFilterBtn("btn-hide-down",    "Mostrar Transferidos", "Ocultar Transferidos", hideDownloaded, (v) => { hideDownloaded = v; GM_setValue("filmin_hide_downloaded_v1", v); highlightSavedLinks(); }),
            createFilterBtn("btn-hide-paid",    "Mostrar Pagos",        "Ocultar Pagos",        hidePaid,       (v) => { hidePaid       = v; GM_setValue("filmin_hide_paid_v1",       v); highlightSavedLinks(); }),
            createFilterBtn("btn-hide-history", "Mostrar Histórico",    "Ocultar Histórico",    hideHistory,    (v) => { hideHistory    = v; GM_setValue("filmin_hide_history_v1",    v); highlightSavedLinks(); })
        );

        filtersContainer.insertBefore(wrapper, filtersContainer.firstChild);
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
        let stable = 0, lastTotal = currentStats().all;
        const step = async () => {
            if (!autoScrolling) return;
            if (document.readyState !== "complete") { autoScrollTimer = setTimeout(step, 700); return; }
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
            await new Promise(r => setTimeout(r, 1200));
            updateStats();
            const nowTotal = currentStats().all;
            if (nowTotal <= lastTotal) stable++; else stable = 0;
            lastTotal = nowTotal;
            // Para ao fim de 6 ciclos sem novos itens
            if (stable >= 6) { stopAutoScroll(btn); toast("Chegou ao fim (sem novos itens)."); return; }
            autoScrollTimer = setTimeout(step, 700);
        };
        step();
    }

    function toggleAutoScroll(btn) { if (autoScrolling) stopAutoScroll(btn); else startAutoScroll(btn); }

    /* =====================================================================
       MENU COMMANDS (Tampermonkey / Violentmonkey)
       ===================================================================== */

    GM_registerMenuCommand("Guardar catálogo (Nuvem)", saveHistory);
    GM_registerMenuCommand("Copiar links (grátis)",                  copyFreeLinksToClipboard);
    GM_registerMenuCommand("Marcar Transferidos",                    markCopiedAsDownloaded);
    GM_registerMenuCommand("Reset Copiados",                         resetCopiedLinks);
    GM_registerMenuCommand("Gerir APIs Cloud",                       openApiManagerUI);
    GM_registerMenuCommand("Exportar Backup (JSON)",                 exportData);
    GM_registerMenuCommand("Importar Backup (JSON)",                 importData);
    GM_registerMenuCommand("Remover ficheiro (Histórico)",           () => { fsApi().clearSlot(FS_SLOT_HISTORY); toast("Ligação ao Ficheiro apagada."); });
    GM_registerMenuCommand("Scroll automático (ON/OFF)",             () => toggleAutoScroll(null));

    /* =====================================================================
       INIT / AUTO UPDATES

       Fluxo de arranque:
         1. injectUI()           — painel visível imediatamente
         2. injectHideButton()   — botões nativos de filtro
         3. highlightSavedLinks()— aplica estados locais (cloud ainda vazio)
         4. fetchCloudData()     — GET nas APIs → highlightSavedLinks() completo
         5. MutationObserver     — novos cards → queueCard → _flushCards (RAF)
         6. SPA hooks + scroll   — scheduleUpdate → reinjecta UI se desapareceu
       ===================================================================== */

    let _tAuto    = 0;
    let _observer = null;
    let _inited   = false;
    let _needsFullScan = false; // true após navegação SPA — scan total na próxima scheduleUpdate()

    /**
     * Debounce de scroll/SPA navigation.
     * Reinjecta UI se desapareceu, tenta injectHideButton, e apanha cards
     * que possam ter carregado via SPA sem disparar MutationObserver.
     */
    function scheduleUpdate() {
        clearTimeout(_tAuto);
        _tAuto = setTimeout(() => {
            if (!document.getElementById("bs-filmin-panel")) {
                try { injectUI(); } catch (e) { console.error("Falha ao reinjetar UI:", e); }
            }
            try { injectHideButton(); } catch { }
            try { if (_needsFullScan) { document.querySelectorAll(CARD_ROOT_SELECTOR).forEach(queueCard); _needsFullScan = false; } } catch { }
        }, AUTO_UPDATE_MS);
    }

    /**
     * Cria o MutationObserver incremental uma única vez.
     * A guarda _observer evita criar múltiplos observers em re-renders SPA
     * (que acumulariam callbacks e causariam leaks de memória).
     */
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
            try { injectHideButton(); } catch { }
            if (touched) scheduleUpdate();
        });
        _observer.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * Intercepta pushState/replaceState/popstate para reagir à navegação SPA.
     * Sem isto, mudar de página no Filmin.pt não dispararia scroll nem
     * MutationObserver e o painel ficaria invisível.
     */
    function hookSpaNavigation() {
        if (window.__bsFilminSpaHooked) return;
        window.__bsFilminSpaHooked = true;

        const _ps = history.pushState;
        history.pushState = function (...args) {
            const r = _ps.apply(this, args);
            _needsFullScan = true;
                setTimeout(scheduleUpdate, 50);
            return r;
        };
        const _rs = history.replaceState;
        history.replaceState = function (...args) {
            const r = _rs.apply(this, args);
            _needsFullScan = true;
                setTimeout(scheduleUpdate, 50);
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

        // UI + erros globais
        try { injectUI(); } catch (e) { console.error("injectUI falhou:", e); alert("Erro no script Filmin: " + e.message); }
        window.addEventListener('error', (e) => {
            if (!e.message || e.message.includes('Script error')) return;
            console.error(e); toast('Erro crítico: ' + e.message);
        });
        window.addEventListener('unhandledrejection', (e) => {
            console.error(e); toast('Erro assíncrono: ' + (e.reason?.message || e.reason || 'Desconhecido'));
        });

        // Estado local imediato
        try { injectHideButton(); } catch { }
        try { highlightSavedLinks(); } catch (e) { console.warn("highlightSavedLinks falhou:", e); }

        // Observer incremental (uma vez)
        ensureObserver();

        // Varredura inicial: cards já presentes antes do observer arrancar
        try { document.querySelectorAll(CARD_ROOT_SELECTOR).forEach(queueCard); } catch { }

        // Cloud (despoleta highlightSavedLinks() completo no fim)
        try { fetchCloudData(); } catch (e) { console.warn("fetchCloudData falhou:", e); }

        // SPA hooks + scroll debounce
        hookSpaNavigation();
        window.addEventListener("scroll", scheduleUpdate, { passive: true });

        // 1ª revisão pós-init (lazy content / SPA)
        scheduleUpdate();
    }

    // ARRANQUE
    init();

})();
