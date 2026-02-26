# media-sync

Userscripts de gestão de catálogo, downloads e sincronização cloud para serviços de streaming portugueses e internacionais.

Arquitetura: **1 Cloudflare Worker** (backend partilhado) + **1 userscript por serviço** (frontend isolado) + **1 userscript Simkl** (overlay de visionados, independente).

---

## Versões actuais

| Script | Versão |
|---|---|
| `services/filmin.user.js` | v5.5.17 |
| `services/filmtwist.user.js` | v1.8.1 |
| `services/simkl-watched.user.js` | v1.0.0 |
| `worker/worker.js` | v1.1.0 |

---

## Estrutura do repositório

```
media-sync/
├── worker/
│   └── worker.js                   # Worker Cloudflare — backend único multi-serviço
├── wrangler.toml                   # Configuração de deploy (Wrangler CLI)
├── services/
│   ├── filmin.user.js              # Filmin.pt — catálogo, downloads, cloud sync
│   ├── filmtwist.user.js           # FilmTwist.pt — catálogo, downloads, cloud sync
│   └── simkl-watched.user.js       # Todos os sites — overlay "Visto" via API Simkl
└── README.md
```

---

## Serviços suportados

### Scripts de catálogo/cloud (requerem Worker)

| Serviço | Prefixo KV | Script |
|---|---|---|
| Filmin.pt | `filmin_` | `services/filmin.user.js` |
| FilmTwist.pt | `filmtwist_` | `services/filmtwist.user.js` |
| Kocowa | `kocowa_` | — em breve |
| Viki | `viki_` | — em breve |
| Netflix | `netflix_` | — em breve |
| Disney+ | `disney_` | — em breve |
| SkyShowtime | `sky_` | — em breve |
| Max (HBO) | `max_` | — em breve |
| Apple TV+ | `appletv_` | — em breve |
| Prime Video | `prime_` | — em breve |
| Opto | `opto_` | — em breve |
| RTP Play | `rtp_` | — em breve |
| TVI Player | `tvi_` | — em breve |

### Script de overlay Simkl (independente, sem Worker)

| Serviço | Suporte |
|---|---|
| Filmin.pt | ✓ |
| FilmTwist.pt | ✓ |
| Outros (futuro) | adicionar `@match` |

---

## Setup do Worker (Cloudflare)

### 1. Pré-requisitos

- Conta Cloudflare (plano gratuito chega)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) instalado: `npm install -g wrangler`
- Autenticado: `wrangler login`

### 2. Estrutura de ficheiros no repo

O `wrangler.toml` aponta para `main = "worker/worker.js"`. Garante que o ficheiro está em:
```
media-sync/
└── worker/
    └── worker.js   ← aqui
```

### 3. Criar o namespace Workers KV

#### Via dashboard
**Storage & databases → Workers KV → Create instance** → nome sugerido: `MEDIA_KV`

#### Via CLI
```bash
npx wrangler kv namespace create MEDIA
```

O Wrangler devolve o `id` gerado. Adiciona-o ao `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "MEDIA"          # nome usado no código (env.MEDIA)
id = "YOUR_KV_NAMESPACE_ID"  # ← substitui pelo id real do teu namespace
```

> **Sobre o `id` do namespace:** não é segredo — podes colocá-lo no repositório público sem problema. O que **nunca deve ir para o GitHub** são os secrets: `API_KEY`, `READ_KEY`, tokens e `.dev.vars`.

### 4. Definir os segredos

```bash
wrangler secret put API_KEY     # chave de escrita (obrigatório)
wrangler secret put READ_KEY    # chave de leitura separada (opcional)
```

> **Nota:** Nunca coloques segredos no `wrangler.toml` ou em commits.

### 5. (Opcional) Variáveis de ambiente

Descomenta a secção `[vars]` no `wrangler.toml` e ajusta:

```toml
[vars]
ALLOWED_ORIGIN   = "*"
ALLOWED_PREFIXES = "filmin_,filmtwist_,..."
MAX_BODY         = "10485760"
MAX_ITEMS        = "100000"
```

Para adicionar um novo serviço no futuro, basta acrescentar o prefixo aqui — sem mudar o código do Worker.

### 6. Deploy

```bash
wrangler deploy
```

O URL do Worker ficará em: `https://media-sync.<teu-subdomínio>.workers.dev`

---

## Protocolo da API

Todos os pedidos requerem o header `x-api-key`.

| Método | Exemplo | Auth | Descrição |
|---|---|---|---|
| `GET` | `?keys=filmin_catalog_paid,filmin_downloaded_paid` | READ_KEY ou API_KEY | Lê as keys indicadas. **O parâmetro `?keys=` é obrigatório** — sem ele devolve `{}`. |
| `POST` | `{ "filmin_catalog_paid": [...] }` | API_KEY | Escreve/atualiza keys. Array vazio `[]` limpa a key na cloud (intencional). |
| `DELETE` | `{ "purgeKey": "filmin_catalog_paid" }` | API_KEY | Apaga key inteira — forma recomendada para limpar dados. |
| `DELETE` | `{ "url": "https://...", "keys": ["filmin_catalog_paid"] }` | API_KEY | Remove 1 item de N keys. |

> **READ_KEY vs API_KEY**: `API_KEY` dá acesso total (leitura + escrita). `READ_KEY` é opcional — se definido, permite leitura sem expor a chave de escrita. Útil para partilhar acesso de leitura com outros dispositivos.

### Exemplo de pedido GET

```js
const res = await fetch("https://media-sync.xxx.workers.dev?keys=filmin_catalog_paid,filmin_downloaded_paid", {
  headers: { "x-api-key": "a-tua-read-key" }
});
const data = await res.json();
// { "filmin_catalog_paid": [...], "filmin_downloaded_paid": [...] }
```

---

## Instalar os Userscripts

1. Instala a extensão [Tampermonkey](https://www.tampermonkey.net/)
2. Abre o ficheiro `.user.js` desejado (em `services/`)
3. Clica **Raw** no GitHub — o Tampermonkey detecta e instala automaticamente
4. Para scripts de catálogo: abre o site → painel no canto → **Gerir APIs cloud** → URL do Worker + API Key
5. Para o Simkl: vê a secção abaixo

---

## Setup do Simkl Watched Overlay

O script `simkl-watched.user.js` é **independente** — não precisa do Worker. Liga directamente à API do Simkl e sobrepõe um badge ✓ verde nos cards de filmes/séries já vistos.

### 1. Criar app Simkl

1. Vai a `https://simkl.com/settings/developer/`
2. Clica **Add** → preenche:
   - **Name:** qualquer nome (ex: `Simkl Watched Overlay`)
   - **Redirect URI:** `urn:ietf:wg:oauth:2.0:oob`
3. Grava → copia o **Client ID**

### 2. Configurar o script

Abre `services/simkl-watched.user.js` e substitui na linha indicada:

```js
const SIMKL_CLIENT_ID = "COLOCA_AQUI_O_SEU_CLIENT_ID";
//                       ↑ cola aqui o Client ID da tua app
```

### 3. Autenticar

1. Abre FilmTwist ou Filmin
2. Clica no botão **escudo** (canto inferior esquerdo)
3. Clica **Login** → aparece modal com código PIN
4. Abre o link, faz login no Simkl, introduz o PIN
5. O script sincroniza automaticamente e aplica os overlays

### Como funciona o matching

O script associa os títulos da página com a tua lista Simkl por **título + ano**. Para a maioria dos casos funciona automaticamente. Em caso de conflito (mesmo nome, ano diferente, título em língua diferente):

1. Passa o rato sobre o card → aparece botão ✏
2. Clica → modal de pesquisa → procura no Simkl → **Selecionar**
3. O override é guardado localmente e tem sempre prioridade sobre o matching automático

A cache Simkl renova-se automaticamente a cada **6 horas**.

---

## Configuração por utilizador

Cada utilizador deve ter o **seu próprio Worker** (deploy separado) para garantir que os dados são privados e a `API_KEY` não é partilhada.

O processo é:
1. Fork deste repo (ou usa como template)
2. Segue o setup acima com a tua conta Cloudflare
3. Configura o URL + chave no script via **Gerir APIs cloud**

Para o Simkl, cada utilizador cria a sua própria app em `simkl.com/settings/developer/` — o Client ID é público (não é um segredo).

---

## Convenção de keys KV

Cada serviço usa um prefixo fixo. As keys geradas por cada script:

```
{prefixo}_catalog          # catálogo/histórico visto
{prefixo}_downloaded       # transferidos definitivamente
{prefixo}_download_list    # copiados temporários (para download)
{prefixo}_extra_field      # notas de série (episódio atual, etc.)
```

Exceção — **Filmin** tem distinção pago/grátis:
```
filmin_catalog_paid
filmin_catalog_free
filmin_downloaded_paid
filmin_downloaded_free
filmin_download_list
filmin_extra_field
```

---

## Licença

MIT — livre para uso pessoal e adaptação.
