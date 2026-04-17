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
 */

const IMG_STORE_NAME = "images";
const OBJ_URL_CAP    = 400;

export function createImageCache(dbName) {
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
