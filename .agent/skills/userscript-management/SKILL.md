---
name: Gestão de Userscripts Media-Sync
description: Regras e convenções sobre como construir e gerir os userscripts que interagem com o Worker do media-sync (Cloudflare KV).
---

# Gestão de Userscripts e Cloudflare Worker

Quando estiveres a trabalhar no código do `media-sync` deves seguir estas normas rigorosamente.

## 1. Regras do Backend (Cloud Worker)
- O Worker lida com múltiplos serviços baseados em **Prefixos KV**.
- As keys seguem a nomenclatura predefinida: `{prefixo}_catalog`, `{prefixo}_downloaded`, `{prefixo}_download_list`, `{prefixo}_extra_field`.
- Qualquer novo prefixo tem que ser adicionado à configuração global `ALLOWED_PREFIXES` (se usado), para que os pedidos não sejam barrados.

## 2. Padrões de Frontend (Userscripts)
- Não colocamos **NUNCA** a `API_KEY` hardcoded nos scripts que vão para o GitHub. É uma variável pessoal. O frontend deve criar sempre a sua interface em DOM ("Gerir APIs cloud") para o utilizador colar lá os seus dados (que ficam em `localStorage` com `GM_setValue`).
- Todos os endpoints devem efetuar os pedidos (GET/POST/DELETE) usando os headers corretos incluindo `x-api-key`.
- Exemplo de um GET call: `/?keys=prefix_catalog` + cabeçalho `x-api-key: xyz`.

## 3. Scripts Isolados
- O `simkl-watched.user.js` é um script isolado. Comunica diretamente com a API do Simkl por OAuth. Não o mistures com o Cloudflare Worker do projeto.
