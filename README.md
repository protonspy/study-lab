# Study Lab

App desktop (Electron + React + shadcn/ui) para estudar com repetição espaçada, prática de recuperação e **um agente de IA que acompanha como você aprende**. O agente olha o tempo de cada resposta, os erros repetidos, os tópicos que você confunde e o que você esquece. A partir disso, monta planos de estudo, escreve material novo e reorganiza o lab. Tudo que ele altera pode ser desfeito.

Cada **lab** é um espaço de estudo independente: uma certificação, um idioma, um curso. Você pode ter quantos quiser.

## Funcionalidades

- **Labs**: cada um tem seu conteúdo, agenda, analytics, plano e chat. Há modelos prontos (AWS AIF-C01, AWS AIP-C01, certificação genérica, idioma, curso) e domínios, pesos e formato de prova editáveis.
- **Estudo** (herdado do AIF/AIP-C01 Study Lab):
  - revisão diária SM-2;
  - flashcards e gatilhos de prova;
  - prática com justificativa para cada alternativa e marcação de confiança;
  - simulado cronometrado, notas por tópico, erros, biblioteca de aulas com busca full-text e Pomodoro.
- **Registro de eventos**: cada tentativa é gravada com tempo, alternativas marcadas, primeira escolha, trocas de resposta, confiança e modo.
- **Analytics** (determinístico, sem IA):
  - tempo por resposta comparado ao ritmo da prova;
  - "chute rápido";
  - calibração (confiança × acerto);
  - trocas de resposta (errada→certa e certa→errada);
  - domínio por tópico, ponderado pela recência;
  - curva de aprendizado e erros repetidos (incluindo a *mesma alternativa errada de novo*);
  - pares de tópicos confundidos, itens esquecidos e acerto por hora do dia.
- **Coach (IA via OpenRouter)**: funciona com qualquer modelo do OpenRouter. O padrão é `deepseek/deepseek-v4.1-flash-1017`.
  - **Insights**: diagnóstico com evidências (lacuna, equívoco, esquecimento, pressa, confusão entre tópicos).
  - **Plano**: plano dia a dia com tarefas que abrem a sessão certa. Fixa tópicos de foco no Today e cria conjuntos de prática.
  - **Criar**: guias de estudo em Markdown voltados aos seus equívocos, flashcards e questões no estilo da prova, ancorados nas transcrições.
  - **Chat**: conversa com acesso a todas as ferramentas do lab.
  - **Base de conhecimento**: transforma uma importação crua (aulas + questões) em domínios, tópicos, notas, dicas de prova, armadilhas e flashcards, e classifica as questões por tópico.
  - **Atividade**: diário de tudo que o coach (ou um cliente MCP) mudou, com **Desfazer**.
- **Gestão de material**: arquivar o que já foi aprendido (sai das filas, mantém o histórico), suspender itens com problema e restaurar.
- **Servidor MCP local (opcional)**: um endpoint por lab em `http://127.0.0.1:<porta>/mcp/<labId>`, com token. Claude Desktop, Claude Code, Cursor e outros clientes usam as **mesmas ferramentas** do coach.
- **Importação**:
  - Markdown da extensão **Udemy Study Export** (`— Simulados` e `— Transcrições (EN)`);
  - pastas de dados do Study Lab (`questions.json`, `kb.json`, `lectures.json`);
  - progresso exportado da versão web;
  - exportação e importação de labs inteiros (`.studylab.json`).
- **Tudo local**: um arquivo SQLite (`node:sqlite`, sem módulos nativos). A chave do OpenRouter é criptografada pelo chaveiro do sistema (`safeStorage`/DPAPI).

## Rodar

```bash
npm install
npm approve-scripts electron   # o npm 11 bloqueia o download do binário do Electron até você aprovar
npm run dev                    # app com hot reload
```

| Comando | O que faz |
|---|---|
| `npm run dev` | Electron + Vite com HMR |
| `npm run build` | Gera `out/` (main, preload, renderer) |
| `npm start` | Roda o build de `out/` |
| `npm run typecheck` | Checagem de tipos (main e renderer) |
| `npm test` | Testes do backend: parser, importação, analytics, ferramentas, desfazer, MCP e o agente contra um OpenRouter simulado |
| `npm run dist` | Instalador Windows (NSIS) em `dist/` |

O banco fica em `%APPDATA%/Study Lab/study-lab.db`. Para usar outro arquivo, defina `STUDY_LAB_DB`.

## Primeiros passos

1. **AI coach**: cole sua chave do [OpenRouter](https://openrouter.ai/keys) e, se quiser, troque o modelo. O seletor lista o catálogo inteiro com contexto e preço e filtra modelos com suporte a *tools*.
2. **New lab** e escolha um modelo.
3. **Content → Import**: escolha os `.md` da Udemy Study Export ou a pasta `public/data` de um Study Lab.
4. Se o lab não tiver tópicos, clique em **Build with the coach**.
5. Estude. Depois de 50 a 100 respostas, peça **Coach → Insights** e **Coach → Plan**.

## Arquitetura

```
src/
  shared/        tipos, contrato IPC, analytics (puro), parsers da Udemy, presets
  main/          processo principal do Electron
    db.ts          SQLite + migrações
    repo.ts        labs, conteúdo, progresso, eventos, planos, insights, chats
    tools.ts       ★ registro único de ferramentas do lab (leitura e escrita)
    journal.ts     diário de alterações com snapshot e desfazer
    agent.ts       prompt do coach, loop de tool calling, jobs (analisar, planejar, criar, chat)
    buildkb.ts     pipeline da base de conhecimento (esboço → notas/cards → classificação)
    openrouter.ts  cliente (retries, uso/custo, JSON estruturado), chave criptografada
    mcp.ts         servidor MCP Streamable HTTP por lab (stateless, bearer token)
    importers.ts   Udemy, pasta do Study Lab, progresso antigo, export/import de lab
  preload/       ponte tipada (contextBridge), com sandbox
  renderer/      React 19 + Tailwind 4 + shadcn/ui
```

### Como o agente funciona

A pesquisa por trás do projeto mostra que **o LLM não deve fazer a modelagem do aluno**: um modelo de *knowledge tracing* prevê acertos melhor que um LLM. Por isso há duas camadas:

1. **Analytics determinístico** (`shared/analytics.ts`) calcula os números. Eles aparecem na tela Analytics e são a única fonte que o coach usa.
2. **O agente** lê esses números por ferramentas, interpreta os padrões, consulta as questões que você errou e as transcrições, e **age**. Cada escrita passa por um `Change` do diário, que guarda o estado anterior de cada item. O Desfazer restaura esse estado.

O mesmo registro de ferramentas (`main/tools.ts`) atende ao coach interno (function calling no OpenRouter) e ao servidor MCP. Por isso qualquer cliente MCP tem exatamente as mesmas capacidades e deixa o mesmo rastro auditável.

| Ferramentas de leitura | Ferramentas de escrita (com desfazer) |
|---|---|
| `get_lab`, `get_overview`, `list_topics`, `get_topic_report`, `list_mistakes`, `get_question`, `search_content`, `read_lecture`, `list_items`, `get_plan`, `list_changes` | `create_flashcards`, `create_questions`, `write_study_guide`, `update_item`, `set_item_status`, `upsert_topic`, `tag_questions`, `merge_topics`, `set_domains`, `save_study_plan`, `update_plan_task`, `set_focus`, `create_collection`, `delete_collection`, `update_study_settings`, `remember` |

### Métodos de analytics

| Sinal | Como é calculado | Referência |
|---|---|---|
| Chute rápido | resposta abaixo de 30% do tempo estimado de leitura (≈4 palavras/s), mínimo de 2,5 s | limiar normativo de Wise & Ma; Bulut et al. 2023 |
| Domínio do tópico | acerto ponderado pela recência (cada tentativa anterior vale 0,85×), prior Beta(1,1), mais a força dos cards | espírito de PFA/Elo para um único aluno |
| Curva de aprendizado | taxa de erro nas tentativas 1–3, 4–6, 7–10 e 11+ de cada tópico | curvas de componente de conhecimento (Koedinger) |
| Calibração | acerto por confiança declarada; erros cometidos com certeza têm prioridade | efeito de hipercorreção |
| Equívoco × lapso | a *mesma* alternativa errada escolhida de novo | — |
| Esquecimento | acertou e depois errou com intervalo de 3 dias ou mais | — |
| Confusão | erros em questões que cruzam dois tópicos, mais pares marcados como `confusable` | — |

Modelos de *deep knowledge tracing* (DKT, pyKT) foram descartados de propósito: precisam de milhares de alunos e ganham pouco sobre modelos simples.

## Servidor MCP

Em **Settings → AI coach → MCP server**, ligue o servidor. O endpoint e o token ficam ali, com um botão para copiar o comando do Claude Code:

```bash
claude mcp add --transport http study-lab-aws http://127.0.0.1:8765/mcp/<labId> --header "Authorization: Bearer <token>"
```

O servidor só escuta em `127.0.0.1`, exige o token e recusa requisições de navegador (cabeçalho `Origin`), para que páginas web não consigam controlar o lab.

## Licença

MIT
