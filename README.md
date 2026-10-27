# CV Manager

Adequa seu currículo a uma vaga usando IA gratuita, **sem inventar nada**: a única fonte de verdade são os seus currículos antigos.

## Como funciona

1. **Currículos-fonte**: coloque seus currículos na pasta `curriculos/` (ou na pasta definida em `CURRICULOS_DIR` no `.env`) (PDF, DOCX, DOC, ODT, RTF, TXT, MD) ou envie pela interface.
2. **Perfil mestre**: a IA junta todos os currículos num único documento factual (sem duplicatas, preservando métricas e apontando datas divergentes). Você revisa e corrige; ele fica em `data/perfil-mestre.md`.
3. **Adequar à vaga**: cole a descrição da vaga. O app:
   - analisa a vaga e estima a aderência (requisitos atendidos, com evidências, e lacunas);
   - escreve um currículo focado na vaga, em formato amigável a ATS;
   - mostra quais palavras-chave da vaga aparecem no currículo;
   - **verifica a fidelidade**: uma segunda passada da IA confere cada afirmação contra o perfil mestre e aponta o que foi inventado ou exagerado;
   - gera uma carta de apresentação (opcional);
   - exporta em `.md`, `.docx` (via pandoc) ou `.pdf` (via Chrome headless, sem cabeçalho/rodapé do navegador).
4. **LinkedIn**: 7 ferramentas para o perfil do LinkedIn (título com 10 variações, "Sobre" no método PAS, experiências na fórmula XYZ, 25 palavras-chave, simulação de recrutador, seção "Em destaque" e modelos de DM). Usam o perfil mestre e, se você colar, o texto atual do seu LinkedIn. Quando falta um número real, a IA deixa `[ADICIONAR: ...]` em vez de inventar. Os resultados ficam em `data/linkedin/`.
5. **Histórico**: tudo o que foi gerado fica em `data/geracoes/`.

## Rodando

```bash
npm install
cp .env.example .env   # já existe um .env pronto para o Ollama
npm start              # http://localhost:4321
```

## IAs gratuitas suportadas

| Provedor | Custo | Privacidade | Configuração |
|---|---|---|---|
| **Ollama** (padrão) | grátis, roda no seu PC | dados não saem da máquina | `ollama pull qwen3.5:9b` |
| **Groq** | plano gratuito com limite por minuto/dia | dados vão para a nuvem | `GROQ_API_KEY` no `.env` ([chave](https://console.groq.com/keys)) |
| **Google Gemini** | plano gratuito com limite | dados vão para a nuvem | `GEMINI_API_KEY` no `.env` ([chave](https://aistudio.google.com/apikey)) |

Troque de provedor/modelo no topo da tela. Modelos maiores (Groq `llama-3.3-70b-versatile`, Gemini) seguem melhor a regra de não inventar e são bem mais rápidos que um modelo local de 9B; o local é a opção mais privada.

Dicas:
- No Ollama, a primeira chamada demora (carrega o modelo na memória). Depois fica bem mais rápido.
- Se tiver muitos currículos longos e o resultado vier cortado, aumente `OLLAMA_NUM_CTX` no `.env`.
- PDFs escaneados (imagem) não têm texto extraível: o app avisa. Nesse caso, converta com OCR ou cole o texto num `.txt`.

## Estrutura

```
server/   Express: rotas (index.js), provedores de IA (ai.js), extração de texto (fontes.js), prompts (prompts.js)
public/   interface (HTML/CSS/JS puro, sem build)
curriculos/  seus currículos originais (nunca são alterados pelo app)
data/     perfil mestre, backups do perfil, histórico e cache de texto extraído
```
