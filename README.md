# Study Lab

App desktop (Electron + React + shadcn/ui) para estudar com repetição espaçada, prática de recuperação e **um coach de IA que acompanha como você aprende**. O coach olha o tempo de cada resposta, as alternativas erradas que se repetem, os conceitos que você confunde e o que você esquece. A partir disso, monta um **grafo de conhecimento** do conteúdo, planeja seus dias e escreve material novo. Tudo que ele altera pode ser desfeito.

Cada **lab** é um espaço de estudo independente: uma certificação, um curso, um idioma, uma matéria.

## Destaques

- **Setup guiado**: IA, depois o lab, depois o conteúdo, depois a base de conhecimento.
  - **Sua conta Claude** (Pro ou Max): o app instala o próprio Claude Code e roda o coach com `claude -p` em segundo plano, gastando o limite do seu plano, sem cobrança por token.
    - Versão fixada (`src/main/claude/pinned.ts`, gerada do manifesto da release com a assinatura gpg conferida), aceita só com o SHA-256 fixado e a assinatura Authenticode da Anthropic.
    - Pasta própria (`CLAUDE_CONFIG_DIR` dentro dos dados do app), ambiente limpo e nenhuma configuração, hook, MCP ou ferramenta do Claude Code da máquina.
    - Login pelo `claude auth login`: o app abre só a página da Anthropic e repassa o código colado. Ele nunca lê a credencial.
  - Ou **OpenRouter**, por **OAuth PKCE** (sem copiar chave) ou colando uma chave. O catálogo de modelos vem marcado como *pronto*, *limitado* ou *incompatível* com o harness. O padrão é `deepseek/deepseek-v4.1-flash-1017`.
  - Templates neutros: certificação, curso, idioma, matéria e em branco.
- **Formato padrão de conteúdo** ([Content Package v1](docs/content-package.md)) com importadores modulares:
  - Udemy Study Export (Markdown);
  - pasta de dados do Study Lab;
  - pacote JSON nativo;
  - notas em `.md`/`.txt`.

  Para uma fonte nova (Coursera…), basta gerar o JSON ou escrever um adapter.
- **Grafo de conhecimento** ([metodologia](docs/methodology.md)):
  - trechos com evidência;
  - knowledge components (KCs) extraídos e deduplicados por embeddings, por padrão de um **modelo local** (EmbeddingGemma 300M q8, multilíngue, ~309 MB baixados uma vez do Hugging Face com revisão e SHA-256 fixados), na CPU ou, se você escolher, na GPU via DirectML;
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
  - **Concept map** (reagraph, WebGL na GPU dedicada quando houver): tópicos que se expandem em conceitos, agrupados em clusters; modos pré-requisitos (DAG) e confusões; busca; painel de detalhes; visão em tabela.
- **Coach** no Claude Code (com a sua conta) ou no DeepAgents (LangChain, com o OpenRouter). Os dois têm:
  - planejamento, sistema de arquivos de rascunho e subagentes (learning-analyst, content-author);
  - **skills** em SKILL.md: 7 nativas, mais as suas;
  - **conexões MCP externas** (HTTP ou comando local) por lab;
  - ferramentas do lab com diário de alterações e **desfazer**.
- **Servidor MCP local** (opcional): as mesmas ferramentas ficam disponíveis para Claude Desktop, Claude Code, Cursor e outros, com um endpoint por lab.
- **Tabelas e listas paginadas** (25, 50 ou 100 por página): material, analytics, mapa de conceitos, busca na biblioteca, erros e flashcards.
- **Tudo local**: SQLite (`node:sqlite`). O único módulo nativo é o `onnxruntime-node`, do modelo de embedding. A chave do OpenRouter fica criptografada com `safeStorage`.

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
| `npm test` | 58 testes: parser e adapters, OAuth, ingestão, FSRS, modelo do aluno, planner, construtor do grafo, agente contra um OpenRouter simulado e contra um Claude Code falso, instalação fixada, skills, MCP, embedding local |
| `npm run pin-claude-code -- <versão>` | Fixa outra versão do Claude Code (precisa de `gpg`) |
| `npm run dist` | Instalador Windows (NSIS) |

O banco fica em `%APPDATA%/Study Lab/study-lab.db`. Para usar outro arquivo, defina `STUDY_LAB_DB`. O Claude Code do app fica em `%APPDATA%/Study Lab/claude` e o modelo de embedding em `%APPDATA%/Study Lab/models`.

Para rodar os testes do modelo de embedding real (CPU e DirectML), aponte `STUDY_LAB_TEST_MODELS` para uma pasta `models` que já tenha o modelo baixado. `STUDY_LAB_TEST_GPU` escolhe o adaptador (0 por padrão).

## Coach no Claude Code

Cada execução (chat, análise, plano, geração, cada etapa do grafo) é um `claude -p` com `--setting-sources ""`, `--strict-mcp-config` e só a ferramenta `Agent`. As ferramentas do lab chegam por um endpoint MCP privado daquela execução: porta efêmera em `127.0.0.1`, token próprio só no ambiente, apenas as ferramentas daquela tarefa. Por isso toda escrita continua no diário e pode ser desfeita. As conexões MCP externas do lab entram no mesmo `mcp.json`. As skills são lidas por uma ferramenta `read_skill`, e o learning-analyst e o content-author viram agentes do Claude Code. O chat retoma a sessão do Claude Code (`--resume`) enquanto ela tiver todas as mensagens da conversa; se não tiver, o histórico vai escrito no prompt. O construtor do grafo usa `--json-schema`, sem ferramentas.

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
  harness/                execução do coach: DeepAgents (OpenRouter) e Claude Code, skills, conexões MCP
  claude/                 Claude Code do app: instalação fixada, ambiente, login, stream-json, execuções
  llm.ts                  provedor ativo (Claude Code ou OpenRouter) e JSON para o construtor do grafo
  localEmbed.ts           modelo de embedding local (download conferido, ONNX no CPU)
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
