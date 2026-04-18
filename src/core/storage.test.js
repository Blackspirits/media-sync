/**
 * Testes unitários para core/storage.js.
 *
 * Corre com:  npm test
 *
 * Usa stubs in-memory para localStorage, GM_getValue e GM_setValue.
 * Reset entre testes com t.beforeEach para garantir isolamento.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

/** Stubs mínimos do ambiente Tampermonkey + browser. */
const _gm = new Map();
const _ls = new Map();

globalThis.GM_getValue = (k, def) => _gm.has(k) ? _gm.get(k) : def;
globalThis.GM_setValue = (k, v) => { _gm.set(k, v); };
globalThis.localStorage = {
    getItem: (k) => _ls.has(k) ? _ls.get(k) : null,
    setItem: (k, v) => { _ls.set(k, String(v)); },
    removeItem: (k) => { _ls.delete(k); },
    clear: () => { _ls.clear(); },
};
globalThis.location = { origin: "https://example.com" };

function resetStores() { _gm.clear(); _ls.clear(); }

const { getStored, setStored, safeLSGet, safeLSSet } = await import("./storage.js");
const { mergeDataPreferNewest } = await import("./merge.js");

/* ── safeLSGet / safeLSSet ──────────────────────────────────────────────── */

test("safeLSSet + safeLSGet fazem round-trip", (t) => {
    resetStores();
    safeLSSet("k1", "valor");
    assert.equal(safeLSGet("k1"), "valor");
});

test("safeLSGet devolve fallback quando a key não existe", (t) => {
    resetStores();
    assert.equal(safeLSGet("nonexistent", "default"), "default");
    assert.equal(safeLSGet("nonexistent"), null);
});

/* ── getStored ──────────────────────────────────────────────────────────── */

test("getStored devolve [] quando ambas as storages estão vazias", (t) => {
    resetStores();
    assert.deepEqual(getStored("catalog"), []);
});

test("getStored lê do localStorage quando disponível", (t) => {
    resetStores();
    _ls.set("cat", JSON.stringify([{ url: "https://a.com", title: "A" }]));
    const got = getStored("cat");
    assert.equal(got.length, 1);
    assert.equal(got[0].url, "https://a.com");
});

test("getStored espelha localStorage → GM_storage quando lê do LS", (t) => {
    resetStores();
    _ls.set("cat", JSON.stringify([{ url: "https://a.com" }]));
    getStored("cat");
    assert.equal(_gm.get("cat"), JSON.stringify([{ url: "https://a.com" }]));
});

test("getStored cai em GM_getValue quando localStorage vazio (nunca sobrescreve GM)", (t) => {
    resetStores();
    _gm.set("cat", JSON.stringify([{ url: "https://b.com", title: "B" }]));
    const got = getStored("cat");
    assert.equal(got.length, 1);
    assert.equal(got[0].title, "B");
    // GM mantém-se — não foi sobrescrito por "[]"
    assert.equal(_gm.get("cat"), JSON.stringify([{ url: "https://b.com", title: "B" }]));
});

test("getStored trata localStorage vazio ('') como ausente e usa GM", (t) => {
    resetStores();
    _ls.set("cat", "");
    _gm.set("cat", JSON.stringify([{ url: "https://c.com" }]));
    const got = getStored("cat");
    assert.equal(got[0].url, "https://c.com");
});

test("getStored converte strings antigas em objetos { url, title, poster }", (t) => {
    resetStores();
    _ls.set("cat", JSON.stringify(["https://a.com", "https://b.com"]));
    const got = getStored("cat");
    assert.equal(got.length, 2);
    assert.deepEqual(got[0], { url: "https://a.com", title: "", poster: "" });
});

test("getStored devolve [] para JSON inválido", (t) => {
    resetStores();
    _ls.set("cat", "{not json");
    assert.deepEqual(getStored("cat"), []);
});

test("getStored devolve [] quando o valor armazenado não é array", (t) => {
    resetStores();
    _ls.set("cat", JSON.stringify({ not: "array" }));
    assert.deepEqual(getStored("cat"), []);
});

/* ── setStored ──────────────────────────────────────────────────────────── */

test("setStored escreve em ambos localStorage e GM_storage", (t) => {
    resetStores();
    setStored("cat", [{ url: "https://a.com", title: "A" }]);
    assert.ok(_ls.has("cat"));
    assert.ok(_gm.has("cat"));
    assert.equal(_ls.get("cat"), _gm.get("cat"));
});

test("setStored deduplica via mergeData por defeito", (t) => {
    resetStores();
    setStored("cat", [
        { url: "https://a.com/?utm=1", title: "A" },
        { url: "https://a.com",        title: "A" },
    ]);
    const parsed = JSON.parse(_ls.get("cat"));
    assert.equal(parsed.length, 1);  // normUrl remove query → dedup
});

test("setStored aceita mergeFn custom (mergeDataPreferNewest)", (t) => {
    resetStores();
    const items = [
        { url: "https://a.com", title: "AA", saved_at: 1000, note: "antigo" },
        { url: "https://a.com", title: "BB", saved_at: 2000, note: "novo"   },
    ];
    setStored("notes", items, mergeDataPreferNewest);
    const parsed = JSON.parse(_ls.get("notes"));
    assert.equal(parsed.length, 1);
    // mergeDataPreferNewest prefere o saved_at mais recente (2000) e o campo
    // "note" vem do item mais recente via spread; o título passa por
    // betterTitle (que prefere o mais longo / empate → novo).
    assert.equal(parsed[0].saved_at, 2000);
    assert.equal(parsed[0].note,     "novo");
});

test("setStored aceita mergeFn custom com betterTitle próprio", (t) => {
    resetStores();
    // Simula o caso filmin: um betterTitle customizado que remove sufixos
    const customMerge = (list) => list.map(i => ({ ...i, title: (i.title || "").replace(/ - Filmin$/, "") }));
    setStored("cat", [{ url: "https://a.com", title: "A - Filmin" }], customMerge);
    const parsed = JSON.parse(_ls.get("cat"));
    assert.equal(parsed[0].title, "A");
});

test("round-trip setStored → getStored preserva os dados", (t) => {
    resetStores();
    const items = [
        { url: "https://a.com", title: "A", poster: "https://p/a.jpg" },
        { url: "https://b.com", title: "B", poster: "https://p/b.jpg" },
    ];
    setStored("cat", items);
    const got = getStored("cat");
    assert.equal(got.length, 2);
    assert.equal(got[0].url, "https://a.com");
    assert.equal(got[1].url, "https://b.com");
});
