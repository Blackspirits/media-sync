---
description: Criar um template de userscript para um novo servico de streaming
---

# Novo Serviço de Streaming

Este workflow orienta a criação de um novo userscript básico para um serviço de streaming como a HBO, Prime, Opto, etc.

1. Pedir o nome do serviço e o URL base (match pattern).
2. Definir o **prefixo KV**. Por exemplo, para HBO, será `max_`.
3. Criar o ficheiro em `src/services/<nome-servico>.js` (ES module) baseando-se na arquitetura de `src/services/filmtwist.js` (referência mais simples que o filmin). Importar dos módulos partilhados em `src/core/`.
4. Adicionar o serviço ao array `SERVICES` em `rollup.config.js` e criar o script `build:<nome>` em `package.json`.
5. Garantir que as chaves KV seguem a regra base: `{prefixo}_catalog`, `{prefixo}_downloaded`, `{prefixo}_download_list`, `{prefixo}_extra_field`.
6. Adicionar o novo prefixo à constante `DEFAULT_PREFIXES` em `worker/worker.js` (fonte de verdade única — **não** no `wrangler.toml`).
7. Correr `npm run build` — o ficheiro final sai em `dist/<nome-servico>.user.js`.

> [!TIP]
> Verifica a documentação da _skill_ `Gestão de Userscripts Media-Sync` em caso de dúvida nas convenções.
