---
description: Fazer deploy do backend (Cloudflare Worker) do media-sync
---

# Deploy do Cloudflare Worker

Este workflow executa o deploy da versão atual do Cloudflare Worker para a conta configurada.

1. Navegar para a diretoria raiz do projeto `media-sync`.
2. Executar o comando de deploy:

// turbo
```powershell
npx wrangler deploy
```

> [!NOTE]
> Garanta que está autenticado com o Wrangler (`npx wrangler login`) antes de executar. O worker vai ser enviado para o seu namespace associado.
