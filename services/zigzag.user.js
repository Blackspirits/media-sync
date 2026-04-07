// ==UserScript==
// @name         RTP Play Zig Zag — Master Manager v1
// @namespace    leinad4mind.github.io
// @version      1.0.0
// @description  Versão Final: Dashboard, Gestão de API, Deep Scrape, Cloud Sync e correção de duplicados.
// @author       Leinad4Mind
// @match        https://www.rtp.pt/play/zigzag/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// ==/UserScript==

(() => {
    "use strict";

    /* =====================================================================
       CONSTANTES E CONFIGURAÇÕES
       ===================================================================== */
    const STORE_CATALOG = "zigzag_catalog";
    const STORE_SELECTED = "zigzag_selected_ids";
    const STORE_LOCAL = "zigzag_local_ids";
    const STORE_HIDE_LOCAL = "zigzag_hide_local_flag";
    const STORE_API_CONFIGS = "zigzag_api_configs";
    const UI_POS_KEY = "zigzag_ui_pos";
    const UI_MIN_KEY = "zigzag_ui_min";
    const IMG_DB_NAME = "zigzag_img_db";

    const ACCENT_COLOR = "#f97316";
    let hideLocalFlag = GM_getValue(STORE_HIDE_LOCAL, false);
    let isPendingTransferConfirm = false;

    /* =====================================================================
       UTILITÁRIOS DE DADOS E ENCRIPTAÇÃO
       ===================================================================== */
    function __obf(str) {
        const key = "ZIGZAG_MASTER_KEY_2026";
        const bytes = new TextEncoder().encode(str);
        const kbytes = new TextEncoder().encode(key);
        const out = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ kbytes[i % kbytes.length];
        return btoa(String.fromCharCode(...out));
    }

    function __deobf(b64) {
        try {
            const key = "ZIGZAG_MASTER_KEY_2026";
            const bin = atob(b64);
            const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
            const kbytes = new TextEncoder().encode(key);
            const out = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ kbytes[i % kbytes.length];
            return new TextDecoder().decode(out);
        } catch { return b64; }
    }

    const getStored = (k) => {
        try {
            let val = GM_getValue(k);
            if (!val) val = localStorage.getItem(k);
            if (!val) return [];
            const parsed = JSON.parse(val);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) { return []; }
    };

    const setStored = (k, v) => {
        try {
            const json = JSON.stringify(v);
            localStorage.setItem(k, json);
            GM_setValue(k, json);
        } catch (e) { }
    };

    const getZZID = (url) => {
        try {
            const parts = new URL(url, location.origin).pathname.split('/').filter(Boolean);
            return parts.slice(-2).join('_').replace(/_+$/, '');
        } catch { return "id_" + Math.random().toString(36).substr(2, 9); }
    };

    const addToCatalog = (id, url, title, poster) => {
        let cat = getStored(STORE_CATALOG);
        if (!cat.find(i => i.id === id)) {
            cat.push({ id, url, title, poster, parentId: url.includes('/e') ? null : id, saved_at: Date.now() });
            setStored(STORE_CATALOG, cat);
            if (poster) saveImageToCache(poster);
        }
    };

    /* =====================================================================
       LÓGICA DE INTEGRIDADE (Série vs Episódios)
       ===================================================================== */
    function checkProgramCompletion(programId) {
        const catalog = getStored(STORE_CATALOG);
        const local = new Set(getStored(STORE_LOCAL));
        const programEps = catalog.filter(item => item.parentId === programId);
        if (programEps.length === 0) return false;
        return programEps.every(ep => local.has(ep.id));
    }

    /* =====================================================================
       SISTEMA DE IMAGENS (IndexedDB)
       ===================================================================== */
    let _db;
    const initDB = () => new Promise(res => {
        const req = indexedDB.open(IMG_DB_NAME, 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore("images");
        req.onsuccess = e => { _db = e.target.result; res(); };
    });

    const getCachedImageURL = (url) => new Promise(res => {
        if (!_db || !url || url.startsWith('blob:')) return res(url);
        const tx = _db.transaction("images", "readonly");
        const req = tx.objectStore("images").get(url);
        req.onsuccess = () => res(req.result ? URL.createObjectURL(req.result) : url);
        req.onerror = () => res(url);
    });

    const saveImageToCache = (url) => {
        if (!url || url.startsWith('blob:')) return;
        GM_xmlhttpRequest({
            method: "GET", url, responseType: "blob",
            onload: r => {
                if (r.status === 200 && _db) {
                    const tx = _db.transaction("images", "readwrite");
                    tx.objectStore("images").put(r.response, url);
                }
            }
        });
    };

    /* =====================================================================
       CLOUD SYNC
       ===================================================================== */
    function getApiConfigs() {
        const raw = GM_getValue(STORE_API_CONFIGS, "[]");
        if (raw === "[]") return [];
        try { return JSON.parse(raw.startsWith("[") ? raw : __deobf(raw)); } catch { return []; }
    }

    async function saveToCloud() {
        const configs = getApiConfigs();
        let success = 0;
        for (const api of configs) {
            if (!api.apiKey) continue;
            try {
                const payload = { [STORE_CATALOG]: getStored(STORE_CATALOG), [STORE_LOCAL]: getStored(STORE_LOCAL), [STORE_SELECTED]: getStored(STORE_SELECTED) };
                const res = await fetch(api.url, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": api.apiKey }, body: JSON.stringify(payload) });
                if (res.ok) success++;
            } catch (e) { console.error(e); }
        }
        if (success > 0) toast(`Sincronizado com ${success} Nuvem(s)`);
    }

    /* =====================================================================
       DEEP SCAN & DEEP COPY
       ===================================================================== */
    async function runDeepScan() {
        const btn = document.getElementById('zz-main-action');
        btn.disabled = true;
        toast("A capturar catálogo total...");

        let catalogMap = new Map(getStored(STORE_CATALOG).map(i => [i.id, i]));
        let lastHeight = 0, sameCount = 0;

        const interval = setInterval(async () => {
            window.scrollTo(0, document.body.scrollHeight);

            document.querySelectorAll('article').forEach(art => {
                const a = art.querySelector('a');
                if (!a || !a.href.includes('/zigzag/')) return;

                const url = new URL(a.href, location.origin).href;
                const id = getZZID(url);
                if (!catalogMap.has(id)) {
                    catalogMap.set(id, {
                        id, parentId: url.includes('/e') ? null : id, url,
                        title: art.querySelector('.program-name, h4')?.textContent.trim() || "Sem Título",
                        date: art.querySelector('.episode-date')?.textContent.trim() || "",
                        poster: art.querySelector('img')?.src || "",
                        saved_at: Date.now()
                    });
                    if (art.querySelector('img')?.src) saveImageToCache(art.querySelector('img')?.src);
                }
            });

            btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;">${ICONS.cloud}<span>A ler... (${catalogMap.size})</span></span>`;
            let cur = document.body.scrollHeight;
            if (cur === lastHeight) sameCount++; else { sameCount = 0; lastHeight = cur; }

            if (sameCount >= 4) {
                clearInterval(interval);
                setStored(STORE_CATALOG, Array.from(catalogMap.values()));
                await saveToCloud();
                btn.disabled = false;
                btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;">${ICONS.cloud}<span>Guardar catálogo + Nuvem</span></span>`;
                toast("Catálogo atualizado e sincronizado!");
                highlightCards(); updateStats();
            }
        }, 1200);
    }

    async function copyDeepScrapeLinks() {
        const selectedIds = getStored(STORE_SELECTED);
        const catalog = getStored(STORE_CATALOG);
        const targets = catalog.filter(item => selectedIds.includes(item.id));

        if (!targets.length) return alert("Selecione (✓) os programas ou episódios primeiro!");

        const btn = document.getElementById('zz-copy-action');
        const originalContent = btn.innerHTML;
        btn.disabled = true;

        let allLinks = [];
        let updatedCatalog = [...catalog];

        const extractParts = (doc, baseUrl) => {
            let activeEl = doc.querySelector('.section-parts ul.parts li.active span, .section-parts ul.parts li.active a');
            let activeName = activeEl ? activeEl.textContent.trim() : "PARTE 1";
            let links = [{ url: baseUrl, name: activeName }];
            doc.querySelectorAll('.section-parts ul.parts li:not(.active) a').forEach(a => {
                if (a.href) links.push({ url: new URL(a.href, location.origin).href, name: a.textContent.trim() });
            });
            return links;
        };

        for (let i = 0; i < targets.length; i++) {
            btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;">${ICONS.copy}<span>Scraping ${i + 1}/${targets.length}...</span></span>`;
            try {
                const targetUrl = targets[i].url;

                if (targetUrl.includes('/e')) {
                    // É um episódio (selecionado nativamente)
                    const res = await fetch(targetUrl);
                    const text = await res.text();
                    const doc = new DOMParser().parseFromString(text, "text/html");

                    const parts = extractParts(doc, targetUrl);
                    parts.forEach(p => { 
                        if (!allLinks.includes(p.url)) allLinks.push(p.url); 
                        const pId = getZZID(p.url);
                        if (!updatedCatalog.find(c => c.id === pId)) {
                            updatedCatalog.push({
                                id: pId, parentId: targets[i].parentId || targets[i].id, url: p.url,
                                title: targets[i].title + (parts.length > 1 ? ` (${p.name})` : ''),
                                poster: targets[i].poster, saved_at: Date.now()
                            });
                        }
                    });

                } else {
                    // É um programa (abrimos iframe para renderizar todos os ajax e infinite scroll)
                    btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;">${ICONS.cloud}<span>A varrer listagem inteira (${i + 1}/${targets.length})...</span></span>`;

                    const epLinks = await new Promise(resolve => {
                        const iframe = document.createElement('iframe');
                        iframe.style.cssText = "width:10px;height:10px;position:absolute;top:-9999px;opacity:0;";
                        document.body.appendChild(iframe);

                        iframe.onload = () => {
                            try {
                                const idoc = iframe.contentWindow.document;
                                let lastH = 0, sameCount = 0;

                                const iv = setInterval(() => {
                                    iframe.contentWindow.scrollTo(0, idoc.body.scrollHeight);
                                    let btnMore = idoc.querySelector('.btn-carregar-mais, #loadMore');
                                    if (btnMore) btnMore.click();

                                    let cur = idoc.body.scrollHeight;
                                    if (cur === lastH) {
                                        sameCount++;
                                    } else {
                                        sameCount = 0;
                                        lastH = cur;
                                    }

                                    if (sameCount >= 4) {
                                        clearInterval(iv);
                                        let epMap = new Map();
                                        idoc.querySelectorAll('a').forEach(a => {
                                            const href = a.getAttribute('href');
                                            if (!href || !href.includes('/zigzag/') || !href.match(/\/e\d+/)) return;

                                            let fullUrl = new URL(href, location.origin).href.split('?')[0].split('#')[0];
                                            if (!epMap.has(fullUrl)) {
                                                let container = a.closest('article, div');
                                                epMap.set(fullUrl, {
                                                    url: fullUrl,
                                                    title: container?.querySelector('.program-name, h4')?.textContent.trim() || a.textContent.trim() || "Episódio",
                                                    poster: container?.querySelector('img')?.src || ""
                                                });
                                            }
                                        });
                                        iframe.remove();
                                        resolve(Array.from(epMap.values()));
                                    }
                                }, 1000);
                            } catch (e) {
                                iframe.remove(); resolve([]);
                            }
                        };
                        iframe.src = targetUrl;
                    });

                    // Para cada episódio escavado, vamos confirmar se tem partes
                    for (let j = 0; j < epLinks.length; j++) {
                        btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;">${ICONS.copy}<span>S ${i + 1}/${targets.length} (Ep ${j + 1}/${epLinks.length})</span></span>`;
                        try {
                            const epRes = await fetch(epLinks[j].url);
                            const epText = await epRes.text();
                            const epDoc = new DOMParser().parseFromString(epText, "text/html");

                            const parts = extractParts(epDoc, epLinks[j].url);
                            parts.forEach(p => { 
                                if (!allLinks.includes(p.url)) allLinks.push(p.url); 
                                const pId = getZZID(p.url);
                                if (!updatedCatalog.find(c => c.id === pId)) {
                                    updatedCatalog.push({
                                        id: pId, parentId: targets[i].id, url: p.url,
                                        title: epLinks[j].title + (parts.length > 1 ? ` (${p.name})` : ''),
                                        poster: epLinks[j].poster, saved_at: Date.now()
                                    });
                                }
                            });
                        } catch (e) { }
                        await new Promise(r => setTimeout(r, 600)); // previne bloqueio de rate-limit
                    }
                }
            } catch (e) { }
        }

        setStored(STORE_CATALOG, updatedCatalog);
        GM_setClipboard(allLinks.join('\n'), "text");
        toast(`${allLinks.length} links copiados!`);

        isPendingTransferConfirm = true;
        btn.disabled = false;
        btn.innerHTML = originalContent;
        renderButtons();
    }

    function confirmTransfer() {
        const selectedIds = getStored(STORE_SELECTED);
        const catalog = getStored(STORE_CATALOG);
        let local = new Set(getStored(STORE_LOCAL));

        catalog.forEach(item => {
            if (selectedIds.includes(item.parentId) || selectedIds.includes(item.id)) {
                local.add(item.id);
            }
        });

        setStored(STORE_LOCAL, Array.from(local));
        setStored(STORE_SELECTED, []);
        isPendingTransferConfirm = false;
        toast("Transferência confirmada!");
        renderButtons(); highlightCards(); updateStats(); saveToCloud();
    }

    /* =====================================================================
       UI E DESIGN (ÍCONES SVG)
       ===================================================================== */
    const ICONS = {
        cloud: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`,
        copy: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
        local: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
        check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
        eye: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
        eyeOff: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
        api: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
        min: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
        max: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`,
        dash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
    };

    function toast(msg) {
        let c = document.getElementById("zz-toast-container");
        if (!c) { c = document.createElement("div"); c.id = "zz-toast-container"; c.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:1000001;display:flex;flex-direction:column;gap:8px;pointer-events:none;"; document.body.appendChild(c); }
        const t = document.createElement("div");
        t.style.cssText = `background:rgba(10,14,22,.97);color:#f1f5f9;padding:12px 20px;border-radius:10px;font-size:13px;font-weight:600;border-left:4px solid ${ACCENT_COLOR};box-shadow:0 8px 24px rgba(0,0,0,.5);backdrop-filter:blur(8px);pointer-events:auto;font-family:system-ui;`;
        t.textContent = msg; c.appendChild(t);
        setTimeout(() => t.remove(), 4000);
    }

    /* =====================================================================
       HIGHLIGHT DE CARDS
       ===================================================================== */
    function highlightCards() {
        const selected = new Set(getStored(STORE_SELECTED));
        const local = new Set(getStored(STORE_LOCAL));

        document.querySelectorAll('article').forEach(card => {
            const a = card.querySelector('a');
            if (!a || !a.href.includes('/zigzag/')) return;

            const url = new URL(a.href, location.origin).href;
            const id = getZZID(url);

            const isEpisode = url.includes('/e');
            const isLocal = isEpisode ? local.has(id) : checkProgramCompletion(id);
            const isSelected = selected.has(id);

            if (isLocal && hideLocalFlag) { card.style.display = "none"; return; }
            else card.style.display = "";

            card.style.transition = "all 0.3s ease";
            card.style.opacity = isLocal ? "0.35" : (isSelected ? "0.7" : "1");
            card.style.boxShadow = isLocal ? "inset 0 0 0 3px #3b82f6" : (isSelected ? `inset 0 0 0 2px ${ACCENT_COLOR}` : "none");

            if (window.getComputedStyle(card).position === 'static') card.style.position = 'relative';

            // Botão Seleção (Verde ✓)
            let bS = card.querySelector(':scope > .zz-btn-sel');
            if (!bS) {
                bS = document.createElement('div'); bS.className = 'zz-btn-sel'; bS.innerHTML = '✓';
                bS.style.cssText = `position:absolute;top:10px;right:10px;z-index:100;width:30px;height:30px;color:white;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;border:2px solid white;font-weight:bold;`;

                bS.onclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    addToCatalog(id, url, card.querySelector('.program-name, h4')?.textContent.trim(), card.querySelector('img')?.src);
                    let s = getStored(STORE_SELECTED);
                    if (s.includes(id)) s = s.filter(i => i !== id); else s.push(id);
                    setStored(STORE_SELECTED, s);
                    highlightCards(); updateStats(); renderButtons();
                };
                card.appendChild(bS);
            }
            bS.style.background = isSelected ? "#10b981" : "rgba(0,0,0,0.6)";

            // Botão Local (Azul 📥)
            let bL = card.querySelector(':scope > .zz-btn-local');
            if (!bL) {
                bL = document.createElement('div'); bL.className = 'zz-btn-local'; bL.innerHTML = ICONS.local;
                bL.style.cssText = `position:absolute;top:10px;right:48px;z-index:100;width:30px;height:30px;color:white;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;border:2px solid white;`;

                bL.onclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    addToCatalog(id, url, card.querySelector('.program-name, h4')?.textContent.trim(), card.querySelector('img')?.src);
                    let l = getStored(STORE_LOCAL);
                    if (l.includes(id)) l = l.filter(i => i !== id); else l.push(id);
                    setStored(STORE_LOCAL, l);
                    highlightCards(); updateStats(); saveToCloud();
                };
                card.appendChild(bL);
            }
            bL.style.background = isLocal ? "#3b82f6" : "rgba(0,0,0,0.6)";
            bL.style.display = isEpisode ? "flex" : "none";
        });
    }

    /* =====================================================================
       PAINEL E BOTÕES DINÂMICOS
       ===================================================================== */
    function renderButtons() {
        const container = document.getElementById("zz-dynamic-actions");
        if (!container) return;
        container.innerHTML = "";

        const makeBtn = (label, icon, onClick, color, id) => {
            const b = document.createElement("button"); if (id) b.id = id;
            b.style.cssText = `padding:12px;background:rgba(255,255,255,.04);color:#e2e8f0;border:1px solid rgba(255,255,255,.08);border-left:3px solid ${color};border-radius:10px;cursor:pointer;text-align:left;font-size:12px;font-weight:600;display:flex;align-items:center;gap:10px;transition:0.2s;width:100%;margin-bottom:5px;font-family:inherit;`;
            b.innerHTML = `${icon}<span>${label}</span>`;
            b.onmouseover = () => b.style.background = "rgba(255,255,255,.08)";
            b.onmouseout = () => b.style.background = "rgba(255,255,255,.04)";
            b.onclick = onClick; return b;
        };

        const currentSelected = getStored(STORE_SELECTED).length;

        if (isPendingTransferConfirm) {
            const confirmRow = document.createElement("div");
            confirmRow.style.cssText = "display:flex;gap:5px;margin-bottom:5px;";

            const btnConfirm = makeBtn("Marcar transferidos", ICONS.check, confirmTransfer, "#10b981");
            btnConfirm.style.flex = "2";

            const btnCancel = makeBtn("Cancelar", ICONS.copy, () => { isPendingTransferConfirm = false; setStored(STORE_SELECTED, []); renderButtons(); highlightCards(); updateStats(); }, "#ef4444");
            btnCancel.style.flex = "1"; btnCancel.querySelector('span').textContent = "Limpar";

            confirmRow.append(btnConfirm, btnCancel);
            container.appendChild(confirmRow);
        } else if (currentSelected > 0) {
            container.appendChild(makeBtn("Copiar links (Deep Scrape)", ICONS.copy, copyDeepScrapeLinks, "#8b5cf6", "zz-copy-action"));
        }
    }

    function updateStats() {
        const grid = document.getElementById("zz-stats-grid");
        if (!grid) return;
        const cell = (icon, val, label, col) => `<div style="padding:6px;background:rgba(255,255,255,.03);border-radius:8px;text-align:center;border:1px solid rgba(255,255,255,0.02);"><div style="display:flex;align-items:center;justify-content:center;gap:4px;color:${col};"><span style="line-height:0">${icon}</span><span style="font-size:14px;font-weight:800;color:#fff;">${val}</span></div><div style="font-size:8px;color:#64748b;text-transform:uppercase;font-weight:700;letter-spacing:0.02em;">${label}</div></div>`;
        grid.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px;width:100%;">${cell(ICONS.cloud, getStored(STORE_CATALOG).length, "DB", "#94a3b8")}${cell(ICONS.copy, getStored(STORE_SELECTED).length, "Sel", ACCENT_COLOR)}${cell(ICONS.local, getStored(STORE_LOCAL).length, "Loc", "#3b82f6")}</div>`;
    }

    function injectUI() {
        if (document.getElementById("zz-master-panel")) return;
        const pos = JSON.parse(GM_getValue(UI_POS_KEY, '{"bottom":20,"right":20}'));
        const isMin = GM_getValue(UI_MIN_KEY, false);

        const panel = document.createElement("div"); panel.id = "zz-master-panel";
        panel.style.cssText = `position:fixed;z-index:999999;width:${isMin ? '180px' : '320px'};background:rgba(8,12,20,.96);border:1px solid rgba(255,255,255,.09);border-radius:16px;box-shadow:0 15px 50px rgba(0,0,0,0.6);backdrop-filter:blur(15px);font-family:system-ui,-apple-system,sans-serif;color:#fff;overflow:hidden;`;
        if (pos.top) panel.style.top = pos.top + "px"; else panel.style.bottom = pos.bottom + "px";
        panel.style.right = pos.right + "px";

        const header = document.createElement("div"); header.style.cssText = `padding:12px 15px;display:flex;align-items:center;justify-content:space-between;cursor:move;user-select:none;background:linear-gradient(105deg,${ACCENT_COLOR}33,transparent);border-bottom:1px solid rgba(255,255,255,.07);`;
        header.innerHTML = `<div style="display:flex;align-items:center;gap:10px;"><span style="width:8px;height:8px;border-radius:50%;background:${ACCENT_COLOR};box-shadow:0 0 10px ${ACCENT_COLOR};"></span><span style="font-weight:900;font-size:12px;letter-spacing:0.12em;">ZIG ZAG</span></div><div id="zz-ui-toggles" style="display:flex;gap:5px;"></div>`;

        const body = document.createElement("div"); body.id = "zz-panel-body"; body.style.cssText = `padding:15px;display:${isMin ? 'none' : 'flex'};flex-direction:column;gap:10px;`;

        const hideBtn = document.createElement("div"); hideBtn.style.cssText = "width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.05);border-radius:6px;cursor:pointer;";
        const updateHideBtn = () => { hideBtn.innerHTML = hideLocalFlag ? ICONS.eyeOff : ICONS.eye; hideBtn.style.color = hideLocalFlag ? ACCENT_COLOR : "#94a3b8"; };
        updateHideBtn();
        hideBtn.onclick = () => { hideLocalFlag = !hideLocalFlag; GM_setValue(STORE_HIDE_LOCAL, hideLocalFlag); updateHideBtn(); highlightCards(); };

        const minBtn = document.createElement("div"); minBtn.style.cssText = "width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.05);border-radius:6px;cursor:pointer;color:#94a3b8;";
        minBtn.innerHTML = isMin ? ICONS.max : ICONS.min;
        minBtn.onclick = () => { const now = body.style.display !== 'none'; body.style.display = now ? 'none' : 'flex'; panel.style.width = now ? '180px' : '320px'; minBtn.innerHTML = now ? ICONS.max : ICONS.min; GM_setValue(UI_MIN_KEY, now); };

        header.querySelector("#zz-ui-toggles").append(hideBtn, minBtn);

        const statsGrid = document.createElement("div"); statsGrid.id = "zz-stats-grid";
        const actionArea = document.createElement("div"); actionArea.id = "zz-dynamic-actions";

        const staticActions = document.createElement("div");
        const makeBtn = (label, icon, onClick, color, id) => {
            const b = document.createElement("button"); if (id) b.id = id;
            b.style.cssText = `padding:12px;background:rgba(255,255,255,.04);color:#e2e8f0;border:1px solid rgba(255,255,255,.08);border-left:3px solid ${color};border-radius:10px;cursor:pointer;text-align:left;font-size:12px;font-weight:600;display:flex;align-items:center;gap:10px;transition:0.2s;width:100%;margin-bottom:5px;font-family:inherit;`;
            b.innerHTML = `${icon}<span>${label}</span>`;
            b.onmouseover = () => b.style.background = "rgba(255,255,255,.08)";
            b.onmouseout = () => b.style.background = "rgba(255,255,255,.04)";
            b.onclick = onClick; return b;
        };

        staticActions.append(
            makeBtn("Guardar catálogo + Nuvem", ICONS.cloud, runDeepScan, ACCENT_COLOR, "zz-main-action"),
            makeBtn("Gerir APIs Cloud", ICONS.api, openApiManagerUI, "#6366f1", "zz-api-action"),
            makeBtn("Visualizar Dashboard", ICONS.dash, openDashboard, "#10b981", "zz-dash-action")
        );

        body.append(statsGrid, actionArea, staticActions);
        panel.append(header, body);
        document.body.appendChild(panel);

        renderButtons();
        updateStats();

        // DRAG
        let isDragging = false, sX, sY, sR, sT, sB;
        header.onmousedown = (e) => {
            if (e.target.closest('#zz-ui-toggles')) return;
            isDragging = true; sX = e.clientX; sY = e.clientY; sR = parseInt(panel.style.right); sT = panel.style.top ? parseInt(panel.style.top) : null; sB = panel.style.bottom ? parseInt(panel.style.bottom) : null;
            document.onmousemove = (ev) => { if (!isDragging) return; panel.style.right = (sR + (sX - ev.clientX)) + "px"; if (sT !== null) panel.style.top = (sT + (ev.clientY - sY)) + "px"; else panel.style.bottom = (sB + (sY - ev.clientY)) + "px"; };
            document.onmouseup = () => { isDragging = false; document.onmousemove = null; GM_setValue(UI_POS_KEY, JSON.stringify({ right: parseInt(panel.style.right), top: panel.style.top ? parseInt(panel.style.top) : null, bottom: panel.style.bottom ? parseInt(panel.style.bottom) : null })); };
        };
    }

    /* =====================================================================
       DASHBOARD & API MANAGER (MODAL)
       ===================================================================== */
    function openApiManagerUI() {
        document.getElementById("zz-cloud-api-mgr")?.remove();
        const mod = document.createElement("div"); mod.id = "zz-cloud-api-mgr";
        mod.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:2000000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);font-family:system-ui;`;
        const box = document.createElement("div");
        box.style.cssText = `background:#0a0e16;border:1px solid rgba(255,255,255,.1);width:600px;border-radius:16px;color:#e2e8f0;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.7);`;

        const renderList = () => {
            const configs = getApiConfigs();
            let listHtml = configs.map((api, idx) => `<div style="background:rgba(255,255,255,.03);padding:12px;border-radius:10px;margin-bottom:8px;border:1px solid rgba(255,255,255,.06);display:flex;justify-content:space-between;align-items:center;"><div><div style="font-size:13px;font-weight:700;color:${ACCENT_COLOR};">${api.name}</div><div style="font-size:10px;color:#475569;">${api.url}</div></div><button class="zz-api-del" data-idx="${idx}" style="background:rgba(220,38,38,.2);color:#fca5a5;border:none;padding:5px 10px;border-radius:6px;cursor:pointer;">Remover</button></div>`).join('');
            box.innerHTML = `<div style="padding:16px;border-bottom:1px solid rgba(255,255,255,.07);font-weight:800;background:linear-gradient(105deg,${ACCENT_COLOR}22,transparent);">GERIR APIs CLOUD</div><div style="padding:20px;"><div id="zz-api-list">${listHtml || '<div style="text-align:center;font-size:12px;color:#64748b;">Nenhuma nuvem ligada.</div>'}</div><div style="margin-top:15px;padding-top:15px;border-top:1px solid rgba(255,255,255,0.05);"><input id="new-api-n" placeholder="Nome" style="width:100%;padding:8px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:#fff;margin-bottom:8px;"><input id="new-api-u" placeholder="URL Worker" style="width:100%;padding:8px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:#fff;margin-bottom:8px;"><input id="new-api-k" type="password" placeholder="API Key" style="width:100%;padding:8px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:#fff;margin-bottom:15px;"><div style="display:flex;gap:8px;"><button id="zz-save-api" style="flex:1;padding:10px;background:${ACCENT_COLOR};border:none;border-radius:8px;font-weight:bold;cursor:pointer;color:#fff;">Guardar</button><button id="zz-close-mgr" style="padding:10px;background:#334155;border:none;border-radius:8px;cursor:pointer;color:#fff;">Fechar</button></div></div></div>`;
            box.querySelector("#zz-close-mgr").onclick = () => mod.remove();
            box.querySelector("#zz-save-api").onclick = () => { const n = box.querySelector("#new-api-n").value, u = box.querySelector("#new-api-u").value, k = box.querySelector("#new-api-k").value; if (n && u) { configs.push({ name: n, url: u, apiKey: k }); GM_setValue(STORE_API_CONFIGS, __obf(JSON.stringify(configs))); renderList(); } };
            box.querySelectorAll(".zz-api-del").forEach(b => b.onclick = () => { configs.splice(b.dataset.idx, 1); GM_setValue(STORE_API_CONFIGS, __obf(JSON.stringify(configs))); renderList(); });
        };
        renderList(); mod.appendChild(box); document.body.appendChild(mod);
    }

    async function openDashboard() {
        const overlay = document.createElement('div');
        overlay.style.cssText = "position:fixed;inset:0;background:#060c18;z-index:2000000;padding:40px;overflow-y:auto;color:white;font-family:system-ui,sans-serif;";
        document.body.appendChild(overlay);

        const items = getStored(STORE_CATALOG);
        const selIds = getStored(STORE_SELECTED);
        const locIds = getStored(STORE_LOCAL);

        const isSelected = (id) => selIds.includes(id);
        const isLocal = (id) => locIds.includes(id);
        const close = () => overlay.remove();

        const cardsHtml = await Promise.all(items.map(async item => {
            const displayImg = await getCachedImageURL(item.poster) || item.poster;
            const styleOpac = isLocal(item.id) ? 0.5 : 1;

            let badges = '';
            if (isLocal(item.id)) badges += `<div style="background:#3b82f6;color:white;padding:2px 8px;border-radius:5px;font-size:10px;font-weight:bold;">COLEÇÃO</div>`;
            if (isSelected(item.id)) badges += `<div style="background:#10b981;color:white;padding:2px 8px;border-radius:5px;font-size:10px;font-weight:bold;">SELECIONADO</div>`;

            return `
            <div style="opacity:${styleOpac};background:#1e293b;border-radius:15px;overflow:hidden;border:1px solid #334155;transition:0.3s;position:relative;">
                <div style="position:relative; aspect-ratio: 16/9; background: #000;">
                    <img src="${displayImg}" style="width:100%;height:100%;object-fit:cover;">
                    <div style="position:absolute; top:10px; right:10px; display:flex; gap:5px;">
                        ${badges}
                    </div>
                </div>
                <div style="padding:15px;">
                    <div style="font-size:14px;font-weight:bold;margin-bottom:5px;height:40px;overflow:hidden;color:#f1f5f9;">${item.title}</div>
                    <div style="font-size:11px;color:#94a3b8;margin-bottom:10px;">${item.date || 'Zig Zag'}</div>
                    <a href="${item.url}" target="_blank" style="color:${ACCENT_COLOR};text-decoration:none;font-size:12px;font-weight:bold;">▶ VER NA RTP</a>
                </div>
            </div>`;
        }));

        overlay.innerHTML = `
            <div style="max-width:1200px;margin:0 auto;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:30px;border-bottom:1px solid #1e293b;padding-bottom:20px;">
                    <h2 style="display:flex;align-items:center;gap:10px;"><span style="color:${ACCENT_COLOR}">●</span> Biblioteca Zig Zag (${items.length})</h2>
                    <button id="zz-dash-close" style="background:#ef4444;color:white;border:none;padding:10px 25px;border-radius:10px;cursor:pointer;font-weight:bold;">FECHAR</button>
                </div>
                <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));gap:25px;">
                    ${cardsHtml.join('')}
                </div>
            </div>
        `;

        overlay.querySelector('#zz-dash-close').onclick = close;
    }

    /* =====================================================================
       INIT
       ===================================================================== */
    async function init() {
        await initDB();
        injectUI();
        highlightCards();
        const obs = new MutationObserver(() => highlightCards());
        obs.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === "complete") init();
    else window.addEventListener('load', init);

})();