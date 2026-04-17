/**
 * core/merge.js — Pure data-manipulation helpers (no side-effects, no globals).
 *
 * Source of truth: filmin.user.js
 * Used by: filmin, filmtwist, pandaplus, tvcine, zigzag
 */

// Tamanho mínimo para um URL de poster ser considerado válido
// (evita candidatos curtos como "x.png" ou caminhos incompletos).
const MIN_POSTER_URL_LEN = 8;

export const toObj = (item) => {
    if (!item) return null;
    if (typeof item === "string") return { url: item, title: "", poster: "" };
    if (typeof item === "object") return item;
    return null;
};

export const safeTrim = (s) => String(s || "").trim();

export const isValidHttpUrl = (value) => {
    const v = safeTrim(value);
    if (!v || (!v.startsWith("http://") && !v.startsWith("https://"))) return false;
    try { new URL(v); return true; } catch { return false; }
};

/** Converts relative hrefs ("/filme/x") to absolute URLs */
export const toAbsUrl = (href, origin = location.origin) => {
    if (!href) return "";
    if (href.startsWith("http://") || href.startsWith("https://")) return href;
    try { return new URL(href, origin).toString(); } catch { return href; }
};

/** Remove query string, hash fragment e barra final */
export const normUrl = (urlStr) => {
    if (!urlStr) return "";
    const abs = toAbsUrl(urlStr);
    try {
        const u = new URL(abs);
        u.search = "";
        u.hash   = "";
        let final = u.toString();
        if (final.endsWith("/")) final = final.slice(0, -1);
        return final;
    } catch { return abs; }
};

/** Prefere um URL HTTP válido de poster com caminho mais longo */
export const betterPoster = (n, o) => {
    const nn = safeTrim(n), oo = safeTrim(o);
    if (!nn || nn.length <= MIN_POSTER_URL_LEN || !isValidHttpUrl(nn)) return oo;
    return nn;
};

/**
 * Devolve uma função betterTitle.
 * Passa uma suffixRe para remover sufixos específicos do serviço (ex.: "— Filmin").
 * Sem suffixRe, escolhe o título mais longo entre os dois (mais descritivo tende
 * a conter o nome original — "The Matrix Reloaded" ganha a "Matrix").
 */
export function makeBetterTitle(suffixRe = null) {
    return (n, o) => {
        let nn = safeTrim(n);
        let oo = safeTrim(o);
        if (suffixRe) { nn = nn.replace(suffixRe, "").trim(); oo = oo.replace(suffixRe, "").trim(); }
        if (!nn) return oo;
        if (!oo) return nn;
        // Só substitui o antigo se o novo for válido (>= 3 chars) E pelo menos
        // tão descritivo (comprimento >= o antigo). Evita perder "The Matrix
        // Reloaded" para uma entrada posterior com apenas "Matrix".
        if (nn.length >= 3 && nn.length >= oo.length) return nn;
        return oo;
    };
}

/** Default betterTitle: choose the longer of the two titles */
export const betterTitle = makeBetterTitle();

/**
 * Merges arrays of items, deduplicating by normalised URL.
 * Preserves the oldest saved_at (correct for history/catalog stores).
 */
export function mergeData(arr, betterTitleFn = betterTitle) {
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
export function mergeDataPreferNewest(arr, betterTitleFn = betterTitle) {
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
