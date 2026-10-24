# Visualizações de progresso: o que a pesquisa recomenda

Este documento resume a pesquisa que orienta três telas: **Performance**, **Timeline** e **Concept map**.

Marcação de evidência: **[E]** = bem estabelecido; **[J]** = julgamento de design.

## Princípios (literatura de Open Learner Models e learning dashboards)

- **Cada gráfico termina numa ação** ("praticar estes 3 conceitos", "treinar a diferença A×B"). Dashboards raramente dizem o que fazer (Matcha et al. 2019) [E].
- **O aluno é comparado com a própria meta e com o próprio passado**, nunca com outras pessoas. A comparação social estimula competição em vez de domínio do conteúdo (Jivet et al. 2017, 2018) [E].
- **Skill meters** (barras por tópico) são a representação mais fácil de entender. O app oferece **várias visões do mesmo modelo** (Bull & Kay) [E].
- **A incerteza aparece sempre.**
  - Ela quase nunca é mostrada em visualizações educacionais (Demmans Epp & Bull 2015) [E].
  - Gradientes de opacidade são lidos melhor do que barras de erro (Correll & Gleicher 2014) [E].
  - Quantile dotplots levam a decisões quase ótimas (Fernandes et al. 2018) [E].
- **Posição e comprimento são lidos com mais precisão do que área e ângulo** (Cleveland & McGill). Por isso o app usa barras e pontos, não treemap ou sunburst [E].
- **Grafos grandes seguem "search, show context, expand on demand"** (van Ham & Perer 2009) [E].

## As três telas

| Tela | Forma principal | Formas secundárias |
|---|---|---|
| **Performance** | Skill meters hierárquicos (domínio → tópico → conceito). A média aparece como barra, o intervalo como gradiente, com uma marca do alvo e um "fantasma" de 14 dias atrás | Nota prevista como quantile dotplot (20 cenários) com a nota de corte; curva de retenção até a prova; calibração (diagrama de confiabilidade com 3 pontos); velocidade × acerto |
| **Timeline** | Trilhas alinhadas no mesmo eixo de tempo: atividade diária por modo, tendência da nota prevista com faixa e simulados, marcos, adesão ao plano | Mapa de calor do calendário; slope chart por domínio ("30 dias atrás → agora") |
| **Concept map** | Grafo Cytoscape. Abre no nível de tópico (domínios como nós compostos, layout fcose) e expande para conceitos com duplo clique | Modo Pré-requisitos (dagre da esquerda para a direita, cadeia de ancestrais); modo Confusões (top-N por peso); tabela equivalente para acessibilidade |

## Como o grafo codifica as informações

- **Cor do nó:** escala sequencial de uma cor só, mostrando o domínio. Cinza quando há poucos dados.
- **Tamanho do nó:** proporcional ao peso na prova (√ do peso).
- **Anel tracejado:** a estimativa tem incerteza alta.
- **Arestas:**

  | Tipo | Traço | Seta | Cor | Visível por padrão? |
  |---|---|---|---|---|
  | Pré-requisito | sólido | sim | escura | sim |
  | Confundível | tracejado | não | laranja, espessura ∝ peso | sim |
  | Relacionado | pontilhado | não | clara | não |

- **Interação:** ao passar o mouse ou selecionar um nó, o nó e seus vizinhos imediatos ficam em destaque e o resto esmaece.

## Bibliotecas

- **Cytoscape.js 3.34**, com cytoscape-fcose e cytoscape-dagre (MIT): nós compostos, algoritmos de vizinhança e desempenho de sobra para cerca de 200 nós.
  - Como o Cytoscape não lê variáveis CSS, os tokens de cor são lidos com `getComputedStyle` e reaplicados ao trocar o tema.
  - A falta de acessibilidade do canvas é compensada pela visão em tabela.
- **Gráficos:** SVG próprio, como no resto do app. Variáveis CSS e dark mode funcionam sem ponte e nada vem de CDN.

## Armadilhas evitadas

- **Média sem incerteza:** com poucos dados, a barra sozinha engana; sempre aparece o intervalo.
- **Vermelho para "baixo":** desmotiva. A escala é sequencial e "poucos dados" fica em cinza.
- **Brier cru:** é traduzido para "superconfiante", "bem calibrado" ou "subconfiante".
- **Destaque de "streak quebrada":** não existe.
- **Layout de força não determinístico:** a seed é fixa.
- **Arestas `related` lidas como causais:** a legenda deixa claro que não são.
