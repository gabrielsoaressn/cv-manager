// Leitura dos currículos-fonte (pasta curriculos/) e extração de texto, com cache.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { PASTA_CURRICULOS, PASTA_CACHE } from './caminhos.js';

const run = promisify(execFile);

export const EXTENSOES = ['.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt', '.md'];

async function extrairPdf(arquivo) {
  // pdftotext (poppler) preserva melhor o layout; pdf-parse é o plano B
  try {
    const { stdout } = await run('pdftotext', ['-layout', '-enc', 'UTF-8', arquivo, '-'], { maxBuffer: 20e6 });
    if (stdout.trim()) return stdout;
  } catch {}
  const { text } = await pdfParse(await fs.readFile(arquivo));
  return text;
}

async function extrairViaLibreOffice(arquivo) {
  const saida = await fs.mkdtemp(path.join(PASTA_CACHE, 'lo-'));
  try {
    await run('libreoffice', ['--headless', '--convert-to', 'txt:Text', '--outdir', saida, arquivo], { timeout: 60000 });
    const txt = path.join(saida, path.basename(arquivo, path.extname(arquivo)) + '.txt');
    return await fs.readFile(txt, 'utf8');
  } finally {
    await fs.rm(saida, { recursive: true, force: true });
  }
}

async function extrair(arquivo) {
  const ext = path.extname(arquivo).toLowerCase();
  switch (ext) {
    case '.pdf':
      return extrairPdf(arquivo);
    case '.docx': {
      const { value } = await mammoth.extractRawText({ path: arquivo });
      return value;
    }
    case '.txt':
    case '.md':
      return fs.readFile(arquivo, 'utf8');
    case '.odt':
    case '.rtf':
      try {
        const { stdout } = await run('pandoc', [arquivo, '-t', 'plain', '--wrap=none'], { maxBuffer: 20e6 });
        return stdout;
      } catch {
        return extrairViaLibreOffice(arquivo);
      }
    case '.doc':
      return extrairViaLibreOffice(arquivo);
    default:
      throw new Error(`Formato não suportado: ${ext}`);
  }
}

function normalizar(texto) {
  return texto
    .replace(/\r/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function caminhoSeguro(nome) {
  const base = path.basename(nome);
  if (!base || base.startsWith('.')) throw new Error('Nome de arquivo inválido');
  return path.join(PASTA_CURRICULOS, base);
}

/** Texto extraído de um currículo, usando cache por data de modificação/tamanho. */
export async function textoDaFonte(nome) {
  const arquivo = caminhoSeguro(nome);
  const st = await fs.stat(arquivo);
  const chave = crypto.createHash('sha1').update(`${nome}|${st.mtimeMs}|${st.size}`).digest('hex');
  const cache = path.join(PASTA_CACHE, `${chave}.txt`);
  try {
    return await fs.readFile(cache, 'utf8');
  } catch {}
  const texto = normalizar(await extrair(arquivo));
  await fs.writeFile(cache, texto);
  return texto;
}

export async function listarFontes() {
  const nomes = (await fs.readdir(PASTA_CURRICULOS)).filter(
    (n) => !n.startsWith('.') && EXTENSOES.includes(path.extname(n).toLowerCase()),
  );
  const fontes = await Promise.all(
    nomes.map(async (nome) => {
      const st = await fs.stat(caminhoSeguro(nome));
      const item = { nome, tamanho: st.size, modificado: st.mtime };
      try {
        const texto = await textoDaFonte(nome);
        item.caracteres = texto.length;
        if (texto.length < 200) item.aviso = 'Pouco texto extraído (PDF escaneado/imagem?)';
      } catch (e) {
        item.erro = e.message;
      }
      return item;
    }),
  );
  return fontes.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}
