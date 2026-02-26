/**
 * Media Sync Worker — Cloudflare Workers
 * ─────────────────────────────────────────────────────────────────────────────
 * Worker único multi-serviço para sincronizar listas de catálogos/downloads.
 *
 * SETUP:
 *   1. KV namespace  → Settings → Bindings → KV → nome: MEDIA
 *   2. Secrets       → Settings → Variables → Secrets:
 *                        API_KEY   (escrita obrigatória)
 *                        READ_KEY  (leitura, opcional — omite para usar API_KEY)
 *   3. Env vars opcionais (Settings → Variables → Environment Variables):
 *                        ALLOWED_PREFIXES  (default: ver abaixo)
 *                        ALLOWED_ORIGIN    (default: *)
 *                        MAX_BODY          (default: 10485760  = 10 MB)
 *                        MAX_ITEMS         (default: 100000)
 *
 * v1.1.0 — Timing attack fix: comparação de chaves com crypto.subtle.timingSafeEqual
 *           (secureCompare). readOK/writeOK agora assíncronos. Fix saved_at: string vazia
 *           já não passa como timestamp válido (Number("") === 0 era falso positivo).
 *
 * v1.0.0 — Versão inicial.
 *
 * ALLOWED_PREFIXES default (adiciona mais separados por vírgula):
 *   filmin_,filmtwist_,kocowa_,viki_,netflix_,disney_,sky_,max_,appletv_,prime_,opto_,rtp_,tvi_
 *
 * PROTOCOLO:
 *   GET    ?keys=key1,key2  — requer x-api-key (READ_KEY ou API_KEY)
 *   POST   { key: [...] }  — requer x-api-key (API_KEY)
 *   DELETE { purgeKey }    — apaga key inteira (requer API_KEY)
 *   DELETE { url, keys }   — remove 1 item de N keys (requer API_KEY)
 * ─────────────────────────────────────────────────────────────────────────────
 */

export default {
  async fetch(request, env) {
    const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "*";
    const MAX_BODY       = parseInt(env.MAX_BODY)  || 10 * 1024 * 1024;
    const MAX_ITEMS      = parseInt(env.MAX_ITEMS) || 100000;

    const DEFAULT_PREFIXES =
      "filmin_,filmtwist_,kocowa_,viki_,netflix_,disney_,sky_,max_,appletv_,prime_,opto_,rtp_,tvi_";

    const ALLOWED_PREFIXES = (env.ALLOWED_PREFIXES || DEFAULT_PREFIXES)
      .split(",").map(s => s.trim()).filter(Boolean);

    const corsHeaders = {
      "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
      "Access-Control-Allow-Headers": "Content-Type, x-api-key",
      "Access-Control-Max-Age":       "86400",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (!env?.MEDIA) {
      return new Response("KV binding MEDIA não configurado.", {
        status: 500, headers: corsHeaders,
      });
    }

    const isAllowedKey = (k) =>
      typeof k === "string" && ALLOWED_PREFIXES.some(p => k.startsWith(p));

    // Comparação de tempo constante — previne timing attacks
    async function secureCompare(a, b) {
      if (typeof a !== "string" || typeof b !== "string") return false;
      const enc = new TextEncoder();
      const aB  = enc.encode(a);
      const bB  = enc.encode(b);
      if (aB.byteLength !== bB.byteLength) return false;
      return crypto.subtle.timingSafeEqual(aB, bB);
    }

    // Leitura: aceita READ_KEY (se definido) ou API_KEY
    const readOK = async (req) => {
      const k = req.headers.get("x-api-key") || "";
      if (!env.READ_KEY) return secureCompare(k, env.API_KEY || "");
      return (await secureCompare(k, env.API_KEY || "")) ||
             (await secureCompare(k, env.READ_KEY || ""));
    };

    // Escrita: apenas API_KEY
    const writeOK = (req) => secureCompare(req.headers.get("x-api-key") || "", env.API_KEY || "");

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    try {
      // ── GET ──────────────────────────────────────────────────────────────
      if (request.method === "GET") {
        if (!await readOK(request)) return json({ error: "Unauthorized" }, 401);

        const url   = new URL(request.url);
        const param = url.searchParams.get("keys");
        if (!param) return json({});

        const keys = param.split(",").map(k => k.trim()).filter(isAllowedKey).slice(0, 25);
        const data = {};
        await Promise.all(keys.map(async (key) => {
          data[key] = (await env.MEDIA.get(key, { type: "json" })) || [];
        }));
        return json(data);
      }

      // ── POST ─────────────────────────────────────────────────────────────
      if (request.method === "POST") {
        if (!await writeOK(request)) return json({ error: "Unauthorized" }, 401);

        const raw = await request.text();
        if (raw.length > MAX_BODY) return json({ error: "Payload demasiado grande" }, 413);

        let body;
        try { body = JSON.parse(raw); }
        catch { return json({ error: "JSON inválido" }, 400); }
        if (!body || typeof body !== "object") return json({ error: "Body inválido" }, 400);

        await Promise.all(Object.entries(body).map(async ([key, arr]) => {
          if (!isAllowedKey(key) || !Array.isArray(arr)) return;

          // Opção B: array vazio intencional → grava "[]" para limpar a cloud
          if (arr.length === 0) {
            await env.MEDIA.put(key, "[]");
            return;
          }

          const safe = arr
            .slice(0, MAX_ITEMS)
            .filter(x => x && typeof x === "object" && typeof x.url === "string" && x.url.trim())
            .map(x => {
              const out = { ...x, url: String(x.url).trim() };
              const ts  = Number(x.saved_at);
              if (Number.isFinite(ts) && ts > 0 && String(x.saved_at).trim() !== "")
                out.saved_at = Math.floor(ts);
              else delete out.saved_at;
              return out;
            });

          // safe.length === 0 aqui significa que todos os itens falharam validação
          // (não foi intencional) → não sobrescreve dados existentes
          if (safe.length === 0) return;
          await env.MEDIA.put(key, JSON.stringify(safe));
        }));

        return json({ status: "ok" });
      }

      // ── DELETE ───────────────────────────────────────────────────────────
      if (request.method === "DELETE") {
        if (!await writeOK(request)) return json({ error: "Unauthorized" }, 401);

        const rawDel = await request.text();
        if (rawDel.length > MAX_BODY) return json({ error: "Payload demasiado grande" }, 413);
        let body;
        try { body = JSON.parse(rawDel); } catch { body = {}; }

        // Apagar key inteira
        if (body?.purgeKey) {
          const key = String(body.purgeKey).trim();
          if (!isAllowedKey(key)) return json({ error: "purge_denied" }, 403);
          await env.MEDIA.delete(key);
          return json({ status: "key_deleted", key });
        }

        // Remover 1 item de várias keys
        if (body?.url && Array.isArray(body.keys)) {
          const urlToRemove = String(body.url).trim();
          const keys = body.keys
            .map(k => String(k || "").trim())
            .filter(Boolean)
            .filter(isAllowedKey)
            .slice(0, 25);

          await Promise.all(keys.map(async (key) => {
            const cur = (await env.MEDIA.get(key, { type: "json" })) || [];
            if (!Array.isArray(cur)) return;
            const filtered = cur.filter(item => String(item?.url).trim() !== urlToRemove);
            if (filtered.length < cur.length)
              await env.MEDIA.put(key, JSON.stringify(filtered));
          }));

          return json({ status: "single_deleted_dynamically" });
        }

        return json({ status: "ignored_delete" });
      }

      return json({ error: "Method Not Allowed" }, 405);

    } catch (err) {
      return json({ error: "Internal Server Error", message: err.message }, 500);
    }
  },
};
