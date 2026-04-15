// ==UserScript==
// @name         RTP Play Zig Zag — Master Manager v3
// @namespace    leinad4mind.top/forum
// @version      3.0.0
// @description  Dashboard, Gestão de API, Deep Scrape, Cloud Sync e muito mais.
// @author       Leinad4Mind
// @match        https://www.rtp.pt/play/zigzag/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// ==/UserScript==
(function () {
    'use strict';

    // ==UserScript==
    // @name         RTP Play Zig Zag — Master Manager v3
    // @namespace    leinad4mind.top/forum
    // @version      3.0.0
    // @description  Dashboard, Gestão de API, Deep Scrape, Cloud Sync e muito mais.
    // @author       Leinad4Mind
    // @match        https://www.rtp.pt/play/zigzag/*
    // @grant        GM_getValue
    // @grant        GM_setValue
    // @grant        GM_setClipboard
    // @grant        GM_registerMenuCommand
    // @grant        GM_xmlhttpRequest
    // @grant        unsafeWindow
    // ==/UserScript==

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

        async function fetchCloudData() {
            const configs = getApiConfigs();
            if (!configs.length) return;
            let catArray = getStored(STORE_CATALOG);
            let locArray = getStored(STORE_LOCAL);
            let selArray = getStored(STORE_SELECTED);
            let updated = false;

            toast("A sincronizar dados da nuvem...");

            for (const api of configs) {
                try {
                    const hdrs = api.apiKey ? { "x-api-key": api.apiKey } : undefined;
                    const res = await fetch(`${api.url}?keys=${STORE_CATALOG},${STORE_LOCAL},${STORE_SELECTED}`, { headers: hdrs });
                    if (!res.ok) continue;
                    let data = null;
                    try { data = await res.json(); } catch (e) { continue; }

                    if (data && typeof data === 'object' && !Array.isArray(data)) {
                        if (data[STORE_LOCAL] && Array.isArray(data[STORE_LOCAL])) {
                            data[STORE_LOCAL].forEach(id => { if (!locArray.includes(id)) { locArray.push(id); updated = true; } });
                        }
                        if (data[STORE_SELECTED] && Array.isArray(data[STORE_SELECTED])) {
                            data[STORE_SELECTED].forEach(id => { if (!selArray.includes(id)) { selArray.push(id); updated = true; } });
                        }
                        if (data[STORE_CATALOG] && Array.isArray(data[STORE_CATALOG])) {
                            data[STORE_CATALOG].forEach(cItem => {
                                const extIdx = catArray.findIndex(x => x.id === cItem.id);
                                if (extIdx === -1) { catArray.push(cItem); updated = true; }
                                else if (cItem.saved_at && (!catArray[extIdx].saved_at || cItem.saved_at > catArray[extIdx].saved_at)) {
                                    catArray[extIdx] = cItem; updated = true;
                                }
                            });
                        }
                    }
                } catch (e) { console.error(`Falha a obter dados da nuvem ${api.name}:`, e); }
            }

            if (updated) {
                setStored(STORE_CATALOG, catArray);
                setStored(STORE_LOCAL, locArray);
                setStored(STORE_SELECTED, selArray);
                highlightCards();
                updateStats();
                toast("Sincronização concluída com sucesso!");
            } else {
                toast("Nuvem sincronizada (sem novos dados).");
            }
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

                document.querySelectorAll('article, a.item').forEach(art => {
                    const a = art.tagName === 'A' ? art : art.querySelector('a');
                    if (!a || !a.href.includes('/zigzag/')) return;

                    const url = new URL(a.href, location.origin).href;
                    const id = getZZID(url);
                    if (!catalogMap.has(id)) {
                        catalogMap.set(id, {
                            id, parentId: url.includes('/e') ? null : id, url,
                            title: art.querySelector('.program-name, h4')?.textContent.trim() || a.title?.replace(/Aceder a /i, '').trim() || "Sem Título",
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
                    let currentCatalog = Array.from(catalogMap.values());

                    if (confirm(`Encontrados ${currentCatalog.length} programas na vista!\nDeseja realizar um varrimento profundo (Deep Scan) dentro de TODOS eles para descobrir o número total exato de episódios e partes?\n\nNota: Este processo decorre num túnel invisível mas pode demorar alguns minutos. Não feche o separador!`)) {
                        const programsTargets = currentCatalog.filter(i => !i.url.includes('/e'));
                        const res = await backgroundSpider(programsTargets, (msg) => {
                            btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;">${ICONS.cloud}<span>${msg}</span></span>`;
                        });
                        currentCatalog = res.updatedCatalog;
                    }

                    setStored(STORE_CATALOG, currentCatalog);
                    await saveToCloud();
                    btn.disabled = false;
                    btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;">${ICONS.cloud}<span>Guardar catálogo + Nuvem</span></span>`;
                    toast("Catálogo atualizado e sincronizado na Nuvem!");
                    highlightCards(); updateStats();
                }
            }, 1200);
        }



        const extractParts = (doc, baseUrl) => {
            let activeEl = doc.querySelector('.section-parts ul.parts li.active span, .section-parts ul.parts li.active a');
            let activeName = activeEl ? activeEl.textContent.trim() : "PARTE 1";
            let links = [{ url: baseUrl, name: activeName }];
            doc.querySelectorAll('.section-parts ul.parts li:not(.active) a').forEach(a => {
                if (a.href) links.push({ url: new URL(a.href, location.origin).href, name: a.textContent.trim() });
            });
            return links;
        };

        /**
         * @param {Array} targets - items to scrape [{ url, id, title, poster, parentId }]
         * @param {Function} onProgress - callback(message)
         */
        async function backgroundSpider(targets, onProgress) {
            let updatedCatalog = [...getStored(STORE_CATALOG)];
            let allLinks = [];

            for (let i = 0; i < targets.length; i++) {
                onProgress(`A processar ${i + 1}/${targets.length}...`);
                try {
                    const targetUrl = targets[i].url;

                    if (targetUrl.includes('/e')) {
                        // É um episódio nativo
                        const res = await fetch(targetUrl);
                        const text = await res.text();
                        const doc = new DOMParser().parseFromString(text, "text/html");

                        const parts = extractParts(doc, targetUrl);
                        parts.forEach(p => {
                            if (!allLinks.includes(p.url)) allLinks.push(p.url);
                            const pId = getZZID(p.url);
                            const existingIndex = updatedCatalog.findIndex(c => c.id === pId);

                            if (existingIndex === -1) {
                                updatedCatalog.push({
                                    id: pId, parentId: targets[i].parentId || targets[i].id, url: p.url,
                                    title: targets[i].title + (parts.length > 1 ? ` (${p.name})` : ''),
                                    poster: targets[i].poster, saved_at: Date.now()
                                });
                            } else if (!updatedCatalog[existingIndex].parentId) {
                                updatedCatalog[existingIndex].parentId = targets[i].parentId || targets[i].id;
                            }
                        });

                    } else {
                        // É um programa, usar iframe para carregar infinite scroll
                        onProgress(`A indexar listagem inteira...`);

                        const epLinks = await new Promise(resolve => {
                            const iframe = document.createElement('iframe');
                            iframe.style.cssText = "width:1200px;height:800px;position:fixed;top:-10000px;left:-10000px;opacity:0.01;pointer-events:none;z-index:-1;";
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
                                        if (cur === lastH) sameCount++; else { sameCount = 0; lastH = cur; }

                                        if (sameCount >= 6) {
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
                                                        title: container?.querySelector('.program-name, h4')?.textContent.trim() || a.textContent.trim() || "Ep",
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

                        // Descobrir partes nos episódios
                        for (let j = 0; j < epLinks.length; j++) {
                            const epBaseId = getZZID(epLinks[j].url);
                            if (updatedCatalog.some(c => c.id === epBaseId && c.parentId)) {
                                continue; // Episódio já foi totalmente mapeado no passado, poupar os servidores RTP!
                            }

                            onProgress(`A extrair partes (Ep ${j + 1}/${epLinks.length})`);
                            try {
                                const epRes = await fetch(epLinks[j].url);
                                const epText = await epRes.text();
                                const epDoc = new DOMParser().parseFromString(epText, "text/html");

                                const parts = extractParts(epDoc, epLinks[j].url);
                                parts.forEach(p => {
                                    if (!allLinks.includes(p.url)) allLinks.push(p.url);
                                    const pId = getZZID(p.url);
                                    const existingIndex = updatedCatalog.findIndex(c => c.id === pId);

                                    if (existingIndex === -1) {
                                        // Novo episódio
                                        updatedCatalog.push({
                                            id: pId, parentId: targets[i].id, url: p.url,
                                            title: epLinks[j].title + (parts.length > 1 ? ` (${p.name})` : ''),
                                            poster: epLinks[j].poster, saved_at: Date.now()
                                        });
                                    } else if (!updatedCatalog[existingIndex].parentId) {
                                        // Curar episódio orfão existente injetando o parentId
                                        updatedCatalog[existingIndex].parentId = targets[i].id;
                                    }
                                });
                            } catch (e) { }
                            await new Promise(r => setTimeout(r, 600)); // Delay p/ não engasgar rate limit da RTP
                        }
                    }
                } catch (e) { }
            }

            return { allLinks, updatedCatalog };
        }

        async function copyDeepScrapeLinks() {
            const selectedIds = getStored(STORE_SELECTED);
            const catalog = getStored(STORE_CATALOG);
            const targets = catalog.filter(item => selectedIds.includes(item.id));

            if (!targets.length) return alert("Selecione (✓) os programas ou episódios primeiro!");

            const btn = document.getElementById('zz-copy-action');
            const originalContent = btn.innerHTML;
            btn.disabled = true;

            const { allLinks, updatedCatalog } = await backgroundSpider(targets, (msg) => {
                btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;">${ICONS.copy}<span>${msg}</span></span>`;
            });

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

        function updateToast(id, msg) {
            let c = document.getElementById("zz-toast-container");
            if (!c) { c = document.createElement("div"); c.id = "zz-toast-container"; c.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:1000001;display:flex;flex-direction:column;gap:8px;pointer-events:none;"; document.body.appendChild(c); }
            let t = document.getElementById(id);
            if (!t) {
                t = document.createElement("div"); t.id = id;
                t.style.cssText = `background:rgba(10,14,22,.97);color:#f1f5f9;padding:12px 20px;border-radius:10px;font-size:13px;font-weight:600;border-left:4px solid #3b82f6;box-shadow:0 8px 24px rgba(0,0,0,.5);backdrop-filter:blur(8px);pointer-events:auto;font-family:system-ui;display:flex;align-items:center;gap:10px;`;
                c.appendChild(t);
            }
            t.innerHTML = `<span style="display:inline-block;animation:spin 2s linear infinite;">⏳</span><span>${msg}</span>`;
            // Injetar keyframes de spin se não existirem
            if (!document.getElementById('zz-spin-style')) {
                const style = document.createElement('style'); style.id = 'zz-spin-style';
                style.textContent = `@keyframes spin { 100% { transform: rotate(360deg); } }`;
                document.head.appendChild(style);
            }
            return () => t.remove();
        }

        /* =====================================================================
           HIGHLIGHT DE CARDS
           ===================================================================== */
        function highlightCards() {
            const selected = new Set(getStored(STORE_SELECTED));
            const local = new Set(getStored(STORE_LOCAL));

            document.querySelectorAll('article, a.item').forEach(card => {
                const a = card.tagName === 'A' ? card : card.querySelector('a');
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
                let bS = card.querySelector('.zz-btn-sel');
                if (!bS) {
                    bS = document.createElement('div'); bS.className = 'zz-btn-sel'; bS.innerHTML = '✓';
                    bS.style.cssText = `position:absolute;top:10px;right:10px;z-index:100;width:30px;height:30px;color:white;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;border:2px solid white;font-weight:bold;`;

                    bS.onclick = (e) => {
                        e.preventDefault(); e.stopPropagation();
                        const titleRaw = card.querySelector('.program-name, h4')?.textContent.trim() || a.title?.replace(/Aceder a /i, '').trim() || "Item";
                        addToCatalog(id, url, titleRaw, card.querySelector('img')?.src);
                        let s = getStored(STORE_SELECTED);
                        if (s.includes(id)) s = s.filter(i => i !== id); else s.push(id);
                        setStored(STORE_SELECTED, s);
                        highlightCards(); updateStats(); renderButtons();
                    };

                    // Se o card for a própria âncora, os botões têm de ficar com position: absolute num parente ou no inner
                    const targetAppender = card.querySelector('.img-holder') || card;
                    targetAppender.style.position = 'relative';
                    targetAppender.appendChild(bS);
                }
                bS.style.background = isSelected ? "#10b981" : "rgba(0,0,0,0.6)";

                // Botão Local (Azul 📥)
                let bL = card.querySelector('.zz-btn-local');
                if (!bL) {
                    bL = document.createElement('div'); bL.className = 'zz-btn-local'; bL.innerHTML = ICONS.local;
                    bL.style.cssText = `position:absolute;top:10px;right:48px;z-index:100;width:30px;height:30px;color:white;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;border:2px solid white;`;

                    bL.onclick = async (e) => {
                        e.preventDefault(); e.stopPropagation();
                        const titleRaw = card.querySelector('.program-name, h4')?.textContent.trim() || a.title?.replace(/Aceder a /i, '').trim() || "Item";
                        const poster = card.querySelector('img')?.src;
                        addToCatalog(id, url, titleRaw, poster);
                        let l = getStored(STORE_LOCAL);
                        let c = getStored(STORE_CATALOG);

                        const isProgLocal = !isEpisode && checkProgramCompletion(id);

                        if (isProgLocal || l.includes(id)) {
                            // Desmarcar o Pai e TODA a linhagem
                            const dependents = new Set();
                            c.filter(child => child.parentId === id).forEach(child => {
                                dependents.add(child.id);
                                c.filter(sub => sub.url.startsWith(child.url) && sub.id !== child.id).forEach(sub => dependents.add(sub.id));
                            });
                            c.filter(p => p.url.startsWith(url) && p.id !== id).forEach(p => dependents.add(p.id));
                            const depArray = Array.from(dependents);

                            l = l.filter(i => i !== id && !depArray.includes(i));
                            setStored(STORE_LOCAL, l);
                            highlightCards(); updateStats(); saveToCloud();
                        } else {
                            // Marcar o Pai e TODA a linhagem. Corre Spider para garantir integridade.
                            bL.innerHTML = "⏳";
                            bL.style.pointerEvents = "none";

                            const target = [{ url, id, title: titleRaw, poster, parentId: isEpisode ? null : id }];
                            let closeToast = null;
                            const res = await backgroundSpider(target, (msg) => {
                                closeToast = updateToast("zz-spider-toast-" + id, msg);
                            });
                            if (closeToast) closeToast();

                            setStored(STORE_CATALOG, res.updatedCatalog);
                            c = res.updatedCatalog; // atualizar cache

                            const dependents = new Set();
                            c.filter(child => child.parentId === id).forEach(child => {
                                dependents.add(child.id);
                                c.filter(sub => sub.url.startsWith(child.url) && sub.id !== child.id).forEach(sub => dependents.add(sub.id));
                            });
                            c.filter(p => p.url.startsWith(url) && p.id !== id).forEach(p => dependents.add(p.id));
                            const depArray = Array.from(dependents);

                            if (!l.includes(id)) l.push(id);
                            depArray.forEach(d => { if (!l.includes(d)) l.push(d); });

                            setStored(STORE_LOCAL, l);

                            bL.innerHTML = ICONS.local;
                            bL.style.pointerEvents = "auto";
                            highlightCards(); updateStats(); saveToCloud();
                        }
                    };

                    const targetAppenderLayer = card.querySelector('.img-holder') || card;
                    targetAppenderLayer.style.position = 'relative';
                    targetAppenderLayer.appendChild(bL);
                }
                bL.style.background = isLocal ? "#3b82f6" : "rgba(0,0,0,0.6)";
                bL.style.display = "flex";
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

            let editIndex = -1;
            let configs = getApiConfigs();

            const generateKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');

            const renderSetup = () => {
                const api = editIndex >= 0 ? configs[editIndex] : { name: '', url: '', apiKey: '', noCopy: false, noHide: false };

                const isEdit = editIndex >= 0;
                box.innerHTML = `
            <div style="padding:20px;border-bottom:1px solid rgba(255,255,255,.07);display:flex;justify-content:space-between;align-items:center;background:linear-gradient(105deg,rgba(59,130,246,0.1),transparent);">
                <h2 style="margin:0;font-size:18px;font-weight:800;color:#f8fafc;">${isEdit ? 'Editar Automação Cloud' : 'Nova Automação Cloud'}</h2>
                <button id="zz-close-mgr" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:18px;font-weight:bold;">✖</button>
            </div>
            <div style="padding:25px;display:flex;flex-direction:column;gap:20px;">
                <!-- Passo 1 -->
                <div>
                    <div style="font-size:13px;font-weight:800;color:${ACCENT_COLOR};margin-bottom:8px;display:flex;align-items:center;gap:6px;">
                        <div style="background:rgba(59,130,246,0.2);color:#38bdf8;padding:2px 8px;border-radius:10px;font-size:10px;">PASSO 1</div> Endpoint do Worker
                    </div>
                    <div style="display:flex;gap:10px;">
                        <input id="api-n" placeholder="Nome de Referência (ex: Worker Principal)" value="${api.name}" style="flex:1;padding:12px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,.1);border-radius:10px;color:#fff;font-family:monospace;font-size:13px;">
                    </div>
                    <input id="api-u" placeholder="https://media-sync-api.teu-user.workers.dev" value="${api.url}" style="width:100%;padding:12px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,.1);border-radius:10px;color:#fff;margin-top:10px;font-family:monospace;font-size:13px;">
                </div>

                <!-- Passo 2 -->
                <div>
                    <div style="font-size:13px;font-weight:800;color:${ACCENT_COLOR};margin-bottom:8px;display:flex;align-items:center;gap:6px;justify-content:space-between;">
                        <span style="display:flex;align-items:center;gap:6px;"><div style="background:rgba(59,130,246,0.2);color:#38bdf8;padding:2px 8px;border-radius:10px;font-size:10px;">PASSO 2</div> Chave Criptográfica Secreta</span>
                        <button id="zz-gen-key" style="background:rgba(16,185,129,0.2);color:#34d399;border:1px solid rgba(16,185,129,0.3);padding:4px 10px;border-radius:8px;cursor:pointer;font-size:11px;font-weight:bold;">Gerar Nova</button>
                    </div>
                    <div style="display:flex;gap:10px;position:relative;">
                        <input id="api-k" type="password" placeholder="Key (x-api-key)" value="${api.apiKey}" style="width:100%;padding:12px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,.1);border-radius:10px;color:#fff;font-family:monospace;font-size:13px;">
                        <button id="zz-eye-pw" style="position:absolute;right:10px;top:10px;background:transparent;border:none;color:#94a3b8;cursor:pointer;">👓</button>
                    </div>
                </div>

                <!-- Passo 3 -->
                <div>
                    <div style="font-size:13px;font-weight:800;color:${ACCENT_COLOR};margin-bottom:8px;display:flex;align-items:center;gap:6px;">
                        <div style="background:rgba(59,130,246,0.2);color:#38bdf8;padding:2px 8px;border-radius:10px;font-size:10px;">PASSO 3</div> Preferências de Sincronização
                    </div>
                    <div style="background:rgba(255,255,255,0.03);padding:15px;border-radius:10px;border:1px solid rgba(255,255,255,0.05);display:flex;flex-direction:column;gap:10px;">
                        <label style="display:flex;align-items:center;cursor:pointer;font-size:13px;color:#cbd5e1;gap:10px;">
                            <input type="checkbox" id="api-nocopy" ${api.noCopy ? 'checked' : ''} style="width:16px;height:16px;accent-color:${ACCENT_COLOR};">
                            Não extrair o catálogo desta nuvem (Só enviar)
                        </label>
                        <label style="display:flex;align-items:center;cursor:pointer;font-size:13px;color:#cbd5e1;gap:10px;">
                            <input type="checkbox" id="api-nohide" ${api.noHide ? 'checked' : ''} style="width:16px;height:16px;accent-color:${ACCENT_COLOR};">
                            Não esconder os vídeos desta nuvem (Ignorar filtro "Ocultar Locais")
                        </label>
                    </div>
                </div>

                <div style="display:flex;gap:10px;margin-top:10px;">
                    <button id="zz-save-api" style="flex:1;padding:14px;background:linear-gradient(to right, #38bdf8, #818cf8);color:white;border:none;border-radius:10px;font-weight:800;cursor:pointer;font-size:14px;box-shadow:0 8px 20px rgba(56,189,248,0.3);">Gravar Automação</button>
                    ${isEdit ? `<button id="zz-cancel-edit" style="padding:14px;background:rgba(255,255,255,0.05);color:#cbd5e1;border:1px solid rgba(255,255,255,0.1);border-radius:10px;cursor:pointer;font-weight:bold;">Cancelar</button>` : ''}
                </div>
            </div>`;

                box.querySelector("#zz-close-mgr").onclick = () => { mod.remove(); if (editIndex >= 0) { editIndex = -1; renderList(); } };

                box.querySelector("#zz-gen-key").onclick = () => {
                    const kInput = box.querySelector("#api-k");
                    kInput.value = generateKey();
                    kInput.type = "text";
                };

                const eyeBtn = box.querySelector("#zz-eye-pw");
                if (eyeBtn) eyeBtn.onclick = () => {
                    const k = box.querySelector("#api-k");
                    k.type = k.type === "password" ? "text" : "password";
                };

                if (isEdit) {
                    box.querySelector("#zz-cancel-edit").onclick = () => { editIndex = -1; renderList(); };
                }

                box.querySelector("#zz-save-api").onclick = () => {
                    const n = box.querySelector("#api-n").value;
                    const u = box.querySelector("#api-u").value;
                    const k = box.querySelector("#api-k").value;
                    const nc = box.querySelector("#api-nocopy").checked;
                    const nh = box.querySelector("#api-nohide").checked;

                    if (n && u) {
                        const newObj = { name: n, url: u, apiKey: k, noCopy: nc, noHide: nh };
                        if (isEdit) configs[editIndex] = newObj; else configs.push(newObj);
                        GM_setValue(STORE_API_CONFIGS, __obf(JSON.stringify(configs)));
                        editIndex = -1;
                        renderList();
                        fetchCloudData();
                    } else {
                        toast("Nome e Worker URL são obrigatórios.");
                    }
                };
            };

            const renderList = () => {
                configs = getApiConfigs();
                let listHtml = configs.map((api, idx) => `
                <div style="background:rgba(255,255,255,.03);padding:15px;border-radius:12px;margin-bottom:10px;border:1px solid rgba(255,255,255,.06);display:flex;justify-content:space-between;align-items:center;transition:0.2s;">
                    <div>
                        <div style="font-size:14px;font-weight:800;color:${ACCENT_COLOR};margin-bottom:3px;display:flex;align-items:center;gap:8px;">
                            ${api.name}
                            ${api.noCopy ? '<span style="background:rgba(239,68,68,0.2);color:#fca5a5;padding:2px 6px;border-radius:6px;font-size:9px;">NoCopy</span>' : ''}
                            ${api.noHide ? '<span style="background:rgba(245,158,11,0.2);color:#fcd34d;padding:2px 6px;border-radius:6px;font-size:9px;">NoHide</span>' : ''}
                        </div>
                        <div style="font-size:11px;color:#475569;font-family:monospace;">${api.url}</div>
                    </div>
                    <div style="display:flex;gap:5px;">
                        <button class="zz-api-edit" data-idx="${idx}" style="background:rgba(59,130,246,.2);color:#93c5fd;border:none;padding:8px 12px;border-radius:8px;cursor:pointer;font-weight:bold;font-size:11px;">Editar</button>
                        <button class="zz-api-del" data-idx="${idx}" style="background:rgba(220,38,38,.2);color:#fca5a5;border:none;padding:8px 12px;border-radius:8px;cursor:pointer;font-weight:bold;font-size:11px;">✖</button>
                    </div>
                </div>`).join('');

                box.innerHTML = `
                <div style="padding:20px;border-bottom:1px solid rgba(255,255,255,.07);font-weight:800;background:linear-gradient(105deg,${ACCENT_COLOR}22,transparent);display:flex;justify-content:space-between;align-items:center;">
                    Gestor de Nuvens Híbridas
                    <button id="zz-close-mgr" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:18px;font-weight:bold;">✖</button>
                </div>
                <div style="padding:20px;">
                    <div id="zz-api-list" style="margin-bottom:20px;max-height:400px;overflow-y:auto;">${listHtml || '<div style="text-align:center;font-size:13px;color:#475569;margin:20px 0;">Nenhuma automação na nuvem configurada. Trabalharás apenas em Local Storage da aba.</div>'}</div>
                    <button id="zz-new-api-btn" style="width:100%;padding:14px;background:rgba(255,255,255,0.05);color:white;border:1px dashed rgba(255,255,255,0.2);border-radius:10px;cursor:pointer;font-weight:bold;transition:0.3s;">+ ADICIONAR NOVA NUVEM</button>
                </div>
            `;

                box.querySelector("#zz-close-mgr").onclick = () => mod.remove();
                box.querySelector("#zz-new-api-btn").onclick = () => renderSetup();

                box.querySelectorAll(".zz-api-del").forEach(b => b.onclick = () => {
                    if (confirm("Garantia: O Cloudflare Worker em si não será apagado, apagas apenas de sincronizar desta tab. Continuar?")) {
                        configs.splice(b.dataset.idx, 1);
                        GM_setValue(STORE_API_CONFIGS, __obf(JSON.stringify(configs)));
                        renderList();
                    }
                });

                box.querySelectorAll(".zz-api-edit").forEach(b => b.onclick = () => {
                    editIndex = parseInt(b.dataset.idx);
                    renderSetup();
                });
            };

            renderList();
            mod.appendChild(box);
            document.body.appendChild(mod);
        }

        async function openDashboard() {
            const overlay = document.createElement('div');
            overlay.style.cssText = "position:fixed;inset:0;background:linear-gradient(to bottom, #0a0e17 0%, #030509 100%);z-index:2000000;padding:20px;overflow-y:auto;color:#e2e8f0;font-family:system-ui,sans-serif;";
            document.body.appendChild(overlay);

            let items = getStored(STORE_CATALOG);
            let selIds = getStored(STORE_SELECTED);
            let locIds = getStored(STORE_LOCAL);
            let currentFilter = 'all'; // 'all', 'local', 'missing'
            let currentParentContext = null; // null = visa root; string (id) = vista nested

            const zzState = { cloudLoading: true, cloudSet: new Set(), cloudCatSet: new Set() };

            const fetchPureCloudStats = async () => {
                const configs = getApiConfigs();
                if (configs.length === 0) { zzState.cloudLoading = false; return; }
                for (const api of configs) {
                    try {
                        const hdrs = api.apiKey ? { "x-api-key": api.apiKey } : undefined;
                        const res = await fetch(`${api.url}?keys=${STORE_LOCAL},${STORE_CATALOG}`, { headers: hdrs });
                        if (res.ok) {
                            const data = await res.json();
                            if (data && Array.isArray(data[STORE_LOCAL])) {
                                data[STORE_LOCAL].forEach(id => zzState.cloudSet.add(id));
                            }
                            if (data && Array.isArray(data[STORE_CATALOG])) {
                                data[STORE_CATALOG].forEach(i => zzState.cloudCatSet.add(i.id));
                            }
                        }
                    } catch (e) { }
                }
                zzState.cloudLoading = false;
                const statDom = document.getElementById('zz-cloud-stat-num');
                if (statDom) statDom.innerHTML = `${zzState.cloudSet.size}<span style="font-size:14px;color:#475569;"> / ${zzState.cloudCatSet.size}</span>`;
            };
            fetchPureCloudStats();

            const isSelected = (id) => selIds.includes(id);
            const isLocal = (id) => locIds.includes(id);

            const render = async () => {
                const rootProgs = items.filter(i => !i.url.includes('/e'));
                const epsOnly = items.filter(i => i.url.includes('/e'));
                const localRoot = rootProgs.filter(i => locIds.includes(i.id)).length;
                const localEps = epsOnly.filter(i => locIds.includes(i.id)).length;

                // Filtration logic based on Context
                let contextItems = [];
                let breadcrumbHtml = ``;

                if (currentParentContext === null) {
                    contextItems = rootProgs;
                } else {
                    contextItems = items.filter(i => i.parentId === currentParentContext && i.id !== currentParentContext);
                    const parentInfo = rootProgs.find(p => p.id === currentParentContext);
                    const parentTitle = parentInfo ? parentInfo.title : 'Série';

                    breadcrumbHtml = `
                <div style="margin-bottom:20px;display:flex;align-items:center;gap:15px;">
                    <button id="zz-dash-back" style="background:rgba(255,255,255,0.05);color:white;border:1px solid rgba(255,255,255,0.1);padding:10px 20px;border-radius:10px;cursor:pointer;font-weight:700;transition:0.3s;display:flex;align-items:center;gap:8px;">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
                        Voltar a Todos Programas
                    </button>
                    <span style="color:#94a3b8;font-size:18px;">/</span>
                    <h2 style="margin:0;font-size:22px;color:#f8fafc;font-weight:800;">${parentTitle} <span style="color:#475569;font-size:16px;font-weight:600;">(${contextItems.length} episódios)</span></h2>
                </div>`;
                }

                let filteredItems = contextItems;
                if (currentFilter === 'local') filteredItems = contextItems.filter(i => isLocal(i.id));
                if (currentFilter === 'missing') filteredItems = contextItems.filter(i => !isLocal(i.id));

                const makeGlassCard = async (item) => {
                    const displayImg = await getCachedImageURL(item.poster) || item.poster;
                    const local = isLocal(item.id);
                    const isProg = !item.url.includes('/e');
                    const epsInSeries = isProg ? epsOnly.filter(e => e.parentId === item.id).length : 0;

                    let badges = '';
                    if (local) badges += `<div style="background:rgba(59,130,246,0.2);color:#60a5fa;border:1px solid rgba(59,130,246,0.3);padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700;backdrop-filter:blur(5px);box-shadow: 0 4px 10px rgba(0,0,0,0.5);">COLEÇÃO</div>`;
                    if (isSelected(item.id)) badges += `<div style="background:rgba(16,185,129,0.2);color:#34d399;border:1px solid rgba(16,185,129,0.3);padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700;backdrop-filter:blur(5px);box-shadow: 0 4px 10px rgba(0,0,0,0.5);">SELECIONADO</div>`;

                    let actionBtn = local ? `<button class="zz-remove-item" data-id="${item.id}" title="Remover da coleção local" style="background:rgba(239, 68, 68, 0.9);color:white;border:none;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0.8;transition:0.3s;font-size:12px;z-index:2;">✖</button>` : `<button class="zz-add-item" data-id="${item.id}" title="Adicionar à coleção" style="background:rgba(59, 130, 246, 0.9);color:white;border:none;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0.8;transition:0.3s;z-index:2;">+</button>`;

                    let exploreLayer = isProg ? `
                    <div style="position:absolute; inset:0; z-index:1; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.4); opacity:0; transition:0.3s;" class="hover-explore-layer">
                        <button class="zz-explore-btn" data-id="${item.id}" style="background:rgba(255,255,255,0.1);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.2);color:white;padding:12px 24px;border-radius:30px;font-weight:800;cursor:pointer;transform:translateY(10px);transition:0.3s;box-shadow:0 10px 25px rgba(0,0,0,0.5);">EXPLORAR</button>
                    </div>` : '';

                    return `
                <div class="zz-dash-card" style="background:rgba(20,25,35,0.6);border-radius:18px;overflow:hidden;border:1px solid rgba(255,255,255,0.05);transition:transform 0.3s, box-shadow 0.3s;box-shadow:0 8px 30px rgba(0,0,0,0.4);position:relative;display:flex;flex-direction:column;">
                    <div style="position:relative; aspect-ratio: 16/9; background: #000; overflow:hidden;" class="card-hero-wrap">
                        <img src="${displayImg}" style="width:100%;height:100%;object-fit:cover;transition:0.5s;filter:${local ? 'brightness(1.1)' : 'brightness(0.6)'};">
                        <div style="position:absolute; inset:0; background:linear-gradient(to top, rgba(10,14,23,1) 0%, transparent 60%); pointer-events:none;"></div>
                        <div style="position:absolute; top:12px; right:12px; display:flex; flex-direction:column; gap:8px; align-items:flex-end;">
                            <div style="display:flex; gap:6px;">${badges}</div>
                            ${actionBtn}
                        </div>
                        ${exploreLayer}
                    </div>
                    <div style="padding:18px; flex:1; display:flex; flex-direction:column; justify-content:space-between;background:rgba(20,25,35,0.8);backdrop-filter:blur(10px);">
                        <div>
                            <div style="font-size:15px;font-weight:800;margin-bottom:6px;line-height:1.2;color:#f8fafc;${local ? 'text-shadow:0 0 10px rgba(255,255,255,0.2);' : ''}">${item.title}</div>
                            <div style="display:flex;justify-content:space-between;align-items:center;">
                                <div style="font-size:12px;color:#cbd5e1;font-weight:500;">${isProg ? 'Programa / Série' : 'Episódio'} • <span style="opacity:0.7;">${item.date || 'Zig Zag'}</span></div>
                                ${isProg ? `<div style="font-size:10px;background:rgba(255,255,255,0.05);padding:3px 8px;border-radius:10px;color:#94a3b8;font-weight:bold;">${epsInSeries} Eps</div>` : ''}
                            </div>
                        </div>
                        <a href="${item.url}" target="_blank" style="display:inline-block;margin-top:15px;color:#38bdf8;text-decoration:none;font-size:12px;font-weight:800;letter-spacing:0.5px;transition:0.2s;width:max-content;">VER NA RTP ↗</a>
                    </div>
                </div>`;
                };

                const cardsHtml = await Promise.all(filteredItems.map(makeGlassCard));

                const btnStyleStyle = (active) => active ? "background:rgba(255,255,255,0.1);color:white;border:none;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:bold;transition:0.2s;" : "background:transparent;color:#94a3b8;border:none;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:bold;transition:0.2s;";

                overlay.innerHTML = `
                <div style="max-width:1400px;margin:0 auto;padding-top:20px;">
                    <!-- HEADER GLASSMORPHISM -->
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:40px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);padding:20px 30px;border-radius:24px;backdrop-filter:blur(20px);box-shadow:0 20px 40px rgba(0,0,0,0.3);">
                        <div>
                            <h1 style="margin:0;font-size:28px;font-weight:900;background:linear-gradient(to right, #38bdf8, #818cf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;display:flex;align-items:center;gap:15px;">
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                ZigZag Manager
                            </h1>
                            <div style="color:#94a3b8;font-size:14px;margin-top:8px;font-weight:500;">Gestão global de multimédia local sincronizada na nuvem</div>
                        </div>

                        <div style="display:flex;gap:30px;align-items:center;">
                            <!-- FILTROS -->
                            <div style="display:flex;background:rgba(0,0,0,0.5);border-radius:10px;padding:4px;box-shadow:inset 0 2px 5px rgba(0,0,0,0.5);">
                                <button class="zz-filter-btn" data-filter="all" style="${btnStyleStyle(currentFilter === 'all')}">Todos</button>
                                <button class="zz-filter-btn" data-filter="local" style="${btnStyleStyle(currentFilter === 'local')}">Temos</button>
                                <button class="zz-filter-btn" data-filter="missing" style="${btnStyleStyle(currentFilter === 'missing')}">Faltam</button>
                            </div>
                            <!-- ESTATÍSTICAS -->
                            <div style="display:flex;gap:20px;text-align:center;">
                                <div>
                                    <div style="font-size:24px;font-weight:900;color:#f8fafc;">${localRoot}<span style="font-size:14px;color:#475569;"> / ${rootProgs.length}</span></div>
                                    <div style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Programas</div>
                                </div>
                                <div style="width:1px;background:rgba(255,255,255,0.1);"></div>
                                <div>
                                    <div style="font-size:24px;font-weight:900;color:#34d399;">${localEps}<span style="font-size:14px;color:#475569;"> / ${epsOnly.length}</span></div>
                                    <div style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Episódios Locais</div>
                                </div>
                                <div style="width:1px;background:rgba(255,255,255,0.1);"></div>
                                <div>
                                    <div id="zz-cloud-stat-num" style="font-size:24px;font-weight:900;color:#38bdf8;">${zzState.cloudLoading ? '...' : `${zzState.cloudSet.size}<span style="font-size:14px;color:#475569;"> / ${zzState.cloudCatSet.size}</span>`}</div>
                                    <div style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Itens na Nuvem</div>
                                </div>
                            </div>
                            <!-- AÇÕES -->
                            <button id="zz-dash-sync" style="background:rgba(56,189,248,0.1);color:#38bdf8;border:1px solid rgba(56,189,248,0.2);padding:14px 22px;border-radius:12px;cursor:pointer;font-weight:800;transition:0.3s;box-shadow:0 8px 20px rgba(0,0,0,0.2);">☁️ SINC CLOUD</button>
                            <button id="zz-dash-close" style="background:rgba(255,255,255,0.05);color:white;border:1px solid rgba(255,255,255,0.1);padding:14px 22px;border-radius:12px;cursor:pointer;font-weight:800;transition:0.3s;box-shadow:0 8px 20px rgba(0,0,0,0.2);">X FECHAR</button>
                        </div>
                    </div>

                    ${breadcrumbHtml}

                    <!-- CSS HOVERS -->
                    <style>
                        .zz-dash-card:hover { transform: translateY(-5px); box-shadow: 0 15px 40px rgba(56, 189, 248, 0.1) !important; border-color: rgba(56, 189, 248, 0.4) !important; }
                        .zz-dash-card:hover img { transform: scale(1.05); }
                        .zz-dash-card a:hover { color: #818cf8 !important; }
                        .zz-remove-item:hover { background: #ef4444 !important; transform:scale(1.1); }
                        .zz-add-item:hover { background: #2563eb !important; transform:scale(1.1); }
                        .zz-filter-btn:hover { color:white !important; }
                        #zz-dash-close:hover { background:rgba(239, 68, 68, 0.8) !important; border-color:rgba(239, 68, 68, 1) !important; }
                        #zz-dash-back:hover { background:rgba(255,255,255,0.1) !important; }
                        .card-hero-wrap:hover .hover-explore-layer { opacity:1 !important; pointer-events:auto; }
                        .card-hero-wrap:hover .zz-explore-btn { transform:translateY(0) !important; }
                        .zz-explore-btn:hover { background:rgba(56,189,248,0.8) !important; border-color:rgba(56,189,248,1) !important; color:white; }
                    </style>

                    <!-- GRID -->
                    <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(260px, 1fr));gap:30px;padding-bottom:50px;">
                        ${cardsHtml.length > 0 ? cardsHtml.join('') : '<div style="grid-column:1/-1;text-align:center;padding:50px;color:#475569;font-weight:600;font-size:20px;">Nenhum item encontrado nesta pasta/filtro.</div>'}
                    </div>
                </div>
            `;

                overlay.querySelector('#zz-dash-close').onclick = () => overlay.remove();

                const syncBtn = overlay.querySelector('#zz-dash-sync');
                if (syncBtn) {
                    syncBtn.onclick = async () => {
                        syncBtn.innerHTML = "⏳ A SINCRONIZAR...";
                        syncBtn.style.pointerEvents = "none";
                        await fetchCloudData();
                        await saveToCloud();
                        await fetchPureCloudStats();
                        items = getStored(STORE_CATALOG);
                        selIds = getStored(STORE_SELECTED);
                        locIds = getStored(STORE_LOCAL);
                        render();
                    };
                }

                const backBtn = overlay.querySelector('#zz-dash-back');
                if (backBtn) {
                    backBtn.onclick = () => {
                        currentParentContext = null;
                        render();
                    };
                }

                overlay.querySelectorAll('.zz-explore-btn').forEach(btn => {
                    btn.onclick = (e) => {
                        currentParentContext = e.target.getAttribute('data-id');
                        render();
                    };
                });

                overlay.querySelectorAll('.zz-filter-btn').forEach(btn => {
                    btn.onclick = (e) => {
                        currentFilter = e.target.getAttribute('data-filter');
                        render();
                    };
                });

                overlay.querySelectorAll('.zz-remove-item').forEach(btn => {
                    btn.onclick = async (e) => {
                        const id = e.target.getAttribute('data-id');
                        let currentLocal = getStored(STORE_LOCAL);
                        const dependents = new Set();
                        items.filter(child => child.parentId === id).forEach(child => {
                            dependents.add(child.id);
                            items.filter(sub => sub.url.startsWith(child.url) && sub.id !== child.id).forEach(sub => dependents.add(sub.id));
                        });

                        const depArray = Array.from(dependents);
                        currentLocal = currentLocal.filter(i => i !== id && !depArray.includes(i));

                        setStored(STORE_LOCAL, currentLocal);
                        locIds = currentLocal;
                        saveToCloud(); highlightCards(); updateStats();
                        render();
                    };
                });

                overlay.querySelectorAll('.zz-add-item').forEach(btn => {
                    btn.onclick = async (e) => {
                        const id = e.target.getAttribute('data-id');
                        let currentLocal = getStored(STORE_LOCAL);

                        if (!currentLocal.includes(id)) currentLocal.push(id);

                        const dependents = new Set();
                        items.filter(child => child.parentId === id).forEach(child => {
                            dependents.add(child.id);
                            items.filter(sub => sub.url.startsWith(child.url) && sub.id !== child.id).forEach(sub => dependents.add(sub.id));
                        });

                        const depArray = Array.from(dependents);
                        depArray.forEach(d => { if (!currentLocal.includes(d)) currentLocal.push(d); });

                        setStored(STORE_LOCAL, currentLocal);
                        locIds = currentLocal;
                        saveToCloud(); highlightCards(); updateStats();
                        render();
                    };
                });
            };

            render();
        }

        /* =====================================================================
           HIGHLIGHT DE SINGLE PAGES (Dentro de um vídeo/episódio)
           ===================================================================== */
        function highlightSinglePage() {
            const url = window.location.href.split('?')[0].split('#')[0];

            // Apenas ativa se não for na homepage nem na listagem de programas
            if (url.endsWith('/programas') || url === 'https://www.rtp.pt/play/zigzag/') return;

            const h1 = document.querySelector('h1.title, header h1, .program-name, h1');
            if (!h1 || document.querySelector('.zz-btn-local-single')) return;

            const id = getZZID(url);
            const l = getStored(STORE_LOCAL);

            // Se URL tiver /e ou número de parte, é nativamente sub-item
            const isEpisodeOrPart = url.includes('/e') || url.match(/\/\d+$/);
            const isLocal = l.includes(id) || (!isEpisodeOrPart && checkProgramCompletion(id));

            const btn = document.createElement('div');
            btn.className = 'zz-btn-local-single';
            btn.innerHTML = ICONS.local;
            btn.title = "Guardar Coleção / Marcar Local";
            btn.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;cursor:pointer;border:2px solid ${isLocal ? '#3b82f6' : 'rgba(255,255,255,0.2)'};background:${isLocal ? '#3b82f6' : 'rgba(0,0,0,0.6)'};color:white;margin-left:18px;vertical-align:middle;transition:0.3s;box-shadow:0 4px 10px rgba(0,0,0,0.3);`;

            btn.onmouseover = () => { if (btn.style.background !== 'rgb(59, 130, 246)') btn.style.background = 'rgba(59, 130, 246, 0.4)'; };
            btn.onmouseout = () => { if (btn.style.background !== 'rgb(59, 130, 246)') btn.style.background = 'rgba(0,0,0,0.6)'; };

            btn.onclick = async (e) => {
                e.preventDefault(); e.stopPropagation();

                const clonedH1 = h1.cloneNode(true);
                const existingBtn = clonedH1.querySelector('.zz-btn-local-single');
                if (existingBtn) existingBtn.remove();

                const titleRaw = clonedH1.textContent.trim();
                const poster = document.querySelector('meta[property="og:image"]')?.content || "";

                // Redirecionamento Magno: extraímos a URL mãe do Programa para invocar a aranha com toda a hierarquia!
                let rootUrl = url;
                let rootId = id;
                if (isEpisodeOrPart) {
                    const u = new URL(url);
                    u.pathname = u.pathname.split('/').filter(p => !p.match(/^e\d+$/) && !p.match(/^\d+$/)).join('/');
                    rootUrl = u.href;
                    rootId = getZZID(rootUrl);
                }

                addToCatalog(rootId, rootUrl, titleRaw, poster);
                let localList = getStored(STORE_LOCAL);
                let catList = getStored(STORE_CATALOG);

                if (localList.includes(rootId)) {
                    // Desmarcar
                    btn.style.background = "rgba(0,0,0,0.6)";
                    btn.style.borderColor = "rgba(255,255,255,0.2)";

                    const dependents = new Set();
                    catList.filter(child => child.parentId === rootId).forEach(child => {
                        dependents.add(child.id);
                        catList.filter(sub => sub.url.startsWith(child.url) && sub.id !== child.id).forEach(sub => dependents.add(sub.id));
                    });
                    catList.filter(p => p.url.startsWith(rootUrl) && p.id !== rootId).forEach(p => dependents.add(p.id));
                    const depArray = Array.from(dependents);

                    localList = localList.filter(i => i !== rootId && !depArray.includes(i));
                    setStored(STORE_LOCAL, localList);
                    saveToCloud(); updateStats(); highlightCards();
                } else {
                    // Marcar ativo (Spider varre TODO O PROGRAMA partindo da raiz)
                    btn.innerHTML = "⏳";
                    btn.style.pointerEvents = "none";

                    const target = [{ url: rootUrl, id: rootId, title: titleRaw, poster, parentId: null }];
                    let closeToast = null;
                    const res = await backgroundSpider(target, (msg) => {
                        closeToast = updateToast("zz-spider-toast-" + rootId, msg);
                    });
                    if (closeToast) closeToast();

                    setStored(STORE_CATALOG, res.updatedCatalog);
                    catList = res.updatedCatalog;

                    const dependents = new Set();
                    catList.filter(child => child.parentId === rootId).forEach(child => {
                        dependents.add(child.id);
                        catList.filter(sub => sub.url.startsWith(child.url) && sub.id !== child.id).forEach(sub => dependents.add(sub.id));
                    });
                    catList.filter(p => p.url.startsWith(rootUrl) && p.id !== rootId).forEach(p => dependents.add(p.id));
                    const depArray = Array.from(dependents);

                    if (!localList.includes(rootId)) localList.push(rootId);
                    depArray.forEach(d => { if (!localList.includes(d)) localList.push(d); });

                    setStored(STORE_LOCAL, localList);

                    btn.innerHTML = ICONS.local;
                    btn.style.background = "#3b82f6";
                    btn.style.borderColor = "#3b82f6";
                    btn.style.pointerEvents = "auto";
                    saveToCloud(); updateStats(); highlightCards();
                }
            };

            // Injetar o botão local de forma segura ao lado do H1
            h1.style.display = 'flex';
            h1.style.alignItems = 'center';
            h1.appendChild(btn);
        }

        /* =====================================================================
           INIT
           ===================================================================== */
        async function init() {
            await initDB();
            injectUI();
            highlightCards();
            highlightSinglePage();
            const obs = new MutationObserver(() => { highlightCards(); highlightSinglePage(); });
            obs.observe(document.body, { childList: true, subtree: true });
        }

        if (document.readyState === "complete") init();
        else window.addEventListener('load', init);

})();
