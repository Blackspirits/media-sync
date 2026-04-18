/**
 * core/storage.js — Helpers de persistência localStorage / GM_getValue.
 *
 * Source of truth: filmin.user.js
 * Used by: filmin, filmtwist, pandaplus, tvcine, zigzag
 *
 * Depende de: GM_getValue / GM_setValue (injetados pelo Tampermonkey em runtime)
 *             mergeData de ./merge.js (usado por setStored)
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
 * Escreve uma lista em localStorage + GM_setValue (dual-write atómico).
 * Deduplica com `mergeFn(list)` antes de persistir.
 *
 * Por defeito usa `mergeData` (preserva saved_at mais antigo, dedup por URL).
 * Passa `mergeDataPreferNewest` para stores de edição (ex.: notas de séries),
 * ou uma função custom para betterTitle específico do serviço:
 *   setStored(key, list, (l) => mergeData(l, myBetterTitle))
 */
export function setStored(key, list, mergeFn = mergeData) {
    const jsonStr = JSON.stringify(mergeFn(list));
    try { localStorage.setItem(key, jsonStr); } catch (e) { console.error("Erro ao guardar no localStorage:", e); }
    GM_setValue(key, jsonStr);
}
