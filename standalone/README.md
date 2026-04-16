# standalone/ — Userscripts Independentes

Scripts que **não usam o Cloudflare Worker** deste repositório e não passam pelo pipeline Rollup. Vivem à parte por escolha arquitetural.

| Script | Porquê está fora do pipeline |
|---|---|
| `simkl-watched.user.js` | Comunica direto com `api.simkl.com` via OAuth. Não partilha lógica de cloud/storage/merge com os outros serviços. |

Para instalar, abre o ficheiro e clica **Raw** no GitHub — o Tampermonkey deteta automaticamente.
