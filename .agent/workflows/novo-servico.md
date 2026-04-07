---
description: Criar um template de userscript para um novo servico de streaming
---

# Novo Serviço de Streaming

Este workflow orienta a criação de um novo userscript básico para um serviço de streaming como a HBO, Prime, Opto, etc.

1. Pedir o nome do serviço e o URL base (match pattern).
2. Definir o **prefixo KV**. Por exemplo, para HBO, será `max_`.
3. Criar o ficheiro em `services/nome-servico.user.js` baseando-se na arquitetura e GUI injetada do ficheiro `filmtwist.user.js` (que é mais simples que o filmin). 
4. Garantir que as chaves KV seguem a regra base: `{prefixo}_catalog`, `{prefixo}_downloaded`, etc. E substituir no código conforme listado no boilerplate.
5. Adicionar o novo prefixo KV no topo para lembrança, ou no ficheiro `wrangler.toml` na secção de opções globais `ALLOWED_PREFIXES`.

> [!TIP]
> Verifica a documentação da _skill_ `Gestão de Userscripts Media-Sync` em caso de dúvida nas convenções.
