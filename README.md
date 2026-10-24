# Study Lab

App desktop (Electron + React + shadcn/ui) para estudar com repetição espaçada, prática de recuperação e **um coach de IA que acompanha como você aprende**. O coach olha o tempo de cada resposta, as alternativas erradas que se repetem, os conceitos que você confunde e o que você esquece. A partir disso, monta um **grafo de conhecimento** do conteúdo, planeja seus dias e escreve material novo. Tudo que ele altera pode ser desfeito.

Cada **lab** é um espaço de estudo independente: uma certificação, um curso, um idioma, uma matéria.

## Destaques

- **Setup guiado**: gateway de IA, depois o lab, depois o conteúdo, depois a base de conhecimento.
  - Login no OpenRouter por **OAuth PKCE** (sem copiar chave) ou colando uma chave.
  - Catálogo de modelos marcado como *pronto*, *limitado* ou *incompatível* com o harness. O padrão é `deepseek/deepseek-v4.1-flash-1017`.
  - Templates neutros: certificação, curso, idioma, matéria e em branco.
- **Formato padrão de conteúdo** ([Content Package v1](docs/content-package.md)) com importadores modulares:
  - Udemy Study Export (Markdown);
  - pasta de dados do Study Lab;
  - pacote JSON nativo;
  - notas em `.md`/`.txt`.

  Para uma fonte nova (Coursera…), basta gerar o JSON ou escrever um adapter.
- **Grafo de conhecimento** ([metodologia](docs/methodology.md)):
  - trechos com evidência;
  - knowledge components (KCs) extraídos e deduplicados por embeddings;
  - tópicos e domínios;
  - pré-requisitos por ensemble (ordem no curso + reference distance + LLM, sem ciclos);
  - pares confundíveis vindos dos distratores;
  - Q-matrix com o KC de cada alternativa errada;
  - notas e flashcards com grounding.
- **Modelo do aluno** por KC:
  - mastery bayesiana com correção de chute, ignorando chutes rápidos;
  - incerteza, prontidão pelos pré-requisitos e tipos de erro (lacuna, misconception, confusão, esquecimento, deslize);
  - nota prevista com intervalo e calibração (Brier).
- **Memória com FSRS-6** (ts-fsrs). O SM-2 foi substituído, e os registros antigos são convertidos automaticamente.
- **Planner determinístico**: o LLM só explica e ajusta dentro de limites. Ele calcula, a cada dia:
  - revisões vencidas;
  - proteção do dia da prova;
  - retestes de erros cometidos com certeza;
  - simulados na cadência certa;
  - remediação por prioridade (peso × lacuna × risco × misconception × prontidão), com pares confundíveis juntos.

  Existe também **"Planejar sem IA"**.
- **Visualizações** ([por quê](docs/visualization.md)):
  - **Performance**: nota prevista como quantile dotplot; mapa de domínio com incerteza e "fantasma" de 14 dias atrás; retenção até a prova; calibração; velocidade × acerto.
  - **Timeline**: trilhas alinhadas de atividade, nota prevista com simulados, marcos e adesão ao plano; calendário; evolução por domínio.
  - **Concept map** (Cytoscape): tópicos que se expandem em conceitos; modos pré-requisitos e confusões; busca; painel de detalhes; visão em tabela.
- **Coach no DeepAgents** (LangChain):
  - planejamento, sistema de arquivos de rascunho e subagentes (learning-analyst, content-author);
  - **skills** em SKILL.md: 7 nativas, mais as suas;
  - **conexões MCP externas** (HTTP ou comando local) por lab;
  - ferramentas do lab com diário de alterações e **desfazer**.
- **Servidor MCP local** (opcional): as mesmas ferramentas ficam disponíveis para Claude Desktop, Claude Code, Cursor e outros, com um endpoint por lab.
- **Tudo local**: SQLite (`node:sqlite`, sem módulos nativos). A chave fica criptografada com `safeStorage`.

## Rodar

```bash
npm install            # .npmrc usa legacy-peer-deps (o deepagents declara um peer do langsmith desatualizado)
npm approve-scripts electron
npm run dev
```

| Comando | O que faz |
|---|---|
| `npm run dev` | Electron + Vite com HMR |
| `npm run build` / `npm start` | Gera `out/` e roda o build |
| `npm run typecheck` | Tipos do main e do renderer |
| `npm test` | 34 testes: parser e adapters, OAuth, ingestão, FSRS, modelo do aluno, planner, construtor do grafo e agente contra um OpenRouter simulado, skills, MCP |
| `npm run dist` | Instalador Windows (NSIS) |

O banco fica em `%APPDATA%/Study Lab/study-lab.db`. Para usar outro arquivo, defina `STUDY_LAB_DB`.

## Arquitetura

```
src/shared/    tipos, contrato IPC, content package, analytics, FSRS, modelo do aluno, planner, viz
src/main/      Electron main
  db.ts repo.ts           SQLite (migrações v1–v3) e acesso a dados
  content/                adapters de fonte + ingestão de content packages
  graph.ts                grafo: KCs, arestas, Q-matrix, distratores
  buildkb.ts embeddings.ts pipeline do grafo de conhecimento
  learner.ts viz.ts       modelo do aluno, plano e dados das visualizações
  tools.ts journal.ts     ferramentas do lab (agente + MCP) e desfazer
  harness/                DeepAgents: modelo OpenRouter, skills, conexões MCP, execução
  agent.ts                tarefas do coach (análise, plano, geração, chat)
  oauth.ts mcp.ts         login OpenRouter (PKCE) e servidor MCP
src/renderer/  React 19 + Tailwind 4 + shadcn/ui
resources/skills/         skills nativas do coach
schemas/                  JSON Schema do content package
docs/                     metodologia, visualização, formato de conteúdo
```

## Servidor MCP

Ative em **Settings → AI coach → MCP server** e copie o comando para o Claude Code:

```bash
claude mcp add --transport http study-lab-meu-lab http://127.0.0.1:8765/mcp/<labId> --header "Authorization: Bearer <token>"
```

O servidor só escuta em `127.0.0.1`, exige o token e recusa requisições de navegador.

## Licença

MIT
