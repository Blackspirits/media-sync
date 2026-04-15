/**
 * core/storage.js — localStorage / GM_getValue persistence helpers.
 *
 * Source of truth: filmin.user.js
 * Used by: filmin, filmtwist, pandaplus, zigzag
 *
 * Depends on: GM_getValue / GM_setValue (injected by Tampermonkey at runtime)
 *             mergeData from ./merge.js (used by setStored)
 */

import { mergeData } from "./merge.js";

/** Safe localStorage.getItem — never throws even if storage is blocked */
export function safeLSGet(key, fallback = null) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

/** Safe localStorage.setItem — never throws even if storage is blocked */
export function safeLSSet(key, val) {
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
export function getStored(key) {
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
 * Writes a list to both localStorage and GM_setValue (atomic dual-write).
 * Deduplicates via mergeData before persisting.
 */
export function setStored(key, list) {
    const jsonStr = JSON.stringify(mergeData(list));
    try { localStorage.setItem(key, jsonStr); } catch (e) { console.error("Erro ao guardar no localStorage:", e); }
    GM_setValue(key, jsonStr);
}
