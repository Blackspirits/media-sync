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
 * v1.2.1 — Correções:
 *           · Guard explícito quando API_KEY não está configurada (evita o
 *             fallback "" === "" que abria o Worker a qualquer pedido sem header);
 *           · parseInt com radix 10 em MAX_BODY / MAX_ITEMS / Content-Length;
 *           · GET /list devolve agora { truncated: true } quando atinge o cap
 *             de páginas em vez de truncar silenciosamente.
 *
 * v1.2.0 — Hardening + debugging:
 *           · POST/DELETE exigem Content-Type: application/json (415 se não for);
 *           · MAX_BODY agora verificado em bytes (UTF-8), não em caracteres UTF-16;
 *           · Pré-check por Content-Length antes de ler o body (rejeita cedo);
 *           · Novo endpoint GET /list — inventário de todas as keys KV (paginado);
 *           · Método HEAD responde 200 (health checks);
 *           · 500 já não expõe err.message (log em console.error).
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
    const MAX_BODY  = parseInt(env.MAX_BODY, 10)  || 10 * 1024 * 1024;
    const MAX_ITEMS = parseInt(env.MAX_ITEMS, 10) || 100000;

    const DEFAULT_PREFIXES =
      "filmin_,filmtwist_,kocowa_,viki_,netflix_,disney_,sky_,max_,appletv_,prime_,opto_,rtp_,tvi_,zigzag_,panda_,tvcine_,meogo_";

    const ALLOWED_PREFIXES = (env.ALLOWED_PREFIXES || DEFAULT_PREFIXES)
      .split(",").map(s => s.trim()).filter(Boolean);

    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Headers": "Content-Type, x-api-key",
      "Access-Control-Max-Age": "86400",
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

    // Sem API_KEY definida, qualquer comparação contra "" passaria — ou seja,
    // um pedido sem header x-api-key ganharia acesso total. Falhamos cedo com
    // 500 para evitar que uma deploy incompleta abra o Worker ao mundo.
    if (!env.API_KEY) {
      console.error("API_KEY secret não está definida — Worker bloqueado.");
      return new Response("API_KEY not configured on this Worker.", {
        status: 500, headers: corsHeaders,
      });
    }

    const isAllowedKey = (k) =>
      typeof k === "string" && ALLOWED_PREFIXES.some(p => k.startsWith(p));

    // Comparação de tempo constante — previne timing attacks
    async function secureCompare(a, b) {
      if (typeof a !== "string" || typeof b !== "string") return false;
      const enc = new TextEncoder();
      const aB = enc.encode(a);
      const bB = enc.encode(b);
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
    const writeOK = async (req) => secureCompare(req.headers.get("x-api-key") || "", env.API_KEY || "");

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    try {
      // ── GET ──────────────────────────────────────────────────────────────
      if (request.method === "GET") {
        if (!await readOK(request)) return json({ error: "Unauthorized" }, 401);

        const url = new URL(request.url);

        // GET /list → inventário de todas as keys KV (metadados, sem valores)
        // Útil para debugging e auditoria. Pagina automaticamente.
        if (url.pathname === "/list") {
          const MAX_PAGES = 20; // cap para evitar varrer um namespace gigante
          const keys = [];
          let cursor;
          let pages = 0;
          let truncated = false;
          do {
            const page = await env.MEDIA.list({ cursor, limit: 1000 });
            for (const k of page.keys) {
              // Filtrar por prefixos permitidos — evita expor keys "estranhas"
              if (!isAllowedKey(k.name)) continue;
              keys.push({
                name: k.name,
                expiration: k.expiration || null,
                metadata: k.metadata || null,
              });
            }
            cursor = page.list_complete ? null : page.cursor;
            pages++;
            if (pages >= MAX_PAGES && cursor) { truncated = true; break; }
          } while (cursor);
          return json({ count: keys.length, truncated, keys });
        }

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

        // Content-Type deve ser application/json (tolerante a charset)
        const ct = (request.headers.get("Content-Type") || "").toLowerCase();
        if (!ct.includes("application/json"))
          return json({ error: "Content-Type must be application/json" }, 415);

        // Pré-check por Content-Length (barato) — evita ler corpos enormes
        const declaredLen = parseInt(request.headers.get("Content-Length") || "0", 10);
        if (!Number.isFinite(declaredLen) || declaredLen < 0)
          return json({ error: "Content-Length inválido" }, 400);
        if (declaredLen > MAX_BODY) return json({ error: "Payload demasiado grande" }, 413);

        const raw = await request.text();
        // Pós-check em bytes reais (UTF-8), não em caracteres UTF-16
        if (new TextEncoder().encode(raw).byteLength > MAX_BODY)
          return json({ error: "Payload demasiado grande" }, 413);

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
              const ts = Number(x.saved_at);
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

        // DELETE com body: exigir Content-Type JSON (se houver body)
        const ct = (request.headers.get("Content-Type") || "").toLowerCase();
        if (ct && !ct.includes("application/json"))
          return json({ error: "Content-Type must be application/json" }, 415);

        const declaredLen = parseInt(request.headers.get("Content-Length") || "0", 10);
        if (!Number.isFinite(declaredLen) || declaredLen < 0)
          return json({ error: "Content-Length inválido" }, 400);
        if (declaredLen > MAX_BODY) return json({ error: "Payload demasiado grande" }, 413);

        const rawDel = await request.text();
        if (new TextEncoder().encode(rawDel).byteLength > MAX_BODY)
          return json({ error: "Payload demasiado grande" }, 413);

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

      // ── HEAD ─────────────────────────────────────────────────────────────
      // Usado por alguns clientes para health checks — devolve 200 sem body.
      if (request.method === "HEAD") {
        return new Response(null, { status: 200, headers: corsHeaders });
      }

      return json({ error: "Method Not Allowed" }, 405);

    } catch (err) {
      // Não expor err.message em produção — pode vazar detalhes internos
      console.error("Unhandled error:", err);
      return json({ error: "Internal Server Error" }, 500);
    }
  },
};
