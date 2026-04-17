/**
 * Testes unitários para core/merge.js.
 *
 * Corre com:  npm test
 * (equivalente a: node --test src/core/merge.test.js)
 *
 * Os helpers de URL dependem de `location.origin` em runtime (browser/Tampermonkey).
 * Em Node definimos um stub antes de importar o módulo.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// Stub de `location` — merge.js usa-o como default em toAbsUrl()
globalThis.location = { origin: "https://example.com" };

const {
    toObj,
    safeTrim,
    isValidHttpUrl,
    toAbsUrl,
    normUrl,
    betterPoster,
    makeBetterTitle,
    betterTitle,
    mergeData,
    mergeDataPreferNewest,
} = await import("./merge.js");

/* ── toObj ──────────────────────────────────────────────────────────────── */

test("toObj devolve null para valores nulos", () => {
    assert.equal(toObj(null), null);
    assert.equal(toObj(undefined), null);
    assert.equal(toObj(0), null);
    assert.equal(toObj(42), null);
});

test("toObj converte strings num objeto com url e campos vazios", () => {
    assert.deepEqual(
        toObj("https://x.com/a"),
        { url: "https://x.com/a", title: "", poster: "" }
    );
});

test("toObj devolve o próprio objeto quando já é objeto", () => {
    const o = { url: "https://x.com/a", title: "T" };
    assert.equal(toObj(o), o);
});

/* ── safeTrim ───────────────────────────────────────────────────────────── */

test("safeTrim trata null/undefined como string vazia", () => {
    assert.equal(safeTrim(null), "");
    assert.equal(safeTrim(undefined), "");
    assert.equal(safeTrim(""), "");
    assert.equal(safeTrim("  hello  "), "hello");
});

/* ── isValidHttpUrl ─────────────────────────────────────────────────────── */

test("isValidHttpUrl aceita http e https", () => {
    assert.equal(isValidHttpUrl("http://x.com"), true);
    assert.equal(isValidHttpUrl("https://x.com/a/b"), true);
});

test("isValidHttpUrl rejeita protocolos inválidos ou URLs vazias", () => {
    assert.equal(isValidHttpUrl(""), false);
    assert.equal(isValidHttpUrl("ftp://x.com"), false);
    assert.equal(isValidHttpUrl("javascript:alert(1)"), false);
    assert.equal(isValidHttpUrl("/caminho/relativo"), false);
    assert.equal(isValidHttpUrl(null), false);
});

/* ── toAbsUrl ───────────────────────────────────────────────────────────── */

test("toAbsUrl devolve URLs absolutas sem as alterar", () => {
    assert.equal(toAbsUrl("https://a.com/x"), "https://a.com/x");
    assert.equal(toAbsUrl("http://a.com/x"), "http://a.com/x");
});

test("toAbsUrl resolve caminhos relativos contra o origin", () => {
    assert.equal(
        toAbsUrl("/filme/x", "https://filmin.pt"),
        "https://filmin.pt/filme/x"
    );
});

test("toAbsUrl usa location.origin como fallback", () => {
    assert.equal(toAbsUrl("/x"), "https://example.com/x");
});

test("toAbsUrl devolve a própria string quando é inválida", () => {
    assert.equal(toAbsUrl(""), "");
});

/* ── normUrl ────────────────────────────────────────────────────────────── */

test("normUrl remove query string", () => {
    assert.equal(
        normUrl("https://x.com/a?utm=1&ref=foo"),
        "https://x.com/a"
    );
});

test("normUrl remove hash fragment (regressão do bug #1)", () => {
    assert.equal(
        normUrl("https://filmin.pt/filme/x#modal"),
        "https://filmin.pt/filme/x"
    );
    assert.equal(
        normUrl("https://filmin.pt/filme/x#t=10"),
        "https://filmin.pt/filme/x"
    );
});

test("normUrl remove query + hash em conjunto", () => {
    assert.equal(
        normUrl("https://x.com/a?b=1#c"),
        "https://x.com/a"
    );
});

test("normUrl remove barra final", () => {
    assert.equal(normUrl("https://x.com/a/"), "https://x.com/a");
    // raiz preserva-se: "https://x.com/" → "https://x.com"
    assert.equal(normUrl("https://x.com/"), "https://x.com");
});

test("normUrl normaliza relativas para absolutas", () => {
    assert.equal(normUrl("/filme/x"), "https://example.com/filme/x");
});

test("normUrl trata string vazia", () => {
    assert.equal(normUrl(""), "");
    assert.equal(normUrl(null), "");
});

/* ── betterPoster ───────────────────────────────────────────────────────── */

test("betterPoster prefere o novo quando é um URL http longo válido", () => {
    assert.equal(
        betterPoster("https://cdn.com/poster.jpg", ""),
        "https://cdn.com/poster.jpg"
    );
});

test("betterPoster rejeita URLs curtos (<= 8 chars)", () => {
    assert.equal(
        betterPoster("x.png", "https://cdn.com/old.jpg"),
        "https://cdn.com/old.jpg"
    );
    assert.equal(
        betterPoster("", "https://cdn.com/old.jpg"),
        "https://cdn.com/old.jpg"
    );
});

test("betterPoster rejeita URLs não-HTTP", () => {
    assert.equal(
        betterPoster("/img/poster.jpg", "https://cdn.com/old.jpg"),
        "https://cdn.com/old.jpg"
    );
});

/* ── makeBetterTitle / betterTitle ──────────────────────────────────────── */

test("betterTitle devolve o título mais longo (regressão do bug #2)", () => {
    // O novo "Matrix" (6 chars) NÃO pode sobrepor-se a "The Matrix Reloaded"
    assert.equal(
        betterTitle("Matrix", "The Matrix Reloaded"),
        "The Matrix Reloaded"
    );
    // Mas se o novo for mais descritivo, ganha
    assert.equal(
        betterTitle("The Matrix Reloaded", "Matrix"),
        "The Matrix Reloaded"
    );
});

test("betterTitle devolve o título existente quando o novo está vazio", () => {
    assert.equal(betterTitle("", "Old Title"), "Old Title");
});

test("betterTitle devolve o novo quando o antigo está vazio", () => {
    assert.equal(betterTitle("New Title", ""), "New Title");
});

test("betterTitle rejeita títulos novos com menos de 3 chars", () => {
    assert.equal(betterTitle("ab", "Title"), "Title");
});

test("makeBetterTitle com suffixRe remove sufixos antes de comparar", () => {
    const bt = makeBetterTitle(/ — Filmin$/);
    assert.equal(
        bt("X — Filmin", "X"),
        "X"
    );
});

/* ── mergeData ──────────────────────────────────────────────────────────── */

test("mergeData deduplica por URL normalizada", () => {
    const merged = mergeData([
        { url: "https://x.com/a",        title: "A" },
        { url: "https://x.com/a?ref=1",  title: "A" },
        { url: "https://x.com/a#modal",  title: "A" },
        { url: "https://x.com/a/",       title: "A" },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].url, "https://x.com/a");
});

test("mergeData preserva o saved_at mais antigo", () => {
    const merged = mergeData([
        { url: "https://x.com/a", saved_at: 1000 },
        { url: "https://x.com/a", saved_at: 2000 },
    ]);
    assert.equal(merged[0].saved_at, 1000);
});

test("mergeData aplica betterTitle na resolução de conflitos", () => {
    const merged = mergeData([
        { url: "https://x.com/a", title: "The Matrix Reloaded" },
        { url: "https://x.com/a", title: "Matrix" },
    ]);
    assert.equal(merged[0].title, "The Matrix Reloaded");
});

test("mergeData aplica betterPoster na resolução de conflitos", () => {
    const merged = mergeData([
        { url: "https://x.com/a", poster: "https://cdn.com/old.jpg" },
        { url: "https://x.com/a", poster: "" },
    ]);
    assert.equal(merged[0].poster, "https://cdn.com/old.jpg");
});

test("mergeData converte strings simples em objetos", () => {
    const merged = mergeData(["https://x.com/a"]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].url, "https://x.com/a");
    assert.equal(merged[0].title, "");
});

test("mergeData ignora entradas sem URL", () => {
    const merged = mergeData([
        null,
        undefined,
        {},
        { title: "sem url" },
        { url: "" },
        { url: "https://x.com/a" },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].url, "https://x.com/a");
});

test("mergeData aceita array vazio e devolve array vazio", () => {
    assert.deepEqual(mergeData([]), []);
    assert.deepEqual(mergeData(null), []);
    assert.deepEqual(mergeData(undefined), []);
});

/* ── mergeDataPreferNewest ──────────────────────────────────────────────── */

test("mergeDataPreferNewest preserva o saved_at mais recente", () => {
    const merged = mergeDataPreferNewest([
        { url: "https://x.com/a", saved_at: 1000, note: "antigo" },
        { url: "https://x.com/a", saved_at: 2000, note: "recente" },
    ]);
    assert.equal(merged[0].saved_at, 2000);
    assert.equal(merged[0].note, "recente");
});

test("mergeDataPreferNewest ainda deduplica por URL normalizada", () => {
    const merged = mergeDataPreferNewest([
        { url: "https://x.com/a?q=1", saved_at: 1 },
        { url: "https://x.com/a#h",   saved_at: 2 },
    ]);
    assert.equal(merged.length, 1);
});
