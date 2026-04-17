/**
 * core/image-cache.js — Cache de posters em IndexedDB + gestão de blob URLs.
 *
 * Source of truth: filmin.user.js
 * Used by: filmin, filmtwist, pandaplus, tvcine, zigzag
 *
 * Usage:
 *   const imgCache = createImageCache("filmin_img_cache_db");
 *   const blobUrl  = await imgCache.getCachedImageURL(posterUrl);
 *   imgCache.revokeAllObjectURLs(); // chamar ao fechar o dashboard
 *
 * Esquema IndexedDB (v2):
 *   store "images": key = URL, value = { blob: Blob, lastAccess: number }
 *   index "lastAccess" — suporta eviction LRU eficiente.
 *
 * Política de retenção: cap rígido em MAX_CACHE_ENTRIES. Ao ultrapassar,
 * apaga EVICT_BATCH entradas mais antigas por lastAccess. Evita crescimento
 * ilimitado sem impor TTL artificial (posters não "expiram" — um 404 futuro
 * resolve-se naturalmente na próxima fetch).
 */

const IMG_STORE_NAME     = "images";
const IMG_DB_VERSION     = 2;
const OBJ_URL_CAP        = 400;    // cap em memória (blob: URLs ativos)
const MAX_CACHE_ENTRIES  = 2000;   // cap persistente em IndexedDB
const EVICT_BATCH        = 100;    // quantas entradas apagar de cada vez

export function createImageCache(dbName) {
    // Map de URL original → blob: URL criado nesta sessão
    const _objUrls = new Map();

    // Promise da IndexedDB em cache — UMA ligação por sessão
    let _imgDbPromise = null;

    // Guard para não correr o eviction em paralelo
    let _evicting = false;

    /**
     * Revoga blob URLs antigos quando o Map ultrapassa OBJ_URL_CAP.
     * Antes de revogar, verifica quais blob: URLs ainda estão montados num
     * <img> para não partir posters visíveis ao fazer scroll no dashboard.
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

    /** Revoga TODOS os blob URLs — chamar ao fechar o dashboard para libertar RAM */
    function revokeAllObjectURLs() {
        for (const obj of _objUrls.values()) {
            try { URL.revokeObjectURL(obj); } catch { /* ignora */ }
        }
        _objUrls.clear();
    }

    function openImageDB() {
        if (_imgDbPromise) return _imgDbPromise;
        _imgDbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(dbName, IMG_DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                // Na migração de v1 → v2 o schema muda (agora armazenamos
                // { blob, lastAccess } com um índice). Apagar e recriar é
                // o caminho mais simples — os blobs serão re-obtidos
                // on-demand na primeira leitura.
                if (db.objectStoreNames.contains(IMG_STORE_NAME))
                    db.deleteObjectStore(IMG_STORE_NAME);
                const store = db.createObjectStore(IMG_STORE_NAME);
                store.createIndex("lastAccess", "lastAccess", { unique: false });
            };
            req.onsuccess = () => {
                const db = req.result;
                // Se outro tab fizer upgrade da versão, fechamos para não
                // bloquear a instância nova e invalidamos a promise cacheada.
                db.onversionchange = () => {
                    try { db.close(); } catch { /* ignora */ }
                    _imgDbPromise = null;
                };
                resolve(db);
            };
            req.onerror   = () => { _imgDbPromise = null; reject(req.error); };
            // Outro tab segura uma ligação aberta com versão anterior — evita
            // pendurar indefinidamente e propaga como erro recuperável.
            req.onblocked = () => { _imgDbPromise = null; reject(new Error("IndexedDB bloqueada por outra ligação")); };
        }).catch(err => { _imgDbPromise = null; throw err; });
        return _imgDbPromise;
    }

    /**
     * Se o store ultrapassar MAX_CACHE_ENTRIES, apaga EVICT_BATCH entradas
     * mais antigas (menor lastAccess). Chamado "fire-and-forget" a seguir
     * a puts para não penalizar a latência do caller.
     */
    function _evictOldestIfNeeded(db) {
        if (_evicting) return;
        _evicting = true;
        try {
            const tx    = db.transaction(IMG_STORE_NAME, "readwrite");
            const store = tx.objectStore(IMG_STORE_NAME);
            const countReq = store.count();
            countReq.onsuccess = () => {
                const count = countReq.result;
                if (count <= MAX_CACHE_ENTRIES) return;
                const toDelete = Math.min(count - MAX_CACHE_ENTRIES + EVICT_BATCH, count);
                const idx = store.index("lastAccess");
                const curReq = idx.openCursor(null, "next"); // mais antigo primeiro
                let deleted = 0;
                curReq.onsuccess = (e) => {
                    const cur = e.target.result;
                    if (!cur || deleted >= toDelete) return;
                    cur.delete();
                    deleted++;
                    cur.continue();
                };
            };
            tx.oncomplete = () => { _evicting = false; };
            tx.onerror    = () => { _evicting = false; };
            tx.onabort    = () => { _evicting = false; };
        } catch { _evicting = false; }
    }

    async function getCachedImageBLOB(url) {
        if (!url || !url.startsWith("http")) return null;
        try {
            const db = await openImageDB();
            return new Promise((resolve) => {
                // readwrite para poder atualizar lastAccess (touch-on-read LRU)
                const tx    = db.transaction(IMG_STORE_NAME, "readwrite");
                const store = tx.objectStore(IMG_STORE_NAME);
                const getR  = store.get(url);
                getR.onsuccess = () => {
                    const rec = getR.result;
                    if (!rec) { resolve(null); return; }
                    // Compatibilidade: se por alguma razão um registo antigo
                    // (Blob direto, sem wrapper) sobreviveu, devolve-o na mesma.
                    if (rec instanceof Blob) { resolve(rec); return; }
                    rec.lastAccess = Date.now();
                    try { store.put(rec, url); } catch { /* best-effort */ }
                    resolve(rec.blob || null);
                };
                getR.onerror = () => resolve(null);
            });
        } catch { return null; }
    }

    async function setCachedImageBLOB(url, blob) {
        if (!url || !blob) return;
        try {
            const db = await openImageDB();
            const tx = db.transaction(IMG_STORE_NAME, "readwrite");
            tx.objectStore(IMG_STORE_NAME).put({ blob, lastAccess: Date.now() }, url);
            tx.oncomplete = () => { _evictOldestIfNeeded(db); };
        } catch (e) { console.error("Erro ao guardar imagem na cache", e); }
    }

    /**
     * Devolve um blob: URL para a imagem indicada.
     * Prioridade: Map em memória → IndexedDB → GM_xmlhttpRequest.
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
