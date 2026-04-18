/**
 * Testes unitários para core/cloud.js.
 *
 * Corre com:  npm test
 *
 * Cobre apenas a lógica pura testável sem mocks pesados:
 *   - _parseRetryAfter (header parsing)
 *   - createCloudSync().getApiColor (hash determinístico)
 *
 * fetchCloudStores / saveStoresToCloud / removeUrlFromCloud não são testados
 * aqui — dependem de fetch + GM_getValue/GM_setValue, fora do âmbito de testes
 * unitários puros.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { _parseRetryAfter, createCloudSync } = await import("./cloud.js");

/** Cria um objeto mínimo do tipo Response com apenas `.headers.get()`. */
const fakeRes = (retryAfter) => ({
    headers: { get: (name) => name === "Retry-After" ? retryAfter : null },
});

/* ── _parseRetryAfter ───────────────────────────────────────────────────── */

test("_parseRetryAfter devolve null quando o header está ausente", () => {
    assert.equal(_parseRetryAfter(fakeRes(null)), null);
    assert.equal(_parseRetryAfter(fakeRes(undefined)), null);
});

test("_parseRetryAfter converte segundos em ms", () => {
    assert.equal(_parseRetryAfter(fakeRes("5")), 5000);
    assert.equal(_parseRetryAfter(fakeRes("0")), 0);
    assert.equal(_parseRetryAfter(fakeRes("30")), 30000);
});

test("_parseRetryAfter limita o atraso a 60s", () => {
    assert.equal(_parseRetryAfter(fakeRes("120")), 60000);
    assert.equal(_parseRetryAfter(fakeRes("9999")), 60000);
});

test("_parseRetryAfter aceita data HTTP no futuro", () => {
    const future = new Date(Date.now() + 10000).toUTCString();
    const delay  = _parseRetryAfter(fakeRes(future));
    assert.ok(delay >= 8000 && delay <= 10000, `esperava ~10s, obtive ${delay}`);
});

test("_parseRetryAfter devolve 0 para data HTTP no passado", () => {
    const past = new Date(Date.now() - 10000).toUTCString();
    assert.equal(_parseRetryAfter(fakeRes(past)), 0);
});

test("_parseRetryAfter devolve null para valores inválidos", () => {
    assert.equal(_parseRetryAfter(fakeRes("abc")), null);
    assert.equal(_parseRetryAfter(fakeRes("")), null);
});

test("_parseRetryAfter rejeita segundos negativos como retry imediato", () => {
    // Number("-1") é finito mas < 0, logo cai no ramo de data.
    // Date.parse("-1") em Node devolve um timestamp no passado → delta ≤ 0 → 0.
    // Resultado: retry imediato, que é seguro (nunca atrasa indefinidamente).
    assert.equal(_parseRetryAfter(fakeRes("-1")), 0);
});

/* ── createCloudSync ────────────────────────────────────────────────────── */

test("createCloudSync devolve a forma esperada", () => {
    const c = createCloudSync({ obfKey: "TESTE_KEY", storeApiConfigsKey: "x_cfg" });
    assert.equal(typeof c.getApiConfigs, "function");
    assert.equal(typeof c.setApiConfigs, "function");
    assert.equal(typeof c.getApiColor,   "function");
});

test("getApiColor com apiKey configurada devolve azul", () => {
    const c = createCloudSync({ obfKey: "K", storeApiConfigsKey: "x" });
    const configs = [{ name: "primary", apiKey: "abc123" }];
    assert.equal(c.getApiColor("primary", configs), "#3b82f6");
});

test("getApiColor sem apiKey devolve cor HSL determinística", () => {
    const c = createCloudSync({ obfKey: "K", storeApiConfigsKey: "x" });
    const configs = [{ name: "anon" }];  // sem apiKey
    const color   = c.getApiColor("anon", configs);
    assert.match(color, /^hsl\(\d+, 85%, 65%\)$/);
});

test("getApiColor é determinístico — mesmo nome devolve mesma cor", () => {
    const c = createCloudSync({ obfKey: "K", storeApiConfigsKey: "x" });
    const a = c.getApiColor("teste", []);
    const b = c.getApiColor("teste", []);
    assert.equal(a, b);
});

test("getApiColor distingue nomes diferentes (provável)", () => {
    // Não é garantido — duas strings podem colidir no hash — mas para estes
    // três nomes simples sabemos por inspeção que devolvem hues diferentes.
    const c = createCloudSync({ obfKey: "K", storeApiConfigsKey: "x" });
    const colors = ["alpha", "beta", "gamma"].map(n => c.getApiColor(n, []));
    assert.equal(new Set(colors).size, 3);
});

test("getApiColor para api sem entrada nos configs trata como sem apiKey", () => {
    const c = createCloudSync({ obfKey: "K", storeApiConfigsKey: "x" });
    const color = c.getApiColor("desconhecido", [{ name: "outro", apiKey: "k" }]);
    assert.match(color, /^hsl\(/);
});
