import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PASTA_CURRICULOS = path.resolve(RAIZ, process.env.CURRICULOS_DIR || 'curriculos');
export const PASTA_DADOS = path.join(RAIZ, 'data');
export const PASTA_CACHE = path.join(PASTA_DADOS, 'cache');
export const PASTA_GERACOES = path.join(PASTA_DADOS, 'geracoes');
export const PASTA_LINKEDIN = path.join(PASTA_DADOS, 'linkedin');
export const ARQUIVO_PERFIL = path.join(PASTA_DADOS, 'perfil-mestre.md');

for (const p of [PASTA_CURRICULOS, PASTA_CACHE, PASTA_GERACOES, PASTA_LINKEDIN]) fs.mkdirSync(p, { recursive: true });
