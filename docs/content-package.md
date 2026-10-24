# Formato de conteúdo (Content Package v1)

Todo conteúdo entra no Study Lab no mesmo formato: o **Content Package**. Cada importador (adapter) só converte a sua entrada para esse formato. A ingestão, a construção da base de conhecimento, o analytics e o coach nunca enxergam o formato original da fonte.

- Tipos TypeScript: [`src/shared/content-package.ts`](../src/shared/content-package.ts)
- JSON Schema: [`schemas/content-package.schema.json`](../schemas/content-package.schema.json)

```json
{
  "format": "study-lab/content-package",
  "version": 1,
  "source": { "adapter": "coursera-export", "provider": "coursera", "id": "ml-specialization", "title": "Machine Learning Specialization", "language": "en" },
  "documents": [
    { "id": "w1-l1", "order": 1, "title": "What is ML?", "section": "Week 1", "kind": "transcript", "text": "…" }
  ],
  "assessments": [
    {
      "id": "w1-quiz",
      "title": "Week 1 quiz",
      "kind": "quiz",
      "items": [
        { "id": "1", "n": 1, "stem": "…", "options": ["A", "B", "C"], "answer": [1], "rationales": ["…", "…", "…"] }
      ]
    }
  ]
}
```

## Regras

- **`source.id` precisa ser estável.** Importar de novo o mesmo `source.id` atualiza o material no lugar e preserva o progresso. O ID de cada questão é `<source.id>-<assessment.id>-<item.id>`, então os IDs de avaliação e de item também devem ser estáveis.
- **`order`** é a posição do documento no curso. Ela define a numeração na biblioteca e serve de sinal fraco de pré-requisito no grafo de conhecimento.
- **`rationales`** traz uma justificativa por alternativa. É opcional, mas muito valioso: as justificativas das alternativas erradas alimentam a detecção de equívocos ("você escolheu X porque confundiu com Y").
- Um pacote só com avaliações **não apaga** os documentos já importados daquela fonte, e o contrário também vale. Assim é possível importar o arquivo de questões e o de transcrições separadamente.
- **`knowledge`** é opcional e serve para trazer uma base já pronta, como a de outro Study Lab. Nesse caso os IDs das questões são mantidos como vieram.
- Um arquivo pode conter um único pacote ou um array de pacotes.

## Importadores disponíveis

| Adapter | Entrada |
|---|---|
| `udemy-study-export` | Os `.md` da extensão Udemy Study Export (`— Simulados` e `— Transcrições (EN)`), agrupados por curso |
| `study-lab-bundle` | Pasta com `questions.json`, `kb.json` e `lectures.json` |
| `content-package` | `.json` neste formato (o formato nativo) |
| `documents` | Arquivos `.md` ou `.txt` (anotações, capítulos). Cada arquivo, ou cada título de primeiro nível de um arquivo longo, vira um documento |

## Adicionar uma fonte nova (por exemplo, Coursera)

Há dois caminhos:

1. **Exportador externo (recomendado):** uma extensão ou script gera o JSON deste formato, e o app importa com o adapter `content-package`. Nada muda no app.
2. **Adapter interno:** implemente `ContentAdapter` em [`src/main/content/adapters.ts`](../src/main/content/adapters.ts) e adicione-o a `ADAPTERS`.
   - `detect(paths)` devolve uma confiança de 0 a 1 de que os arquivos são desse formato.
   - `parse(paths)` devolve `{ packages, warnings }`.
