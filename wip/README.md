# wip/ — Userscripts em Desenvolvimento

Scripts que seguem a arquitetura do projeto mas ainda não foram migrados para o pipeline `src/services/ → dist/`.

| Script | Estado | Próximo passo |
|---|---|---|
| `meogo.user.js` | Monolítico, funcional | Migrar para `src/services/meogo.js` a usar os módulos de `src/core/` (ver `src/services/filmtwist.js` como referência) |

Não instalar a partir desta pasta em produção — quando um script for migrado, o ficheiro canónico passa a ser `dist/<nome>.user.js`.
