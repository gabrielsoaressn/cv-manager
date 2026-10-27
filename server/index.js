import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listarProvedores, gerar, gerarJson, limparPensamento } from './ai.js';
import { listarFontes, textoDaFonte, EXTENSOES } from './fontes.js';
import * as prompts from './prompts.js';
import { RAIZ, PASTA_CURRICULOS, PASTA_DADOS, PASTA_GERACOES, PASTA_LINKEDIN, ARQUIVO_PERFIL } from './caminhos.js';

const run = promisify(execFile);
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(RAIZ, 'public')));
app.use('/vendor/marked.js', express.static(path.join(RAIZ, 'node_modules/marked/lib/marked.umd.js')));

const rota = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.status(400).json({ erro: e.message });
    else res.end(JSON.stringify({ tipo: 'erro', erro: e.message }) + '\n');
  });

/** Resposta em NDJSON: uma linha JSON por evento ({tipo:'texto'|'progresso'|'fim'|'erro', ...}). */
function abrirStream(req, res) {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  return { enviar: (ev) => res.write(JSON.stringify(ev) + '\n'), signal: ctrl.signal };
}

function ia(req) {
  const { provedor, modelo } = req.body || {};
  if (!provedor || !modelo) throw new Error('Escolha um provedor e um modelo de IA');
  return { provedor, modelo };
}

async function lerPerfil() {
  try {
    return await fs.readFile(ARQUIVO_PERFIL, 'utf8');
  } catch {
    return '';
  }
}

/** Perfil mestre; se ainda não existir, junta o texto bruto de todos os currículos. */
async function perfilOuFontes() {
  const perfil = await lerPerfil();
  if (perfil.trim()) return perfil;
  const fontes = (await listarFontes()).filter((f) => !f.erro);
  if (!fontes.length) throw new Error('Nenhum currículo encontrado na pasta curriculos/. Adicione seus currículos primeiro.');
  const textos = await Promise.all(fontes.map(async (f) => `=== ${f.nome} ===\n${await textoDaFonte(f.nome)}`));
  return textos.join('\n\n');
}

// ---------- IA ----------
app.get('/api/provedores', rota(async (req, res) => res.json(await listarProvedores())));

// ---------- Fontes (currículos originais) ----------
app.get('/api/fontes', rota(async (req, res) => res.json(await listarFontes())));

app.get('/api/fontes/:nome/texto', rota(async (req, res) => res.json({ texto: await textoDaFonte(req.params.nome) })));

const upload = multer({
  storage: multer.diskStorage({
    destination: PASTA_CURRICULOS,
    filename: (req, file, cb) => cb(null, path.basename(Buffer.from(file.originalname, 'latin1').toString('utf8'))),
  }),
  fileFilter: (req, file, cb) => cb(null, EXTENSOES.includes(path.extname(file.originalname).toLowerCase())),
  limits: { fileSize: 20e6 },
});
app.post('/api/fontes', upload.array('arquivos'), rota(async (req, res) => res.json({ enviados: req.files.map((f) => f.filename) })));

// ---------- Perfil mestre ----------
app.get('/api/perfil', rota(async (req, res) => res.json({ perfil: await lerPerfil() })));

app.put('/api/perfil', rota(async (req, res) => {
  await fs.writeFile(ARQUIVO_PERFIL, req.body.perfil ?? '');
  res.json({ ok: true });
}));

app.post('/api/perfil/consolidar', rota(async (req, res) => {
  const { provedor, modelo } = ia(req);
  const { fontes: selecionadas, incremental } = req.body;
  const nomes = selecionadas?.length ? selecionadas : (await listarFontes()).filter((f) => !f.erro).map((f) => f.nome);
  if (!nomes.length) throw new Error('Nenhum currículo para consolidar');

  const { enviar, signal } = abrirStream(req, res);
  const anterior = await lerPerfil();
  if (anterior.trim()) {
    const backup = path.join(PASTA_DADOS, `perfil-mestre.${Date.now()}.bak.md`);
    await fs.writeFile(backup, anterior);
    enviar({ tipo: 'progresso', msg: `Backup do perfil anterior salvo em data/${path.basename(backup)}` });
  }

  let perfil = incremental ? anterior : '';
  for (const [i, nome] of nomes.entries()) {
    enviar({ tipo: 'progresso', msg: `(${i + 1}/${nomes.length}) Incorporando ${nome}...`, reiniciar: true });
    const textoFonte = await textoDaFonte(nome);
    let saida = '';
    for await (const pedaco of gerar({
      provedor,
      modelo,
      sistema: prompts.consolidar.sistema,
      usuario: prompts.consolidar.usuario({ perfilAtual: perfil, nomeFonte: nome, textoFonte }),
      temperatura: 0.1,
      signal,
    })) {
      saida += pedaco;
      enviar({ tipo: 'texto', texto: pedaco });
    }
    perfil = limparPensamento(saida).replace(/^```(?:markdown|md)?\n|```$/g, '').trim();
    // Salva a cada etapa: se algo falhar no meio, o progresso não se perde
    await fs.writeFile(ARQUIVO_PERFIL, perfil);
  }
  enviar({ tipo: 'fim', perfil });
  res.end();
}));

// ---------- Adequação à vaga ----------
app.post('/api/vaga/analisar', rota(async (req, res) => {
  const { provedor, modelo } = ia(req);
  if (!req.body.vaga?.trim()) throw new Error('Cole a descrição da vaga');
  const perfil = await perfilOuFontes();
  const analise = await gerarJson({
    provedor,
    modelo,
    sistema: prompts.analisar.sistema,
    usuario: prompts.analisar.usuario({ perfil, vaga: req.body.vaga }),
  });
  res.json(analise);
}));

async function streamTexto(req, res, sistema, usuario, temperatura, aoTerminar) {
  const { provedor, modelo } = ia(req);
  const { enviar, signal } = abrirStream(req, res);
  let saida = '';
  for await (const pedaco of gerar({ provedor, modelo, sistema, usuario, temperatura, signal })) {
    saida += pedaco;
    enviar({ tipo: 'texto', texto: pedaco });
  }
  const texto = limparPensamento(saida).replace(/^```(?:markdown|md)?\n|```$/g, '').trim();
  await aoTerminar?.(texto);
  enviar({ tipo: 'fim', texto });
  res.end();
}

app.post('/api/vaga/curriculo', rota(async (req, res) => {
  const { vaga, analise, idioma = 'pt', tamanho = 'normal', instrucoes } = req.body;
  if (!vaga?.trim()) throw new Error('Cole a descrição da vaga');
  const perfil = await perfilOuFontes();
  await streamTexto(
    req,
    res,
    prompts.adequar.sistema({ idioma, tamanho }),
    prompts.adequar.usuario({ perfil, vaga, analise, instrucoes }),
    0.4,
  );
}));

app.post('/api/vaga/carta', rota(async (req, res) => {
  const { vaga, idioma = 'pt' } = req.body;
  if (!vaga?.trim()) throw new Error('Cole a descrição da vaga');
  const perfil = await perfilOuFontes();
  await streamTexto(req, res, prompts.carta.sistema({ idioma }), prompts.carta.usuario({ perfil, vaga }), 0.5);
}));

app.post('/api/vaga/auditar', rota(async (req, res) => {
  const { provedor, modelo } = ia(req);
  if (!req.body.curriculo?.trim()) throw new Error('Não há currículo para auditar');
  const perfil = await perfilOuFontes();
  res.json(
    await gerarJson({
      provedor,
      modelo,
      sistema: prompts.auditar.sistema,
      usuario: prompts.auditar.usuario({ perfil, curriculo: req.body.curriculo }),
    }),
  );
}));

// ---------- Histórico de currículos gerados ----------
const arquivoGeracao = (id) => {
  if (!/^[\w-]+$/.test(id)) throw new Error('id inválido');
  return path.join(PASTA_GERACOES, `${id}.json`);
};

app.get('/api/geracoes', rota(async (req, res) => {
  const arquivos = (await fs.readdir(PASTA_GERACOES)).filter((n) => n.endsWith('.json'));
  const itens = await Promise.all(
    arquivos.map(async (n) => {
      const g = JSON.parse(await fs.readFile(path.join(PASTA_GERACOES, n), 'utf8'));
      return { id: g.id, criadoEm: g.criadoEm, cargo: g.analise?.cargo, empresa: g.analise?.empresa, aderencia: g.analise?.aderencia };
    }),
  );
  res.json(itens.sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)));
}));

app.get('/api/geracoes/:id', rota(async (req, res) => res.json(JSON.parse(await fs.readFile(arquivoGeracao(req.params.id), 'utf8')))));

app.post('/api/geracoes', rota(async (req, res) => {
  const id = req.body.id || `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const arquivo = arquivoGeracao(id);
  let atual = {};
  try {
    atual = JSON.parse(await fs.readFile(arquivo, 'utf8'));
  } catch {}
  const g = { ...atual, ...req.body, id, criadoEm: atual.criadoEm || new Date().toISOString(), atualizadoEm: new Date().toISOString() };
  await fs.writeFile(arquivo, JSON.stringify(g, null, 2));
  res.json(g);
}));

app.delete('/api/geracoes/:id', rota(async (req, res) => {
  await fs.rm(arquivoGeracao(req.params.id), { force: true });
  res.json({ ok: true });
}));

// ---------- LinkedIn ----------
const NOMES_CAMPOS = { setor: 'setor', cargo: 'cargo almejado', empresa: 'empresa-alvo' };
const arquivoLinkedin = (nome) => path.join(PASTA_LINKEDIN, `${nome}.md`);
const lerOuVazio = (arquivo) => fs.readFile(arquivo, 'utf8').catch(() => '');

app.get('/api/linkedin', rota(async (req, res) => {
  const ferramentas = await Promise.all(
    Object.entries(prompts.linkedin.ferramentas).map(async ([id, f]) => ({
      id,
      nome: f.nome,
      campos: f.campos,
      resultado: await lerOuVazio(arquivoLinkedin(id)),
    })),
  );
  res.json({ perfilAtual: await lerOuVazio(arquivoLinkedin('_perfil-atual')), ferramentas });
}));

app.put('/api/linkedin/perfil-atual', rota(async (req, res) => {
  await fs.writeFile(arquivoLinkedin('_perfil-atual'), req.body.texto ?? '');
  res.json({ ok: true });
}));

app.post('/api/linkedin/:ferramenta', rota(async (req, res) => {
  const id = req.params.ferramenta;
  const ferramenta = Object.hasOwn(prompts.linkedin.ferramentas, id) && prompts.linkedin.ferramentas[id];
  if (!ferramenta) throw new Error('Ferramenta desconhecida');
  const valores = req.body.campos || {};
  const faltando = ferramenta.campos.filter((c) => !valores[c]?.trim());
  if (faltando.length) throw new Error(`Preencha: ${faltando.map((c) => NOMES_CAMPOS[c]).join(', ')}`);
  const perfil = await perfilOuFontes();
  const linkedinAtual = await lerOuVazio(arquivoLinkedin('_perfil-atual'));
  const usuario = prompts.linkedin.usuario({ perfil, linkedinAtual, pedido: ferramenta.pedido(valores) });
  await streamTexto(req, res, prompts.linkedin.sistema, usuario, 0.6, (texto) => fs.writeFile(arquivoLinkedin(id), texto));
}));

// ---------- Exportação ----------
app.post('/api/exportar/docx', rota(async (req, res) => {
  const { markdown, nome = 'curriculo' } = req.body;
  const dir = await fs.mkdtemp(path.join(PASTA_DADOS, 'cache', 'docx-'));
  try {
    const entrada = path.join(dir, 'in.md');
    const saida = path.join(dir, 'out.docx');
    await fs.writeFile(entrada, markdown);
    try {
      await run('pandoc', [entrada, '-f', 'markdown', '-o', saida]);
    } catch {
      throw new Error('Exportar DOCX requer o pandoc instalado (sudo apt install pandoc). Use "Imprimir / PDF" como alternativa.');
    }
    const arquivo = `${nome.replace(/[^\w\- ]+/g, '').trim() || 'curriculo'}.docx`;
    res.setHeader('Content-Disposition', `attachment; filename="${arquivo}"`);
    res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(await fs.readFile(saida));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}));

const PORTA = Number(process.env.PORT || 3333);
app.listen(PORTA, '127.0.0.1', () => {
  console.log(`CV Manager rodando em http://localhost:${PORTA}`);
  console.log(`Coloque seus currículos em: ${PASTA_CURRICULOS}`);
});
