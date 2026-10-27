// Camada de IA: Ollama (local, gratuito) e provedores em nuvem com plano gratuito
// que expõem API compatível com OpenAI (Groq, Google Gemini).

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 16384);
const OLLAMA_MAX_CTX = Number(process.env.OLLAMA_MAX_CTX || 32768);

/**
 * O Ollama corta em silêncio o que não cabe no contexto (inclusive as instruções).
 * Estima os tokens (~3 caracteres por token em português) e aumenta o contexto
 * quando preciso; se nem o máximo couber, falha com uma mensagem clara.
 */
function contextoNecessario(messages) {
  const caracteres = messages.reduce((n, m) => n + m.content.length, 0);
  const necessario = Math.ceil(caracteres / 3) + 4096; // + espaço para a resposta
  if (necessario > OLLAMA_MAX_CTX) {
    throw new Error(
      `O texto enviado (~${Math.round(necessario / 1000)} mil tokens) não cabe no contexto do modelo local (${OLLAMA_MAX_CTX / 1024}k). ` +
        'Consolide o perfil mestre (aba 2) para resumir seus currículos, ou use Groq/Gemini.',
    );
  }
  return Math.max(OLLAMA_NUM_CTX, Math.ceil(necessario / 4096) * 4096);
}

const CLOUD = {
  groq: {
    nome: 'Groq (nuvem, plano gratuito)',
    baseUrl: 'https://api.groq.com/openai/v1',
    chave: () => process.env.GROQ_API_KEY,
    modeloPadrao: () => process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  },
  gemini: {
    nome: 'Google Gemini (nuvem, plano gratuito)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    chave: () => process.env.GEMINI_API_KEY,
    modeloPadrao: () => process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
};

// Modelos que não servem para geração de texto
const NAO_CHAT = /embed|whisper|tts|guard|rerank|vision-only/i;

async function listarOllama() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { models = [] } = await r.json();
    const modelos = models.map((m) => m.name).filter((n) => !NAO_CHAT.test(n));
    const preferido = process.env.OLLAMA_MODEL;
    return {
      id: 'ollama',
      nome: 'Ollama (local, 100% privado)',
      disponivel: modelos.length > 0,
      modelos,
      modeloPadrao: preferido && modelos.includes(preferido) ? preferido : modelos[0],
      aviso: modelos.length ? null : 'Nenhum modelo de chat instalado. Rode: ollama pull qwen3.5:9b',
    };
  } catch (e) {
    return { id: 'ollama', nome: 'Ollama (local)', disponivel: false, modelos: [], aviso: `Ollama não respondeu em ${OLLAMA_URL}` };
  }
}

async function listarCloud(id) {
  const p = CLOUD[id];
  const chave = p.chave();
  const base = { id, nome: p.nome, modeloPadrao: p.modeloPadrao() };
  if (!chave) {
    return { ...base, disponivel: false, modelos: [], aviso: `Defina ${id.toUpperCase()}_API_KEY no arquivo .env` };
  }
  let modelos = [];
  try {
    const r = await fetch(`${p.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${chave}` },
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const { data = [] } = await r.json();
      modelos = data.map((m) => m.id.replace(/^models\//, '')).filter((n) => !NAO_CHAT.test(n)).sort();
    }
  } catch {
    // Sem lista: o usuário ainda pode usar o modelo padrão
  }
  if (!modelos.includes(base.modeloPadrao)) modelos.unshift(base.modeloPadrao);
  return { ...base, disponivel: true, modelos };
}

export async function listarProvedores() {
  return Promise.all([listarOllama(), listarCloud('groq'), listarCloud('gemini')]);
}

// Remove raciocínio exposto por modelos "thinking" (deepseek-r1, qwen etc.)
export function limparPensamento(texto) {
  return texto.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim();
}

async function* linhas(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const linha = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (linha) yield linha;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

async function erroHttp(r, provedor) {
  let detalhe = '';
  try {
    detalhe = (await r.text()).slice(0, 500);
  } catch {}
  if (r.status === 429) return new Error(`${provedor}: limite do plano gratuito atingido (429). Aguarde um pouco ou troque de provedor. ${detalhe}`);
  return new Error(`${provedor} respondeu HTTP ${r.status}: ${detalhe}`);
}

async function* streamOllama({ model, messages, temperature, json, signal }, desligarThink = true) {
  const numCtx = contextoNecessario(messages);
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      keep_alive: '30m',
      ...(desligarThink ? { think: false } : {}),
      ...(json ? { format: 'json' } : {}),
      options: { temperature, num_ctx: numCtx },
    }),
  });
  if (!r.ok) {
    const err = await erroHttp(r, 'Ollama');
    // Modelos sem suporte ao parâmetro "think" retornam 400: tenta de novo sem ele
    if (desligarThink && /think/i.test(err.message)) {
      yield* streamOllama({ model, messages, temperature, json, signal }, false);
      return;
    }
    throw err;
  }
  for await (const linha of linhas(r.body)) {
    const ev = JSON.parse(linha);
    if (ev.error) throw new Error(`Ollama: ${ev.error}`);
    if (ev.message?.content) yield ev.message.content;
  }
}

async function* streamCloud(id, { model, messages, temperature, json, signal }) {
  const p = CLOUD[id];
  const chave = p.chave();
  if (!chave) throw new Error(`${p.nome}: defina ${id.toUpperCase()}_API_KEY no .env`);
  const r = await fetch(`${p.baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chave}` },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      stream: true,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!r.ok) throw await erroHttp(r, p.nome);
  for await (const linha of linhas(r.body)) {
    if (!linha.startsWith('data:')) continue;
    const dados = linha.slice(5).trim();
    if (dados === '[DONE]') return;
    const ev = JSON.parse(dados);
    const texto = ev.choices?.[0]?.delta?.content;
    if (texto) yield texto;
  }
}

/**
 * Gera texto em streaming. Retorna um async iterator de pedaços de texto.
 * @param {{provedor:string, modelo:string, sistema:string, usuario:string, temperatura?:number, json?:boolean, signal?:AbortSignal}} opts
 */
export function gerar({ provedor, modelo, sistema, usuario, temperatura = 0.3, json = false, signal }) {
  const messages = [
    { role: 'system', content: sistema },
    { role: 'user', content: usuario },
  ];
  const args = { model: modelo, messages, temperature: temperatura, json, signal };
  if (provedor === 'ollama') return streamOllama(args);
  if (CLOUD[provedor]) return streamCloud(provedor, args);
  throw new Error(`Provedor desconhecido: ${provedor}`);
}

export async function gerarTexto(opts) {
  let texto = '';
  for await (const pedaco of gerar(opts)) texto += pedaco;
  return limparPensamento(texto);
}

export async function gerarJson(opts) {
  const texto = await gerarTexto({ ...opts, json: true, temperatura: opts.temperatura ?? 0.1 });
  return extrairJson(texto);
}

export function extrairJson(texto) {
  const limpo = texto.replace(/```(?:json)?/g, '').trim();
  try {
    return JSON.parse(limpo);
  } catch {
    const ini = limpo.indexOf('{');
    const fim = limpo.lastIndexOf('}');
    if (ini >= 0 && fim > ini) return JSON.parse(limpo.slice(ini, fim + 1));
    throw new Error('A IA não devolveu um JSON válido. Tente novamente ou use outro modelo.');
  }
}
