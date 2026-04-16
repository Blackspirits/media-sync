# Media-Sync — Instruções para Agentes IA

Guia de contexto e regras para qualquer agente que trabalhe neste repositório.
Lê este ficheiro antes de qualquer alteração.

---

## TL;DR (lê sempre primeiro)

- Backend: 1 Cloudflare Worker + KV namespace (`MEDIA`)
- Frontend: 1 userscript por serviço, construído via Rollup (`src/services/ → dist/`)
- Módulos partilhados em `src/core/` — nunca duplicar lógica que já existe aí
- Segredos nunca em código — apenas em headers (`x-api-key`)
- Prefixos KV autorizados: definidos em `worker/worker.js` (`DEFAULT_PREFIXES`) — não em `wrangler.toml`
- `simkl-watched.user.js` é independente do Worker e do pipeline — não tocar na sua arquitetura

---

## Estrutura do repositório

```
src/
  core/          ← módulos partilhados (merge, storage, image-cache, toast, icons, cloud)
  services/      ← fonte de verdade dos userscripts (ES modules com imports do core)
    filmin.js
    filmtwist.js  ← referência de arquitetura para novos serviços
    pandaplus.js
    tvcine.js
    zigzag.js

dist/            ← bundles IIFE gerados pelo Rollup (não editar manualmente)
standalone/      ← scripts independentes fora do pipeline (ex.: simkl-watched)
wip/             ← scripts em desenvolvimento, ainda não migrados para src/services/
worker/
  worker.js      ← Cloudflare Worker (único backend)
wrangler.toml    ← configuração de deploy (KV binding, vars de ambiente)
rollup.config.js ← pipeline de build
```

---

## Arquitetura

### Backend — Cloudflare Worker

- Ficheiro: `worker/worker.js`
- KV binding: `MEDIA` (não `MEDIA_KV`)
- Prefixos autorizados: constante `DEFAULT_PREFIXES` em `worker/worker.js` — **é aqui que se acrescenta um prefixo novo, não no `wrangler.toml`**
- Autenticação: `API_KEY` (escrita) e `READ_KEY` (leitura) como Secrets no dashboard da Cloudflare

### Frontend — Userscripts

- Fonte de verdade: `src/services/*.js` (ES modules)
- Output de distribuição: `dist/*.user.js` (gerado pelo Rollup — não editar)
- Script de referência para novos serviços: `src/services/filmtwist.js`

### Excepção documentada — simkl-watched

`services/simkl-watched.user.js` **não usa o Worker nem o KV**. Opera por OAuth directamente com `api.simkl.com` e injeta overlays DOM no FilmTwist e no Filmin. É um script completamente independente, fora do pipeline `src → dist`. Não o migres para `src/services/` nem o incluas no Rollup.

---

## Esquema de KV keys

| Finalidade | Formato | Exemplo (filmin) |
|---|---|---|
| Catálogo | `{prefix}_catalog` | `filmin_catalog` |
| Transferidos | `{prefix}_downloaded` | `filmin_downloaded` |
| Lista de cópias | `{prefix}_download_list` | `filmin_download_list` |
| Campo extra (notas) | `{prefix}_extra_field` | `filmin_extra_field` |
| Config APIs cloud | `{prefix}_api_configs` | `filmin_api_configs` |

**Excepções:** O Filmin distingue catálogo pago/gratuito: `filmin_catalog_paid` e `filmin_catalog_free`.

---

## Regras críticas

### ✅ Obrigatório

- Importar de `src/core/` em vez de duplicar lógica (merge, storage, toast, cloud, icons, image-cache)
- Enviar segredos apenas em headers HTTP (`x-api-key`)
- Usar `MutationObserver` para DOM renderizado tardiamente (React/Vue/Nuxt)
- Acrescentar novo prefixo ao `DEFAULT_PREFIXES` em `worker/worker.js` quando adicionares um serviço
- Reconstruir `dist/` (`npm run build`) e commitar os bundles antes de fazer merge em PR

### ❌ Proibido

- `const API_KEY = "valor-real"` — nunca hardcoded
- Commitar `.env` ou `.dev.vars` com valores reais
- `console.log` de segredos
- Enviar segredos em querystring (`?api_key=...`)
- Editar ficheiros em `dist/` manualmente
- Duplicar funções que já existem em `src/core/`

### ⚠️ Atenção

- `ALLOWED_ORIGIN = "*"` é permissivo — em produção restringir por domínio no dashboard ou em bloco `[env]` do `wrangler.toml`
- Seletores DOM: preferir `data-*` > IDs estáveis > ARIA roles > texto visível (último recurso)
- `dist/` está versionado — o CI verifica que está em sync com `src/` em cada PR

---

## Como adicionar um novo serviço

1. Escolher prefixo (minúsculas, underscore, ex: `novosite_`)
2. Acrescentar prefixo ao `DEFAULT_PREFIXES` em `worker/worker.js`
3. Copiar `src/services/filmtwist.js` → `src/services/novosite.js`
4. Ajustar: metablock `@match`, constantes de store, `CARD_ROOT_SELECTOR`, `createImageCache("novosite_img_cache_db")`, `createCloudSync({ obfKey, storeApiConfigsKey })`
5. Acrescentar `"novosite"` ao array `SERVICES` em `rollup.config.js`
6. Acrescentar `"build:novosite": "rollup -c --environment SERVICE:novosite"` ao `package.json`
7. Correr `npm run build` e commitar `src/services/novosite.js` + `dist/novosite.user.js`
8. Deploy do Worker se o prefixo for novo: `npx wrangler deploy`

---

## Contrato Worker ↔ userscript

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| GET | `?keys=k1,k2` | `x-api-key` (READ_KEY ou API_KEY) | Lê N keys em paralelo |
| POST | `/` body `{key: [...]}` | `x-api-key` (API_KEY) | Escreve/merge arrays |
| DELETE | `/` body `{url, keys:[...]}` | `x-api-key` (API_KEY) | Remove 1 item de N keys |
| DELETE | `/` body `{purgeKey}` | `x-api-key` (API_KEY) | Apaga key inteira |

Respostas de erro a tratar no userscript:
- `401` / `403` → chave inválida ou em falta
- `429` → rate limit — aguardar antes de retry

---

## Comandos úteis

```bash
npm run build              # constrói todos os serviços
npm run build:filmin       # constrói só o filmin (idem para os outros)
npx wrangler dev           # testa o Worker localmente
npx wrangler deploy        # faz deploy do Worker para produção
```

---

## Definition of Done (checklist antes de merge)

- [ ] Sem segredos hardcoded nem commitados
- [ ] Keys KV seguem o esquema definido acima
- [ ] Novo prefixo acrescentado ao `DEFAULT_PREFIXES` do Worker
- [ ] `npm run build` corre sem erros
- [ ] `dist/` commitado e em sync com `src/`
- [ ] DOM: sem seletores instáveis (ou documentados quando inevitáveis)
- [ ] `npx wrangler dev` testado se o Worker foi alterado
