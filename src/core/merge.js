/**
 * core/merge.js — Pure data-manipulation helpers (no side-effects, no globals).
 *
 * Source of truth: filmin.user.js
 * Used by: filmin, filmtwist, pandaplus, zigzag
 */

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

/** Removes query string and trailing slash */
export const normUrl = (urlStr) => {
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
export const betterPoster = (n, o) => {
    const nn = safeTrim(n), oo = safeTrim(o);
    if (!nn || nn.length <= 8 || !isValidHttpUrl(nn)) return oo;
    return nn;
};

/**
 * Returns a betterTitle function.
 * Pass a suffixRe to strip service-specific title suffixes (e.g., "— Filmin").
 * Without suffixRe, falls back to choosing the longer of the two titles.
 */
export function makeBetterTitle(suffixRe = null) {
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
