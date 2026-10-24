# Metodologia: base de conhecimento em grafo, modelo do aprendiz e planner

Este documento registra *por que* o Study Lab constrói a base de conhecimento, mede o aprendizado e monta planos do jeito que faz.

Legenda de evidência:
- **[E]** bem estabelecido;
- **[M]** evidência moderada ou vinda de outro contexto;
- **[S]** heurística nossa, a calibrar com dados.

## 1. Grafo de conhecimento

### 1.1 Três níveis: domínio → tópico → KC

- O **Knowledge Component (KC)** é a unidade que o modelo do aprendiz mede: um fato, conceito ou procedimento que pode ser avaliado isoladamente. O **tópico** existe para navegar e resumir. A mastery é estimada por KC e agregada para cima (Koedinger, Corbett & Perfetti 2012, KLI framework) [E].
- Um KC só entra no modelo do aprendiz se tiver pelo menos 3 itens avaliáveis (questões ou cards). Abaixo disso, vira atributo do tópico [S].
- Os KCs são descobertos **a partir das questões e do conteúdo**, e não dos títulos: o LLM lista as habilidades de cada item e de cada trecho, os candidatos são agrupados por similaridade e então nomeados. É o padrão de KCluster (Wei et al., EDM 2025) e KCGen-KT (Duan et al. 2025), cujos resultados ficaram próximos dos KCs de especialistas [M].

### 1.2 Trechos com evidência

- Cada aula é dividida em trechos (chunks) de algumas centenas de tokens, com ID estável.
- Todo artefato gerado (KC, aresta, card, dica) guarda os IDs dos trechos que o sustentam. Isso torna o pipeline **auditável e incremental** [S, prática de RAG].
- Antes de gerar o embedding, cada trecho recebe um prefixo de contexto ("Seção X, aula Y") — a técnica *contextual retrieval* (Anthropic, 2024) [M].

### 1.3 Extração por trecho e resolução de entidades

- **Extração por trecho com esquema fixo** (KC, definição, exemplo) e inserção incremental, sem reconstruir o grafo, inspiradas no LightRAG (Guo et al. 2024). Um esquema aberto de entidades geraria um grafo ruidoso.
- **Resolução de entidades** por embedding:
  - similaridade acima de τ_alto: os candidatos são fundidos automaticamente;
  - na faixa cinza: um LLM decide entre "mesmo", "mais geral", "mais específico" ou "diferente";
  - abaixo de τ_baixo: vira um KC novo.

  Os limiares iniciais são 0,90 e 0,80, a calibrar [S].

### 1.4 Arestas

| Aresta | Uso | Inferência |
|---|---|---|
| `part_of` | agregar mastery e pesos de prova | determinística, pela hierarquia [E] |
| `prerequisite` | prontidão e propagação | **ensemble**: ordem no curso (Pan et al., ACL 2017) + RefD (Liang et al. 2015) + LLM par a par só nos candidatos; aceita quando o LLM confirma **e** um sinal estrutural concorda; ciclos são quebrados para manter um DAG [M] |
| `confusable` | intercalação dirigida e contraste | LLM + similaridade + **distratores**: cada alternativa errada é etiquetada com o KC que ela descreve [S] |
| `related` | navegação e RAG | k vizinhos mais próximos por embedding [S] |

### 1.5 Q-matrix (questão → KC)

- **Construção:** o LLM recebe o enunciado, as alternativas e as justificativas, além dos KCs candidatos mais próximos por embedding. Ele marca 1–3 KCs (primário e secundários) e o KC de cada distrator.
- **Validação:**
  - Os métodos estatísticos clássicos (de la Torre 2008; LFA de Cen, Koedinger & Junker 2006) exigem muitos alunos [E] e não servem com um só.
  - O que usamos com um aluno: curvas de aprendizado por KC que não caem e itens destoantes (erro persistente num KC já dominado). Ambos viram **sinais para revisão**, nunca reescrita automática [S].

### 1.6 Qualidade do conteúdo gerado

- **Deduplicação por embedding:** acima de ~0,92 o item é descartado; na faixa cinza, um LLM decide [S].
- **Grounding:** cada card ou questão gerada cita o trecho de origem [M].
- **Item-writing flaws:** LLMs ainda produzem alternativas com falhas de redação (SAQUET, Moore et al. 2024). O checklist que detecta essas falhas é um **filtro, não uma garantia** [M].

## 2. Modelo do aprendiz (1 aluno, centenas a milhares de eventos)

| Modelo | Viável? | Uso |
|---|---|---|
| SM-2 | sim | **substituído**: é heurístico e não estima a probabilidade de lembrar |
| **FSRS-6** (ts-fsrs) | sim, com parâmetros padrão | memória por item: R(t), estabilidade e dificuldade. É o melhor resultado no srs-benchmark [E] |
| BKT / PFA | parcialmente | só com parâmetros fixos da literatura |
| **Beta / Elo por KC** | sim | mastery por KC (Pelánek 2016) [E] |
| IRT 1PL | só com prior | dificuldade do item vem de um prior, atualizado devagar [M] |
| DKT | não | precisa de milhares de alunos |

**Stack adotado:** FSRS por item (memória) + Beta por KC com correção de chute (mastery) + propagação no grafo (prontidão).

### Ajustes para questões de múltipla escolha

- **Chute:** um acerto numa questão de k alternativas é evidência fraca. A atualização da mastery usa a verossimilhança P(acerto | domina) = 1 − slip e P(acerto | não domina) ≈ 1/k [S, BKT/3PL].
- **Rating do FSRS:**
  - erro → Again;
  - acerto lento, chutado ou com troca de resposta → Hard;
  - acerto com dúvida → Good;
  - acerto rápido e seguro → Easy.

  Um chute rápido não atualiza a mastery [S].
- **Exposição:** primeiras exposições e variantes pesam mais na mastery do que repetir a mesma questão, que mede só a memória daquele item [S].

### Prontidão (Knowledge Space Theory)

- O *outer fringe* (Doignon & Falmagne; ALEKS) é o conjunto do que já está pronto para ser aprendido: prontidão(B) = mínimo da mastery dos pré-requisitos de B [E].
- Um acerto em B dá crédito parcial aos pré-requisitos (×0,3), com no máximo 1–2 saltos (Käser et al. 2014) [S/M].

### Logs

- **Chute rápido:** resposta abaixo de 30% do tempo estimado de leitura, calibrado pela distribuição pessoal de tempos. O padrão de referência é o NT10 (Wise & Ma 2012), e a métrica de esforço é o RTE (Wise & Kong 2005) [E].
- **Calibração:** medida pelo Brier score e pelo viés de confiança. Erros cometidos com certeza são os mais corrigíveis **quando há feedback imediato e reteste em 1–3 dias** (Butterfield & Metcalfe 2001; Metcalfe 2017) [E].
- **Trocas de resposta** mais vão de errado para certo do que o contrário (Kruger et al. 2005). Por isso são tratadas como sinal de incerteza, não de erro [E].
- **Tipologia de erro** (determinística):
  - *slip*: KC dominado e distrator inédito;
  - *misconception*: o mesmo distrator escolhido duas vezes ou mais;
  - *forgetting*: errou com R do FSRS abaixo de 0,7;
  - *gap*: KC sem acertos;
  - *confusion*: o distrator pertence a um KC `confusable`.

## 3. Planner determinístico

### Evidência

| Princípio | Referências | Nível |
|---|---|---|
| Efeito de testagem | Rowland 2014, g≈0,50; Adesope 2017, g≈0,61; Dunlosky 2013 | [E] |
| Espaçamento | Cepeda 2006/2008: intervalo ótimo de 10–30% do tempo até a prova | [E] |
| Intervalos expansivos não superam uniformes | Latimier 2021 → os intervalos ficam por conta do FSRS | [M] |
| Intercalação | Brunmair & Richter 2019: g=0,42, maior com categorias **parecidas** → intercalar os pares `confusable`; vocabulário pode ir em bloco | [E] |

### Prioridade por KC

```
gap   = 1 − E[mastery]
unc   = desvio-padrão(mastery)             # bônus de exploração
risk  = 1 − média_i R_i(data da prova)     # FSRS
ready = mínimo da mastery dos pré-requisitos   (1 se não houver)
urg   = 1 + α·max(0, 1 − dias_restantes/14)
w     = peso_prova(domínio) / nº de KCs do domínio
mis   = 1 + β·[misconception ativa ou erro com certeza recente]

P = w · (gap + γ·unc + δ·risk) · urg · mis · ready^η      (α=1, β=0,5, γ=0,3, δ=0,7, η=1)
```

### Laço diário (orçamento de T minutos)

1. **Revisões vencidas do FSRS** (R abaixo do alvo), limitadas a ~50% de T.
2. **Proteção da prova:** itens que esqueceriam até o dia da prova sem nova revisão entram na fila.
3. **Remediação:** escolha gulosa por P/custo. No máximo 3–4 KCs novos por dia, e um KC com prontidão abaixo de 0,5 é trocado pelo seu pré-requisito mais fraco.
4. **Montagem da sessão:** um bloco curto para cada KC novo, depois uma fila intercalada que aproxima os pares `confusable`.
5. **Reteste em 1–3 dias** de todo erro cometido com certeza e de toda misconception.
6. **Simulados:** um diagnóstico no início, depois a cada 7–10 dias, mais um final 3–5 dias antes da prova.
7. **Saída:** JSON com um `reason_code` por tarefa.

**Papel do LLM:** explicar o plano e ajustá-lo dentro de limites (±20% do tempo, ±1 KC). Os ajustes são validados; se violarem alguma regra, vale o plano determinístico.

## Referências

- KCluster: https://arxiv.org/abs/2505.06469
- KCGen-KT: https://arxiv.org/html/2502.18632v3
- LightRAG: https://arxiv.org/abs/2410.05779
- Pré-requisitos com LLM: https://arxiv.org/html/2507.18479v1 · https://www.ijcai.org/proceedings/2026/567
- Refinamento de Q-matrix humano + IA: https://aclanthology.org/2026.aimecon-wip.29.pdf
- FSRS: https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm
- srs-benchmark: https://github.com/open-spaced-repetition/srs-benchmark
- Elo (Pelánek 2016): https://www.fi.muni.cz/~xpelanek/publications/CAE-elo.pdf
- Käser et al. 2014: https://www.cs.toronto.edu/~aschwing/KaeserEtAl_ITS2014.pdf
- Cepeda et al. 2008: https://www.evullab.org/pdf/CepedaVulRohrerWixtedPashler-PS-2008.pdf
- SAQUET: https://arxiv.org/abs/2405.20529
- Chute rápido (NT10): https://rdrr.io/cran/aberrance/man/detect_rg.html

Referências clássicas citadas de memória (Liang 2015, Pan 2017, de la Torre 2008, Cen 2006, Rowland 2014, Adesope 2017, Dunlosky 2013, Butterfield & Metcalfe 2001, Kruger 2005, Wise & Kong 2005): confira os números exatos antes de qualquer citação formal.
