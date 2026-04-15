# Media-Sync Agent Instructions

Este ficheiro funciona como um guia de instruções base (System Prompt/Context) para agentes de Inteligência Artificial que trabalhem neste repositório. O objetivo é que qualquer IA tenha de imediato num só local o contexto e as regras do projeto baseadas na arquitetura estabelecida.

## Visão Geral do Projeto
O repositório `media-sync` consiste num sistema distribuído que sincroniza progressos de visualização (vistos), listas de downloads e catálogos para vários serviços de streaming (ex: Filmin, FilmTwist, etc.).
- **Backend**: 1 único Cloudflare Worker atuando como router/API de acesso. Todas as informações estão alocadas em KV namespaces do Cloudflare (`MEDIA_KV`).
- **Frontend**: 1 userscript Tampermonkey por cada serviço de streaming suportado. Servem o catálogo, gerem a persistência por localStorage antes do sync e comunicam com a layer da Cloud.

## Arquitetura Cloudflare KV
O Worker gere todas as keys pelo seu prefixo específico para identificar o serviço.
A regra é sempre: `{prefixo}_catalog`, `{prefixo}_downloaded`, `{prefixo}_download_list`, `{prefixo}_extra_field`.
Exceções validam-se, como os casos em que as plataformas têm diferenças entre subscrição (ex: filmin: `filmin_catalog_paid` e `filmin_catalog_free`).

## Regras Críticas de Desenvolvimento para a IA

1. **Nunca exponhas chaves no código.**
   - Nunca faças hardcode de `API_KEY` ou `READ_KEY` (nem do Cloudflare, nem do Simkl) dentro dos `userscripts`. Todos os scripts devem obter, gerir e definir estes segredos armazenando via GUI no `localStorage` do utilizador.
   - Variáveis `const API_KEY = "..."` não devem existir no repositório com valores verdadeiros.

2. **Como estruturar novos serviços ou alterar as KV keys:**
   - Adicionar ou modificar o prefixo no `wrangler.toml` (na flag `ALLOWED_PREFIXES`).
   - Adicionar o modelo de dados em `services/[nome-do-serviço].user.js`, fazendo o request com header `x-api-key`. Evitar cors garantindo origens no Worker se necessário.

3. **Independência Simkl**
   - O `simkl-watched.user.js` não acede ao Worker nem ao provedor KV. Opera por OAuth perante a plataforma Simkl e processa overlays DOM. Tudo independente!

4. **Tratamento do DOM em Userscripts**
   - Os websites mudam constantemente. Utiliza `MutationObserver` sempre que dependas de conteúdo que é renderizado tardiamente (React / Vue, ex: classes dinamicas).
   - Não uses selectors instáveis ou propensos a falhas rápidas (usa algo o mais genérico e identificativo possível, como IDs e data-attributes, ou em último caso querySelectors com paths concisos).

## Comandos a conhecer
- Para preparar e dar push à Cloudflare Worker: `npx wrangler deploy`
- Pode existir a necessidade de efetuar testes locais: `npx wrangler dev`

**Nota Técnica para a IA:** Se te for pedido para construir um novo userscript, baseia-te na estrutura do `filmtwist.user.js` por ser o mais normalizado, e usa sempre os cabeçalhos padrão. Em caso de dúvidas, relê o ficheiro `README.md`.
