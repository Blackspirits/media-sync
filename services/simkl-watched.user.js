// ==UserScript==
// @name         Simkl Watched Overlay
// @namespace    https://github.com/Blackspirits/media-sync
// @version      1.0.0
// @description  Sobrepõe badge "Visto" do Simkl em FilmTwist e Filmin. OAuth via PIN, matching
//               por título+ano, override manual de ID Simkl por item.
// @author       Blackspirits
// @match        https://www.filmtwist.pt/*
// @match        https://filmtwist.pt/*
// @match        https://www.filmin.pt/*
// @match        https://filmin.pt/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      api.simkl.com
// @run-at       document-idle
// ==/UserScript==

/*  ╔══════════════════════════════════════════════════════════════════════╗
    ║  CONFIGURAÇÃO  — Cria a tua app em https://simkl.com/settings/developer/  ║
    ║  Preenche SIMKL_CLIENT_ID com o "Client ID" da tua app.             ║
    ╚══════════════════════════════════════════════════════════════════════╝ */
const SIMKL_CLIENT_ID = "COLOCA_AQUI_O_SEU_CLIENT_ID";

/* ───────────────────────────── changelog ──────────────────────────────────
 * v1.0.0 — Script inicial: PIN OAuth (sem redirect URI, funciona em userscripts);
 *           sync completo de /sync/all-items/movies,shows; matching por título+ano;
 *           override manual de ID Simkl por item (UI contextual no hover);
 *           overlay badge "✓ Visto" com anel verde no canto inferior-direito;
 *           painel de settings (toggle, sync manual, logout, estado);
 *           cache local com TTL 6h; FilmTwist + Filmin suportados.
 * ─────────────────────────────────────────────────────────────────────────*/

(function () {
    "use strict";

    // ════════════════════════════════════════════════════════════════════════
    //  CONSTANTES
    // ════════════════════════════════════════════════════════════════════════
    const STORE_TOKEN       = "simkl_access_token";
    const STORE_WATCHED     = "simkl_watched_cache";       // [{title, year, type, ids:{simkl,imdb,tmdb}}]
    const STORE_CACHE_TS    = "simkl_cache_timestamp";
    const STORE_OVERRIDES   = "simkl_overrides";           // { "title|year": simkl_id }
    const STORE_ENABLED     = "simkl_overlay_enabled";
    const CACHE_TTL_MS      = 6 * 60 * 60 * 1000;         // 6 horas
    const API               = "https://api.simkl.com";
    const PANEL_ID          = "simkl-panel";
    const SITE              = location.hostname.replace("www.", "");
    const IS_FT             = SITE === "filmtwist.pt";
    const IS_FM             = SITE === "filmin.pt";
    const BRAND             = IS_FT ? "#dc2626" : "#00e0a4";

    // ════════════════════════════════════════════════════════════════════════
    //  ESTADO RUNTIME
    // ════════════════════════════════════════════════════════════════════════
    let watchedSet   = new Map();   // normalizedKey → { simkl_id, title, year, type }
    let overrides    = {};          // "title|year" → simkl_id (manual override)
    let isEnabled    = true;
    let syncRunning  = false;
    let panelVisible = false;

    // ════════════════════════════════════════════════════════════════════════
    //  UTILITÁRIOS
    // ════════════════════════════════════════════════════════════════════════
    function esc(s) { const d = document.createElement("div"); d.textContent = String(s??''); return d.innerHTML; }

    /** Normaliza título para matching: lowercase, sem artigos, sem pontuação */
    function normalizeTitle(t) {
        return (t || "")
            .toLowerCase()
            .replace(/^(the |a |an |o |a |os |as |um |uma )/i, "")
            .replace(/[^a-z0-9\s]/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    /** Chave de matching: "titulo_normalizado|ano" */
    function matchKey(title, year) {
        return `${normalizeTitle(title)}|${year || ""}`;
    }

    /** Faz request via GM_xmlhttpRequest (cross-origin) */
    function gmFetch(url, opts = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: opts.method || "GET",
                url,
                headers: {
                    "Content-Type":  "application/json",
                    "simkl-api-key": SIMKL_CLIENT_ID,
                    ...(opts.headers || {}),
                },
                data: opts.body ? JSON.stringify(opts.body) : undefined,
                onload: (r) => {
                    try { resolve({ status: r.status, data: JSON.parse(r.responseText) }); }
                    catch { resolve({ status: r.status, data: r.responseText }); }
                },
                onerror: reject,
            });
        });
    }

    // ════════════════════════════════════════════════════════════════════════
    //  TOAST (standalone, não depende dos outros scripts)
    // ════════════════════════════════════════════════════════════════════════
    function injectToastCSS() {
        if (document.getElementById("simkl-toast-css")) return;
        const s = document.createElement("style");
        s.id = "simkl-toast-css";
        s.textContent = `
        #simkl-toast-c { position:fixed;bottom:70px;right:20px;z-index:2000000;
            display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none; }
        .simkl-t { background:rgba(10,14,22,.97);color:#f1f5f9;padding:10px 16px;
            border-radius:8px;font-size:13px;font-weight:500;max-width:320px;
            font-family:system-ui,sans-serif;border:1px solid rgba(255,255,255,.1);
            border-left:3px solid ${BRAND};box-shadow:0 8px 24px rgba(0,0,0,.6);
            backdrop-filter:blur(8px);
            animation:simklIn .3s cubic-bezier(.16,1,.3,1) forwards; }
        .simkl-t.out { animation:simklOut .22s ease-in forwards; }
        @keyframes simklIn  { from{transform:translateX(calc(100% + 20px));opacity:0} to{transform:translateX(0);opacity:1} }
        @keyframes simklOut { from{transform:translateX(0);opacity:1} to{transform:translateX(calc(100% + 20px));opacity:0} }
        `;
        (document.head || document.documentElement).appendChild(s);
    }

    function toast(msg, duration = 4000) {
        injectToastCSS();
        let c = document.getElementById("simkl-toast-c");
        if (!c) { c = document.createElement("div"); c.id = "simkl-toast-c"; document.documentElement.appendChild(c); }
        const t = document.createElement("div");
        t.className = "simkl-t";
        t.textContent = msg;
        c.appendChild(t);
        setTimeout(() => {
            t.classList.add("out");
            t.addEventListener("animationend", () => t.remove(), { once: true });
        }, duration);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  OAUTH — PIN DEVICE FLOW (sem redirect URI, funciona em userscripts)
    // ════════════════════════════════════════════════════════════════════════
    async function requestPin() {
        const r = await gmFetch(`${API}/oauth/pin?client_id=${SIMKL_CLIENT_ID}`, { method: "POST", body: {} });
        if (r.status !== 200 || !r.data?.user_code) throw new Error("Erro ao obter PIN");
        return r.data; // { user_code, verification_url, expires_in, interval }
    }

    async function pollPin(userCode, intervalSec = 5, maxAttempts = 60) {
        for (let i = 0; i < maxAttempts; i++) {
            await new Promise(r => setTimeout(r, intervalSec * 1000));
            const r = await gmFetch(`${API}/oauth/pin/${userCode}?client_id=${SIMKL_CLIENT_ID}`);
            if (r.status === 200 && r.data?.access_token) return r.data.access_token;
            if (r.status !== 400) break; // erro inesperado
            // 400 = authorization_pending → continua a polling
        }
        return null;
    }

    async function login(onProgress) {
        if (!SIMKL_CLIENT_ID || SIMKL_CLIENT_ID === "COLOCA_AQUI_O_SEU_CLIENT_ID") {
            toast("⚠ Configura o SIMKL_CLIENT_ID no topo do script.");
            return false;
        }
        try {
            onProgress("A obter PIN...");
            const { user_code, verification_url, interval } = await requestPin();
            openPinModal(user_code, verification_url);
            onProgress("A aguardar autorização...");
            const token = await pollPin(user_code, interval || 5);
            closePinModal();
            if (!token) { toast("Timeout ou recusado. Tenta novamente."); return false; }
            GM_setValue(STORE_TOKEN, token);
            toast("✓ Simkl conectado com sucesso!");
            return true;
        } catch (e) {
            console.error("[Simkl]", e);
            toast("Erro na autenticação: " + e.message);
            return false;
        }
    }

    function openPinModal(code, url) {
        closePinModal();
        const m = document.createElement("div");
        m.id = "simkl-pin-modal";
        m.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:2000001;
            display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);`;
        const codeStyle = "font-size:32px;font-weight:700;letter-spacing:.25em;color:#f1f5f9;font-family:monospace;background:rgba(255,255,255,.06);padding:12px 24px;border-radius:10px;border:1px solid rgba(255,255,255,.12);margin:12px 0;";
        m.innerHTML = `
        <div style="background:#0a0e16;border:1px solid rgba(255,255,255,.09);border-radius:14px;
            padding:32px;width:420px;max-width:92%;text-align:center;color:#e2e8f0;
            font-family:system-ui,sans-serif;box-shadow:0 24px 60px rgba(0,0,0,.7);">
            <div style="width:36px;height:36px;border-radius:50%;background:${BRAND}22;display:flex;align-items:center;
                justify-content:center;margin:0 auto 16px;font-size:20px;">🔗</div>
            <div style="font-size:15px;font-weight:700;letter-spacing:.08em;margin-bottom:8px;">LIGAR AO SIMKL</div>
            <div style="font-size:12px;color:#94a3b8;margin-bottom:20px;line-height:1.6;">
                1. Abre o link abaixo no teu browser<br>
                2. Inicia sessão no Simkl<br>
                3. Introduz o código PIN
            </div>
            <div style="${codeStyle}" id="simkl-pin-code">${esc(code)}</div>
            <a href="${esc(url)}" target="_blank" rel="noopener"
               style="display:inline-flex;align-items:center;gap:6px;padding:10px 20px;
               background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);
               border-radius:8px;color:#e2e8f0;text-decoration:none;font-size:13px;font-weight:600;margin-bottom:20px;">
               ↗ ${esc(url)}
            </a>
            <div id="simkl-pin-copy" style="cursor:pointer;font-size:12px;color:#64748b;margin-bottom:20px;">
                Clica para copiar o código
            </div>
            <div style="font-size:11px;color:#475569;display:flex;align-items:center;justify-content:center;gap:6px;">
                <span style="width:8px;height:8px;border-radius:50%;background:${BRAND};
                    box-shadow:0 0 6px ${BRAND};display:inline-block;animation:simklPulse 1.5s infinite;"></span>
                A aguardar autorização...
            </div>
        </div>
        <style>@keyframes simklPulse{0%,100%{opacity:1}50%{opacity:.3}}</style>`;
        document.body.appendChild(m);
        m.querySelector("#simkl-pin-copy").addEventListener("click", () => {
            GM_setClipboard(code, { type: "text/plain" });
            m.querySelector("#simkl-pin-copy").textContent = "✓ Copiado!";
        });
    }

    function closePinModal() {
        document.getElementById("simkl-pin-modal")?.remove();
    }

    // ════════════════════════════════════════════════════════════════════════
    //  SYNC — Busca lista completa de visionamentos ao Simkl
    // ════════════════════════════════════════════════════════════════════════
    async function syncWatched(force = false) {
        if (syncRunning) return;
        syncRunning = true;
        try {
            const token = GM_getValue(STORE_TOKEN, null);
            if (!token) { toast("Não autenticado. Liga ao Simkl primeiro."); return; }

            const cacheTs = GM_getValue(STORE_CACHE_TS, 0);
            if (!force && Date.now() - cacheTs < CACHE_TTL_MS) {
                loadCachedWatched();
                return;
            }

            toast("🔄 A sincronizar com Simkl...");
            const r = await gmFetch(`${API}/sync/all-items/movies,shows?extended=full`, {
                headers: { "Authorization": `Bearer ${token}` },
            });

            if (r.status === 401) {
                GM_setValue(STORE_TOKEN, null);
                toast("Sessão expirada. Volta a ligar ao Simkl.");
                return;
            }
            if (r.status !== 200) { toast(`Erro Simkl: HTTP ${r.status}`); return; }

            const items = normalizeWatched(r.data);
            GM_setValue(STORE_WATCHED,  JSON.stringify(items));
            GM_setValue(STORE_CACHE_TS, Date.now());
            buildWatchedSet(items);
            toast(`✓ Simkl: ${items.length} títulos sincronizados`);
            applyOverlaysToPage();
        } finally {
            syncRunning = false;
        }
    }

    /**
     * Transforma a resposta de /sync/all-items num array normalizado
     * Simkl retorna { movies: [{movie:{title,year,ids:{simkl,imdb,tmdb}}}], shows: [...] }
     */
    function normalizeWatched(data) {
        const out = [];
        const push = (item, type) => {
            const obj = item.movie || item.show;
            if (!obj) return;
            out.push({
                title:    obj.title || "",
                year:     obj.year  || "",
                type,
                ids:      obj.ids || {},
            });
        };
        (data.movies || []).forEach(i => push(i, "movie"));
        (data.shows  || []).forEach(i => push(i, "show"));
        return out;
    }

    function buildWatchedSet(items) {
        watchedSet.clear();
        items.forEach(item => {
            const key = matchKey(item.title, item.year);
            watchedSet.set(key, item);
            // também indexar pelo simkl_id para override lookup
            if (item.ids?.simkl) watchedSet.set(`simkl_id:${item.ids.simkl}`, item);
        });
    }

    function loadCachedWatched() {
        try {
            const raw = GM_getValue(STORE_WATCHED, "[]");
            const items = JSON.parse(raw);
            buildWatchedSet(items);
            applyOverlaysToPage();
        } catch { /* cache vazio */ }
    }

    function loadOverrides() {
        try { overrides = JSON.parse(GM_getValue(STORE_OVERRIDES, "{}")); }
        catch { overrides = {}; }
    }

    function saveOverrides() {
        GM_setValue(STORE_OVERRIDES, JSON.stringify(overrides));
    }

    // ════════════════════════════════════════════════════════════════════════
    //  MATCHING
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Dado um título e ano extraídos do DOM, devolve o item do Simkl se encontrado.
     * Prioridade: override manual > match exato (title+year) > match só por título
     */
    function findInWatched(title, year, overrideKey) {
        // 1. Override manual com ID Simkl
        const savedId = overrides[overrideKey];
        if (savedId) {
            const byId = watchedSet.get(`simkl_id:${savedId}`);
            if (byId) return byId;
        }

        // 2. Match exato título + ano
        const key = matchKey(title, year);
        if (watchedSet.has(key)) return watchedSet.get(key);

        // 3. Match só por título (sem ano) — só quando ano é vazio/desconhecido
        if (!year) {
            const keyNoYear = matchKey(title, "");
            if (watchedSet.has(keyNoYear)) return watchedSet.get(keyNoYear);
        }

        return null;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  OVERLAY — injeta badge "✓" nos cards
    // ════════════════════════════════════════════════════════════════════════
    function injectOverlayCSS() {
        if (document.getElementById("simkl-overlay-css")) return;
        const s = document.createElement("style");
        s.id = "simkl-overlay-css";
        s.textContent = `
        .simkl-badge {
            position:absolute;bottom:8px;right:8px;z-index:200;
            width:26px;height:26px;border-radius:50%;
            background:rgba(0,0,0,.75);border:2px solid #22c55e;
            display:flex;align-items:center;justify-content:center;
            pointer-events:none;
            box-shadow:0 0 8px rgba(34,197,94,.4);
            transition:opacity .2s;
        }
        .simkl-badge svg { width:13px;height:13px;stroke:#22c55e; }
        .simkl-badge-edit {
            position:absolute;bottom:8px;right:8px;z-index:201;
            width:22px;height:22px;border-radius:50%;
            background:rgba(10,14,22,.9);border:1px solid rgba(255,255,255,.2);
            display:none;align-items:center;justify-content:center;
            cursor:pointer;opacity:0;transition:opacity .2s;
        }
        article:hover .simkl-badge-edit,
        .card:hover .simkl-badge-edit,
        .posters-item:hover .simkl-badge-edit { display:flex;opacity:1; }
        .simkl-badge-edit svg { width:11px;height:11px;stroke:#94a3b8; }
        .simkl-badge-edit:hover { border-color:${BRAND};background:${BRAND}22; }
        .simkl-badge-edit:hover svg { stroke:${BRAND}; }
        `;
        (document.head || document.documentElement).appendChild(s);
    }

    const SVG_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    const SVG_EDIT  = `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

    /**
     * Extrai dados de um card do DOM conforme o site
     * Retorna { title, year, url, root }
     */
    function extractCardData(el) {
        // FilmTwist: article com link href /filme/ ou /serie/
        // Filmin: .card com link href /filme/ ou /serie/
        const link = el.querySelector("a[href*='/filme/'], a[href*='/serie/'], a[href*='/curta/']");
        if (!link) return null;
        const url   = link.href;
        const title = (el.querySelector("img")?.alt || el.querySelector("[title]")?.title ||
                       el.querySelector("h3,h2,.title,.card-title")?.textContent || "").trim();
        const year  = (el.querySelector(".year,.card-year")?.textContent || "").match(/\d{4}/)?.[0] || "";
        return { title, year, url, root: el };
    }

    /** Injeta overlay num card */
    function applyBadgeToCard(el) {
        if (!isEnabled || !el) return;
        // garante position:relative no root
        const pos = getComputedStyle(el).position;
        if (pos === "static") el.style.position = "relative";

        const data = extractCardData(el);
        if (!data || !data.title) return;

        const overrideKey = `${normalizeTitle(data.title)}|${data.year}`;
        const found = findInWatched(data.title, data.year, overrideKey);

        // Remove badge anterior se existir
        el.querySelector(".simkl-badge")?.remove();
        el.querySelector(".simkl-badge-edit")?.remove();

        if (found) {
            // Badge "visto"
            const badge = document.createElement("div");
            badge.className = "simkl-badge";
            badge.title = `Visto no Simkl: ${found.title} (${found.year || "?"})`;
            badge.innerHTML = SVG_CHECK;
            el.appendChild(badge);
        }

        // Botão editar (aparece sempre no hover para poder definir/corrigir ID)
        const editBtn = document.createElement("div");
        editBtn.className = "simkl-badge-edit";
        editBtn.title = "Definir ID Simkl manualmente";
        editBtn.innerHTML = SVG_EDIT;
        editBtn.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            openOverrideModal(data.title, data.year, overrideKey, found);
        });
        el.appendChild(editBtn);
    }

    /** Percorre todos os cards visíveis e aplica overlays */
    function applyOverlaysToPage() {
        if (!isEnabled) return;
        injectOverlayCSS();

        const selectors = IS_FT
            ? "article, .posters-item"
            : "article, .card, .c-card";

        document.querySelectorAll(selectors).forEach(applyBadgeToCard);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  MODAL DE OVERRIDE — pesquisa e define ID Simkl manual
    // ════════════════════════════════════════════════════════════════════════
    function openOverrideModal(title, year, overrideKey, currentMatch) {
        document.getElementById("simkl-override-modal")?.remove();

        const m = document.createElement("div");
        m.id = "simkl-override-modal";
        m.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:2000002;
            display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);`;

        const inputCSS = "width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:#e2e8f0;padding:9px 13px;border-radius:8px;font-size:13px;font-family:inherit;outline:none;";
        const currentId = overrides[overrideKey] || currentMatch?.ids?.simkl || "";

        m.innerHTML = `
        <div id="simkl-override-box" style="background:#0a0e16;border:1px solid rgba(255,255,255,.09);
            border-radius:14px;width:500px;max-width:92%;color:#e2e8f0;
            font-family:system-ui,sans-serif;box-shadow:0 24px 60px rgba(0,0,0,.7);overflow:hidden;">

            <!-- Header -->
            <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.07);
                display:flex;align-items:center;justify-content:space-between;
                background:linear-gradient(105deg,rgba(34,197,94,.08),rgba(8,12,20,0));">
                <div style="display:flex;align-items:center;gap:10px;">
                    <span style="width:7px;height:7px;border-radius:50%;background:#22c55e;display:inline-block;
                        box-shadow:0 0 8px rgba(34,197,94,.8);"></span>
                    <span style="font-size:12px;font-weight:700;letter-spacing:.1em;">DEFINIR ID SIMKL</span>
                </div>
                <button id="simkl-ov-close" style="padding:5px 12px;background:rgba(255,255,255,.06);
                    border:1px solid rgba(255,255,255,.1);color:#94a3b8;border-radius:7px;cursor:pointer;font-size:12px;">✕</button>
            </div>

            <div style="padding:20px;">
                <!-- Título detectado -->
                <div style="font-size:11px;color:#64748b;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">Título detectado</div>
                <div style="font-size:14px;font-weight:600;margin-bottom:4px;">${esc(title)}</div>
                <div style="font-size:12px;color:#64748b;margin-bottom:16px;">Ano: ${esc(year||'desconhecido')}${currentMatch ? ` · Match atual: <span style="color:#22c55e;">${esc(currentMatch.title)} (${currentMatch.year||'?'})</span>` : ' · <span style="color:#f59e0b;">Sem match</span>'}</div>

                <!-- ID manual -->
                <div style="font-size:11px;color:#64748b;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">ID Simkl (override manual)</div>
                <div style="display:flex;gap:8px;margin-bottom:16px;">
                    <input id="simkl-ov-id" type="text" placeholder="ex: 292328" value="${esc(currentId)}"
                        style="${inputCSS}flex:1;margin-bottom:0;">
                    <button id="simkl-ov-lookup" style="padding:0 14px;background:rgba(34,197,94,.15);
                        color:#86efac;border:1px solid rgba(34,197,94,.3);border-radius:8px;cursor:pointer;
                        font-size:12px;font-weight:600;white-space:nowrap;font-family:inherit;">Verificar</button>
                </div>

                <!-- Pesquisa Simkl -->
                <div style="font-size:11px;color:#64748b;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">Ou pesquisar no Simkl</div>
                <div style="display:flex;gap:8px;margin-bottom:10px;">
                    <input id="simkl-ov-search" type="text" placeholder="Pesquisar título..." value="${esc(title)}"
                        style="${inputCSS}flex:1;margin-bottom:0;">
                    <button id="simkl-ov-search-btn" style="padding:0 14px;background:rgba(255,255,255,.07);
                        color:#e2e8f0;border:1px solid rgba(255,255,255,.12);border-radius:8px;cursor:pointer;
                        font-size:12px;font-weight:600;white-space:nowrap;font-family:inherit;">Pesquisar</button>
                </div>
                <div id="simkl-ov-results" style="min-height:60px;max-height:220px;overflow-y:auto;
                    background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);
                    border-radius:8px;padding:8px;margin-bottom:16px;font-size:12px;color:#64748b;">
                    <div style="padding:16px;text-align:center;">Pesquisa vazia. Clica "Pesquisar" para procurar.</div>
                </div>

                <!-- Ações -->
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                    ${currentId ? `<button id="simkl-ov-clear" style="padding:8px 14px;background:rgba(239,68,68,.1);
                        color:#fca5a5;border:1px solid rgba(239,68,68,.25);border-radius:8px;cursor:pointer;
                        font-size:12px;font-family:inherit;">Remover override</button>` : ''}
                    <button id="simkl-ov-save" style="padding:8px 16px;background:rgba(34,197,94,.2);
                        color:#86efac;border:1px solid rgba(34,197,94,.35);border-radius:8px;cursor:pointer;
                        font-size:12px;font-weight:600;font-family:inherit;">Guardar</button>
                </div>
            </div>
        </div>`;

        document.body.appendChild(m);

        // Event handlers
        m.querySelector("#simkl-ov-close").onclick = () => m.remove();
        m.addEventListener("click", e => { if (e.target === m) m.remove(); });

        m.querySelector("#simkl-ov-save").onclick = () => {
            const id = m.querySelector("#simkl-ov-id").value.trim();
            if (id) {
                overrides[overrideKey] = id;
                saveOverrides();
                toast(`✓ Override guardado: ID ${id}`);
            }
            m.remove();
            applyOverlaysToPage();
        };

        m.querySelector("#simkl-ov-clear")?.addEventListener("click", () => {
            delete overrides[overrideKey];
            saveOverrides();
            toast("Override removido");
            m.remove();
            applyOverlaysToPage();
        });

        // Verificar ID
        m.querySelector("#simkl-ov-lookup").onclick = async () => {
            const id = m.querySelector("#simkl-ov-id").value.trim();
            if (!id) return;
            const resultsEl = m.querySelector("#simkl-ov-results");
            resultsEl.innerHTML = `<div style="padding:12px;text-align:center;color:#94a3b8;">A verificar ID ${esc(id)}...</div>`;
            try {
                const r = await gmFetch(`${API}/search/id?simkl=${encodeURIComponent(id)}&client_id=${SIMKL_CLIENT_ID}`);
                if (r.status === 200 && Array.isArray(r.data) && r.data[0]) {
                    const item = r.data[0].movie || r.data[0].show;
                    resultsEl.innerHTML = `<div style="padding:10px;color:#86efac;">
                        ✓ Encontrado: <b>${esc(item?.title)}</b> (${item?.year||'?'})
                        — ID ${esc(id)}</div>`;
                } else {
                    resultsEl.innerHTML = `<div style="padding:10px;color:#fca5a5;">ID não encontrado</div>`;
                }
            } catch { resultsEl.innerHTML = `<div style="padding:10px;color:#fca5a5;">Erro de rede</div>`; }
        };

        // Pesquisa por título
        const doSearch = async () => {
            const q = m.querySelector("#simkl-ov-search").value.trim();
            if (!q) return;
            const resultsEl = m.querySelector("#simkl-ov-results");
            resultsEl.innerHTML = `<div style="padding:12px;text-align:center;color:#94a3b8;">A pesquisar "${esc(q)}"...</div>`;
            try {
                const r = await gmFetch(`${API}/search/title?q=${encodeURIComponent(q)}&client_id=${SIMKL_CLIENT_ID}&type=movie,show`);
                if (r.status === 200 && Array.isArray(r.data) && r.data.length) {
                    resultsEl.innerHTML = "";
                    r.data.slice(0, 8).forEach(entry => {
                        const item = entry.movie || entry.show;
                        const type = entry.movie ? "Filme" : "Série";
                        const simklId = item?.ids?.simkl;
                        const row = document.createElement("div");
                        row.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:6px;cursor:pointer;transition:background .15s;gap:8px;";
                        row.onmouseenter = () => row.style.background = "rgba(255,255,255,.04)";
                        row.onmouseleave = () => row.style.background = "";
                        const titleEl = document.createElement("div");
                        titleEl.innerHTML = `<span style="font-size:12.5px;color:#e2e8f0;font-weight:500;">${esc(item?.title||'?')}</span>
                            <span style="font-size:11px;color:#64748b;margin-left:6px;">${esc(item?.year||'')} · ${esc(type)}</span>`;
                        const selBtn = document.createElement("button");
                        selBtn.textContent = "Selecionar";
                        selBtn.style.cssText = "padding:4px 10px;background:rgba(34,197,94,.15);color:#86efac;border:1px solid rgba(34,197,94,.25);border-radius:6px;cursor:pointer;font-size:11px;white-space:nowrap;font-family:inherit;";
                        selBtn.onclick = (e) => {
                            e.stopPropagation();
                            m.querySelector("#simkl-ov-id").value = simklId || "";
                            // Highlight selected
                            resultsEl.querySelectorAll("button").forEach(b => {
                                b.textContent = "Selecionar";
                                b.style.background = "rgba(34,197,94,.15)";
                            });
                            selBtn.textContent = "✓ Selecionado";
                            selBtn.style.background = "rgba(34,197,94,.3)";
                        };
                        row.appendChild(titleEl);
                        row.appendChild(selBtn);
                        resultsEl.appendChild(row);
                    });
                } else {
                    resultsEl.innerHTML = `<div style="padding:12px;text-align:center;color:#64748b;">Sem resultados para "${esc(q)}"</div>`;
                }
            } catch { resultsEl.innerHTML = `<div style="padding:10px;color:#fca5a5;">Erro de rede</div>`; }
        };

        m.querySelector("#simkl-ov-search-btn").onclick = doSearch;
        m.querySelector("#simkl-ov-search").addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
        m.querySelector("#simkl-ov-id").addEventListener("keydown", e => { if (e.key === "Enter") m.querySelector("#simkl-ov-lookup").click(); });
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PAINEL DE SETTINGS (botão flutuante pequeno no canto)
    // ════════════════════════════════════════════════════════════════════════
    function injectPanel() {
        if (document.getElementById(PANEL_ID)) return;

        const panel = document.createElement("div");
        panel.id = PANEL_ID;
        panel.style.cssText = `position:fixed;bottom:20px;left:20px;z-index:1999999;font-family:system-ui,sans-serif;`;

        // Botão trigger
        const trigger = document.createElement("button");
        trigger.id = "simkl-trigger";
        const token = GM_getValue(STORE_TOKEN, null);
        trigger.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
        trigger.title = "Simkl Watched";
        trigger.style.cssText = `width:36px;height:36px;border-radius:50%;background:rgba(10,14,22,.9);
            border:1px solid ${token ? "#22c55e" : "rgba(255,255,255,.15)"};color:${token ? "#22c55e" : "#64748b"};
            cursor:pointer;display:flex;align-items:center;justify-content:center;
            box-shadow:0 4px 12px rgba(0,0,0,.5);transition:all .2s;`;
        trigger.onmouseenter = () => { trigger.style.transform = "scale(1.1)"; };
        trigger.onmouseleave = () => { trigger.style.transform = ""; };
        trigger.addEventListener("click", () => toggleSettingsPanel());

        panel.appendChild(trigger);
        document.body.appendChild(panel);
    }

    function toggleSettingsPanel() {
        const existing = document.getElementById("simkl-settings-panel");
        if (existing) { existing.remove(); panelVisible = false; return; }
        panelVisible = true;
        openSettingsPanel();
    }

    function openSettingsPanel() {
        document.getElementById("simkl-settings-panel")?.remove();
        const token   = GM_getValue(STORE_TOKEN, null);
        const cacheTs = GM_getValue(STORE_CACHE_TS, 0);
        const cacheAge = cacheTs ? Math.round((Date.now() - cacheTs) / 60000) : null;
        const rawCache = GM_getValue(STORE_WATCHED, "[]");
        let cachedCount = 0;
        try { cachedCount = JSON.parse(rawCache).length; } catch {}

        const sp = document.createElement("div");
        sp.id = "simkl-settings-panel";
        sp.style.cssText = `position:fixed;bottom:64px;left:20px;z-index:1999998;
            background:#0a0e16;border:1px solid rgba(255,255,255,.09);border-radius:12px;
            width:280px;color:#e2e8f0;font-family:system-ui,sans-serif;
            box-shadow:0 16px 40px rgba(0,0,0,.7);overflow:hidden;`;

        const rowStyle = "display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-top:1px solid rgba(255,255,255,.05);";
        const btnStyle = (bg, color, border) =>
            `padding:6px 12px;background:${bg};color:${color};border:1px solid ${border};border-radius:7px;cursor:pointer;font-size:11.5px;font-weight:600;font-family:inherit;`;

        sp.innerHTML = `
        <div style="padding:12px 14px;background:linear-gradient(105deg,rgba(34,197,94,.08),transparent);
            display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.07);">
            <div style="display:flex;align-items:center;gap:8px;">
                <span style="width:6px;height:6px;border-radius:50%;background:${token ? '#22c55e' : '#64748b'};
                    box-shadow:${token ? '0 0 6px rgba(34,197,94,.8)' : 'none'};display:inline-block;"></span>
                <span style="font-size:12px;font-weight:700;letter-spacing:.1em;">SIMKL WATCHED</span>
            </div>
            <button id="simkl-sp-close" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:14px;">✕</button>
        </div>

        <div style="padding:10px 14px;font-size:12px;">
            <div style="color:#64748b;margin-bottom:2px;">Estado</div>
            <div style="color:${token ? '#86efac' : '#f87171'};">${token ? '● Autenticado' : '○ Não ligado'}</div>
            ${cacheAge !== null ? `<div style="color:#475569;font-size:11px;margin-top:2px;">${cachedCount} títulos · cache há ${cacheAge < 60 ? cacheAge + 'm' : Math.round(cacheAge/60) + 'h'}</div>` : ''}
        </div>

        <div style="${rowStyle}">
            <span style="font-size:12px;">Overlay ativo</span>
            <button id="simkl-toggle" style="${btnStyle(isEnabled ? 'rgba(34,197,94,.2)' : 'rgba(255,255,255,.05)', isEnabled ? '#86efac' : '#94a3b8', isEnabled ? 'rgba(34,197,94,.3)' : 'rgba(255,255,255,.1)')}">
                ${isEnabled ? 'Ligado' : 'Desligado'}
            </button>
        </div>

        <div style="${rowStyle}">
            <span style="font-size:12px;">Sincronizar agora</span>
            <button id="simkl-sync-btn" style="${btnStyle('rgba(37,99,235,.2)', '#93c5fd', 'rgba(37,99,235,.3)')}">Sync</button>
        </div>

        ${!token ? `
        <div style="${rowStyle}">
            <span style="font-size:12px;">Ligar ao Simkl</span>
            <button id="simkl-login-btn" style="${btnStyle('rgba(34,197,94,.2)', '#86efac', 'rgba(34,197,94,.35)')}">Login</button>
        </div>` : `
        <div style="${rowStyle}">
            <span style="font-size:12px;color:#64748b;">Sessão</span>
            <button id="simkl-logout-btn" style="${btnStyle('rgba(239,68,68,.1)', '#fca5a5', 'rgba(239,68,68,.2)')}">Logout</button>
        </div>`}

        <div style="padding:8px 14px;font-size:10px;color:#334155;border-top:1px solid rgba(255,255,255,.04);">
            Cache renova a cada 6h. Hover nos cards → ✏ para definir ID manual.
        </div>`;

        document.body.appendChild(sp);

        sp.querySelector("#simkl-sp-close").onclick = () => { sp.remove(); panelVisible = false; };

        sp.querySelector("#simkl-toggle").onclick = () => {
            isEnabled = !isEnabled;
            GM_setValue(STORE_ENABLED, isEnabled);
            if (isEnabled) { applyOverlaysToPage(); }
            else { document.querySelectorAll(".simkl-badge, .simkl-badge-edit").forEach(el => el.remove()); }
            sp.remove(); panelVisible = false;
            openSettingsPanel();
        };

        sp.querySelector("#simkl-sync-btn").onclick = async () => {
            sp.remove(); panelVisible = false;
            await syncWatched(true);
            injectPanel();
        };

        sp.querySelector("#simkl-login-btn")?.addEventListener("click", async () => {
            sp.remove(); panelVisible = false;
            const ok = await login((msg) => toast(msg));
            if (ok) await syncWatched(true);
            injectPanel();
        });

        sp.querySelector("#simkl-logout-btn")?.addEventListener("click", () => {
            GM_setValue(STORE_TOKEN, null);
            watchedSet.clear();
            document.querySelectorAll(".simkl-badge, .simkl-badge-edit").forEach(el => el.remove());
            sp.remove(); panelVisible = false;
            toast("Simkl desligado.");
            injectPanel();
        });
    }

    // ════════════════════════════════════════════════════════════════════════
    //  MUTATION OBSERVER — apanha cards carregados via scroll infinito
    // ════════════════════════════════════════════════════════════════════════
    function watchDOMChanges() {
        let debounce = null;
        const obs = new MutationObserver(() => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                if (isEnabled && watchedSet.size > 0) applyOverlaysToPage();
            }, 400);
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    //  INIT
    // ════════════════════════════════════════════════════════════════════════
    async function init() {
        // Validação básica
        if (!IS_FT && !IS_FM) return;
        if (!SIMKL_CLIENT_ID || SIMKL_CLIENT_ID === "COLOCA_AQUI_O_SEU_CLIENT_ID") {
            console.warn("[Simkl Watched] CLIENT_ID não configurado. Edita o script.");
            return;
        }

        // Carregar estado
        isEnabled = GM_getValue(STORE_ENABLED, true);
        loadOverrides();

        // UI
        injectToastCSS();
        injectOverlayCSS();
        injectPanel();
        watchDOMChanges();

        // Carregar watched (cache ou API)
        const token = GM_getValue(STORE_TOKEN, null);
        if (token) {
            await syncWatched(false); // usa cache se fresco
        }
    }

    init();

})();
