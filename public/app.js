const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const md = (t) => marked.parse(t || '');
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const estado = {
  provedores: [],
  geracaoId: null,
  analise: null,
  curriculo: '',
  carta: '',
  auditoria: null,
  modo: 'ver',
};

// ---------- utilidades ----------
function toast(msg, erro = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = erro ? 'erro' : '';
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), erro ? 7000 : 3000);
}

async function api(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.erro || `Erro HTTP ${r.status}`);
  }
  return r;
}
const apiJson = async (url, opts) => (await api(url, opts)).json();

/** Lê uma resposta NDJSON chamando onEvento para cada linha. */
async function stream(url, body, onEvento) {
  const r = await api(url, { method: 'POST', body });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const linha = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!linha) continue;
      const ev = JSON.parse(linha);
      if (ev.tipo === 'erro') throw new Error(ev.erro);
      onEvento(ev);
    }
  }
}

function ia() {
  return { provedor: $('#provedor').value, modelo: $('#modelo').value };
}

async function ocupado(botao, fn) {
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Aguarde...';
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}

function status(el, msg) {
  el.hidden = !msg;
  el.textContent = msg || '';
}

function baixar(nome, conteudo, tipo) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(conteudo instanceof Blob ? conteudo : new Blob([conteudo], { type: tipo }));
  a.download = nome;
  a.click();
  URL.revokeObjectURL(a.href);
}

function nomeArquivo() {
  const a = estado.analise || {};
  return ['Curriculo', a.cargo, a.empresa].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|]+/g, '');
}

// ---------- abas ----------
$$('.abas button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.abas button').forEach((x) => x.classList.toggle('ativa', x === b));
    $$('.aba').forEach((s) => s.classList.toggle('ativa', s.id === `aba-${b.dataset.aba}`));
    if (b.dataset.aba === 'historico') carregarHistorico();
    if (b.dataset.aba === 'linkedin' && !linkedin.ferramentas.length) carregarLinkedin().catch((e) => toast(e.message, true));
  }),
);

// ---------- provedores de IA ----------
async function carregarProvedores() {
  estado.provedores = await apiJson('/api/provedores');
  const salvo = JSON.parse(localStorage.getItem('ia') || 'null');
  $('#provedor').innerHTML = estado.provedores
    .map((p) => `<option value="${p.id}" ${p.disponivel ? '' : 'disabled'}>${esc(p.nome)}${p.disponivel ? '' : ' — indisponível'}</option>`)
    .join('');
  const escolhido =
    estado.provedores.find((p) => p.id === salvo?.provedor && p.disponivel) || estado.provedores.find((p) => p.disponivel);
  if (escolhido) $('#provedor').value = escolhido.id;
  preencherModelos(salvo?.modelo);
}

function preencherModelos(preferido) {
  const p = estado.provedores.find((x) => x.id === $('#provedor').value);
  $('#modelo').innerHTML = (p?.modelos || []).map((m) => `<option>${esc(m)}</option>`).join('');
  if (p) $('#modelo').value = p.modelos.includes(preferido) ? preferido : p.modeloPadrao;
  const indisponiveis = estado.provedores.filter((x) => !x.disponivel && x.aviso).map((x) => `${x.nome}: ${x.aviso}`);
  $('#ia-aviso').title = indisponiveis.join('\n');
  $('#ia-aviso').textContent = !p ? 'Nenhuma IA disponível — veja o README' : indisponiveis.length ? 'ⓘ' : '';
  salvarIa();
}

function salvarIa() {
  localStorage.setItem('ia', JSON.stringify(ia()));
}
$('#provedor').addEventListener('change', () => preencherModelos());
$('#modelo').addEventListener('change', salvarIa);

// ---------- 1. fontes ----------
async function carregarFontes() {
  const fontes = await apiJson('/api/fontes');
  $('#lista-fontes').innerHTML = fontes.length
    ? fontes
        .map(
          (f) => `<div class="item">
            <div>
              <strong>${esc(f.nome)}</strong>
              <small>${Math.ceil(f.tamanho / 1024)} KB · ${f.caracteres ? `${f.caracteres.toLocaleString('pt-BR')} caracteres extraídos` : ''}</small>
              ${f.erro ? `<small class="txt-erro">Erro: ${esc(f.erro)}</small>` : ''}
              ${f.aviso ? `<small class="txt-aviso">${esc(f.aviso)}</small>` : ''}
            </div>
            ${f.erro ? '' : `<button class="botao link" data-ver="${esc(f.nome)}">Ver texto</button>`}
          </div>`,
        )
        .join('')
    : `<p class="vazio">Nenhum currículo ainda. Coloque arquivos na pasta <code>curriculos/</code> e clique em “Recarregar pasta”.</p>`;

  $('#checks-fontes').innerHTML = fontes
    .filter((f) => !f.erro)
    .map((f) => `<label class="check"><input type="checkbox" value="${esc(f.nome)}" checked /> ${esc(f.nome)}</label>`)
    .join('') || '<p class="vazio">Nenhum currículo disponível.</p>';
}

$('#lista-fontes').addEventListener('click', async (e) => {
  const nome = e.target.dataset.ver;
  if (!nome) return;
  try {
    const { texto } = await apiJson(`/api/fontes/${encodeURIComponent(nome)}/texto`);
    $('#previa-titulo').textContent = nome;
    $('#previa-texto').textContent = texto;
    $('#previa-fonte').hidden = false;
    $('#previa-fonte').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    toast(err.message, true);
  }
});
$('#fechar-previa').addEventListener('click', () => ($('#previa-fonte').hidden = true));
$('#recarregar-fontes').addEventListener('click', (e) => ocupado(e.target, carregarFontes));
$('#upload').addEventListener('change', async (e) => {
  const fd = new FormData();
  for (const f of e.target.files) fd.append('arquivos', f);
  try {
    const { enviados } = await apiJson('/api/fontes', { method: 'POST', body: fd });
    toast(`${enviados.length} arquivo(s) enviado(s)`);
    await carregarFontes();
  } catch (err) {
    toast(err.message, true);
  }
  e.target.value = '';
});

// ---------- 2. perfil mestre ----------
const atualizarPreviaPerfil = () => ($('#perfil-preview').innerHTML = md($('#perfil').value));
$('#perfil').addEventListener('input', atualizarPreviaPerfil);

async function carregarPerfil() {
  const { perfil } = await apiJson('/api/perfil');
  $('#perfil').value = perfil;
  atualizarPreviaPerfil();
}

$('#salvar-perfil').addEventListener('click', (e) =>
  ocupado(e.target, async () => {
    await apiJson('/api/perfil', { method: 'PUT', body: { perfil: $('#perfil').value } });
    toast('Perfil mestre salvo');
  }),
);

function consolidar(incremental) {
  return (e) =>
    ocupado(e.target, async () => {
      const fontes = $$('#checks-fontes input:checked').map((c) => c.value);
      if (!fontes.length) throw new Error('Selecione ao menos um currículo');
      if (!incremental && $('#perfil').value.trim() && !confirm('Recriar o perfil mestre do zero? (o atual vai para um backup em data/)')) return;
      const prog = $('#progresso-perfil');
      let texto = '';
      await stream('/api/perfil/consolidar', { ...ia(), fontes, incremental }, (ev) => {
        if (ev.tipo === 'progresso') {
          status(prog, ev.msg);
          if (ev.reiniciar) texto = '';
        } else if (ev.tipo === 'texto') {
          texto += ev.texto;
          $('#perfil').value = texto;
          atualizarPreviaPerfil();
        } else if (ev.tipo === 'fim') {
          $('#perfil').value = ev.perfil;
          atualizarPreviaPerfil();
        }
      });
      status(prog, '');
      toast('Perfil mestre consolidado e salvo. Revise antes de usar!');
    });
}
$('#consolidar').addEventListener('click', consolidar(false));
$('#consolidar-incremental').addEventListener('click', consolidar(true));

// ---------- 3. adequar à vaga ----------
function renderAnalise() {
  const a = estado.analise;
  const el = $('#analise');
  if (!a) return (el.hidden = true);
  const nota = Math.max(0, Math.min(100, Number(a.aderencia) || 0));
  const cor = nota >= 70 ? 'var(--ok)' : nota >= 45 ? 'var(--atencao)' : 'var(--erro)';
  const lista = (itens, fn) => (itens?.length ? `<ul>${itens.map(fn).join('')}</ul>` : '<p class="vazio">—</p>');
  el.hidden = false;
  el.innerHTML = `
    <div class="aderencia">
      <div class="medidor" style="--p:${nota};--cor:${cor}"><span>${nota}%</span></div>
      <div>
        <h3>${esc(a.cargo || 'Vaga')}${a.empresa ? ` · ${esc(a.empresa)}` : ''}</h3>
        <small>${esc(a.senioridade || '')} · aderência estimada do seu perfil</small>
      </div>
    </div>
    <details open><summary>Requisitos que você atende (${a.requisitos_atendidos?.length || 0})</summary>
      ${lista(a.requisitos_atendidos, (r) => `<li><strong>${esc(r.requisito)}</strong><br><small>${esc(r.evidencia)}</small></li>`)}
    </details>
    <details open><summary>Lacunas (${a.lacunas?.length || 0})</summary>
      ${lista(a.lacunas, (r) => `<li><strong>${esc(r.requisito)}</strong><br><small>${esc(r.observacao)}</small></li>`)}
    </details>
    <details><summary>Pontos fortes</summary>${lista(a.pontos_fortes, (t) => `<li>${esc(t)}</li>`)}</details>
    <details><summary>Recomendações</summary>${lista(a.recomendacoes, (t) => `<li>${esc(t)}</li>`)}</details>`;
}

/** Quais palavras-chave da vaga aparecem no currículo gerado (o que um ATS procuraria). */
function renderCobertura() {
  const el = $('#cobertura');
  const chaves = estado.analise?.palavras_chave || [];
  if (!chaves.length || !estado.curriculo) return (el.hidden = true);
  const normal = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const texto = normal(estado.curriculo);
  const tem = chaves.filter((k) => texto.includes(normal(k)));
  el.hidden = false;
  el.innerHTML = `<small>Palavras-chave da vaga no currículo: <strong>${tem.length}/${chaves.length}</strong></small>
    <div class="tags">${chaves.map((k) => `<span class="tag ${tem.includes(k) ? 'sim' : 'nao'}" title="${tem.includes(k) ? 'Presente' : 'Ausente — só inclua se for verdade'}">${esc(k)}</span>`).join('')}</div>`;
}

function renderCurriculo() {
  $('#cv-preview').innerHTML = estado.curriculo ? md(estado.curriculo) : '<p class="vazio">O currículo gerado aparece aqui.</p>';
  if ($('#cv-editor').value !== estado.curriculo) $('#cv-editor').value = estado.curriculo;
  $('#carta-preview').innerHTML = estado.carta
    ? md(estado.carta)
    : '<p class="vazio">Clique em “Gerar carta” para criar uma carta de apresentação para esta vaga.</p>';
  renderCobertura();
}

function renderAuditoria() {
  const a = estado.auditoria;
  const el = $('#auditoria');
  if (!a) return (el.hidden = true);
  el.hidden = false;
  const problemas = a.problemas || [];
  el.innerHTML = `<h3>Verificação de fidelidade: <span class="veredito ${problemas.length ? 'ruim' : 'bom'}">${esc(a.veredito || (problemas.length ? 'ajustes' : 'fiel'))}</span></h3>
    ${
      problemas.length
        ? `<ul>${problemas
            .map(
              (p) => `<li><span class="tag nao">${esc(p.tipo)}</span> “${esc(p.trecho)}”<br><small>${esc(p.explicacao)}</small>
              ${p.sugestao ? `<br><small><strong>Sugestão:</strong> ${esc(p.sugestao)}</small>` : ''}</li>`,
            )
            .join('')}</ul><p class="ajuda">Corrija na aba “Editar”. A auditoria também é feita por IA: use seu julgamento.</p>`
        : '<p>Nenhuma afirmação sem respaldo no perfil mestre foi encontrada.</p>'
    }`;
}

function modo(m) {
  estado.modo = m;
  $$('.alternar button').forEach((b) => b.classList.toggle('ativa', b.dataset.modo === m));
  $('#cv-preview').hidden = m !== 'ver';
  $('#cv-editor').hidden = m !== 'editar';
  $('#carta-preview').hidden = m !== 'carta';
}
$$('.alternar button').forEach((b) => b.addEventListener('click', () => modo(b.dataset.modo)));

let salvarTimer;
$('#cv-editor').addEventListener('input', () => {
  estado.curriculo = $('#cv-editor').value;
  $('#cv-preview').innerHTML = md(estado.curriculo);
  renderCobertura();
  clearTimeout(salvarTimer);
  salvarTimer = setTimeout(salvarGeracao, 1500);
});

function idiomaEscolhido() {
  const v = $('#idioma').value;
  return v === 'auto' ? estado.analise?.idioma_vaga || 'pt' : v;
}

async function salvarGeracao() {
  if (!estado.curriculo) return;
  const g = await apiJson('/api/geracoes', {
    method: 'POST',
    body: {
      id: estado.geracaoId,
      vaga: $('#vaga').value,
      instrucoes: $('#instrucoes').value,
      idioma: $('#idioma').value,
      tamanho: $('#tamanho').value,
      analise: estado.analise,
      curriculo: estado.curriculo,
      carta: estado.carta,
      auditoria: estado.auditoria,
      ...ia(),
    },
  });
  estado.geracaoId = g.id;
}

$('#gerar').addEventListener('click', (e) =>
  ocupado(e.target, async () => {
    const vaga = $('#vaga').value.trim();
    if (!vaga) throw new Error('Cole a descrição da vaga');
    const st = $('#status-vaga');
    estado.geracaoId = null;
    estado.auditoria = null;
    estado.carta = '';
    renderAuditoria();

    status(st, 'Analisando a vaga e comparando com seu perfil... (modelos locais podem levar alguns minutos)');
    estado.analise = await apiJson('/api/vaga/analisar', { method: 'POST', body: { ...ia(), vaga } });
    renderAnalise();

    status(st, 'Escrevendo o currículo adequado...');
    modo('ver');
    estado.curriculo = '';
    let texto = '';
    await stream(
      '/api/vaga/curriculo',
      { ...ia(), vaga, analise: estado.analise, idioma: idiomaEscolhido(), tamanho: $('#tamanho').value, instrucoes: $('#instrucoes').value },
      (ev) => {
        if (ev.tipo === 'texto') {
          texto += ev.texto;
          $('#cv-preview').innerHTML = md(texto);
        } else if (ev.tipo === 'fim') {
          estado.curriculo = ev.texto;
        }
      },
    );
    renderCurriculo();
    await salvarGeracao();
    if ($('#auto-auditar').checked) {
      status(st, 'Conferindo cada afirmação contra o perfil mestre...');
      await auditar();
    }
    status(st, '');
    toast($('#auto-auditar').checked ? 'Currículo gerado, verificado e salvo no histórico' : 'Currículo gerado e salvo. Rode “Verificar fidelidade” antes de enviar!');
  }),
);

async function auditar() {
  if (!estado.curriculo) throw new Error('Gere um currículo primeiro');
  estado.auditoria = await apiJson('/api/vaga/auditar', { method: 'POST', body: { ...ia(), curriculo: estado.curriculo } });
  renderAuditoria();
  $('#auditoria').scrollIntoView({ behavior: 'smooth' });
  await salvarGeracao();
}
$('#auditar').addEventListener('click', (e) => ocupado(e.target, auditar));

$('#gerar-carta').addEventListener('click', (e) =>
  ocupado(e.target, async () => {
    const vaga = $('#vaga').value.trim();
    if (!vaga) throw new Error('Cole a descrição da vaga');
    modo('carta');
    let texto = '';
    await stream('/api/vaga/carta', { ...ia(), vaga, idioma: idiomaEscolhido() }, (ev) => {
      if (ev.tipo === 'texto') {
        texto += ev.texto;
        $('#carta-preview').innerHTML = md(texto);
      } else if (ev.tipo === 'fim') estado.carta = ev.texto;
    });
    renderCurriculo();
    await salvarGeracao();
  }),
);

const textoAtual = () => (estado.modo === 'carta' ? estado.carta : estado.curriculo);

$('#copiar').addEventListener('click', async () => {
  if (!textoAtual()) return toast('Nada para copiar', true);
  await navigator.clipboard.writeText(textoAtual());
  toast('Copiado (Markdown)');
});
$('#baixar-md').addEventListener('click', () => {
  if (!textoAtual()) return toast('Nada para baixar', true);
  baixar(`${estado.modo === 'carta' ? 'Carta' : nomeArquivo()}.md`, textoAtual(), 'text/markdown');
});
$('#baixar-docx').addEventListener('click', (e) =>
  ocupado(e.target, async () => {
    if (!textoAtual()) throw new Error('Nada para exportar');
    const nome = estado.modo === 'carta' ? 'Carta de apresentacao' : nomeArquivo();
    const r = await api('/api/exportar/docx', { method: 'POST', body: { markdown: textoAtual(), nome } });
    baixar(`${nome}.docx`, await r.blob());
  }),
);
$('#imprimir').addEventListener('click', () => {
  if (!textoAtual()) return toast('Nada para imprimir', true);
  const w = window.open('', '_blank');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(nomeArquivo())}</title>
    <link rel="stylesheet" href="${location.origin}/impressao.css"></head>
    <body>${md(textoAtual())}<script>window.onload=()=>setTimeout(()=>print(),200)<\/script></body></html>`);
  w.document.close();
});

$('#nova').addEventListener('click', () => {
  Object.assign(estado, { geracaoId: null, analise: null, curriculo: '', carta: '', auditoria: null });
  $('#vaga').value = '';
  $('#instrucoes').value = '';
  renderAnalise();
  renderCurriculo();
  renderAuditoria();
  modo('ver');
});

// ---------- histórico ----------
async function carregarHistorico() {
  const itens = await apiJson('/api/geracoes');
  $('#lista-historico').innerHTML = itens.length
    ? itens
        .map(
          (g) => `<div class="item">
            <div><strong>${esc(g.cargo || 'Vaga sem título')}${g.empresa ? ` · ${esc(g.empresa)}` : ''}</strong>
            <small>${new Date(g.criadoEm).toLocaleString('pt-BR')}${g.aderencia != null ? ` · aderência ${g.aderencia}%` : ''}</small></div>
            <div><button class="botao link" data-abrir="${g.id}">Abrir</button><button class="botao link perigo" data-apagar="${g.id}">Apagar</button></div>
          </div>`,
        )
        .join('')
    : '<p class="vazio">Nenhum currículo gerado ainda.</p>';
}

$('#lista-historico').addEventListener('click', async (e) => {
  const { abrir, apagar } = e.target.dataset;
  try {
    if (apagar && confirm('Apagar este currículo do histórico?')) {
      await apiJson(`/api/geracoes/${apagar}`, { method: 'DELETE' });
      carregarHistorico();
    }
    if (abrir) {
      const g = await apiJson(`/api/geracoes/${abrir}`);
      Object.assign(estado, { geracaoId: g.id, analise: g.analise, curriculo: g.curriculo || '', carta: g.carta || '', auditoria: g.auditoria });
      $('#vaga').value = g.vaga || '';
      $('#instrucoes').value = g.instrucoes || '';
      if (g.idioma) $('#idioma').value = g.idioma;
      if (g.tamanho) $('#tamanho').value = g.tamanho;
      renderAnalise();
      renderCurriculo();
      renderAuditoria();
      modo('ver');
      $('[data-aba="vaga"]').click();
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- LinkedIn ----------
const linkedin = { ferramentas: [], atual: null };
const NOMES_CAMPOS = { setor: 'Setor', cargo: 'Cargo almejado', empresa: 'Empresa-alvo' };

const valoresCampos = () => Object.fromEntries($$('[data-campo]').map((i) => [i.dataset.campo, i.value.trim()]));

try {
  const salvos = JSON.parse(localStorage.getItem('linkedin-campos') || '{}');
  $$('[data-campo]').forEach((i) => (i.value = salvos[i.dataset.campo] || ''));
} catch {}
$$('[data-campo]').forEach((i) =>
  i.addEventListener('input', () => {
    localStorage.setItem('linkedin-campos', JSON.stringify(valoresCampos()));
    renderFerramenta();
  }),
);

async function carregarLinkedin() {
  const dados = await apiJson('/api/linkedin');
  linkedin.ferramentas = dados.ferramentas;
  $('#linkedin-atual').value = dados.perfilAtual;
  $('#ferramentas-linkedin').innerHTML = dados.ferramentas
    .map((f) => `<button class="ferramenta" data-ferramenta="${f.id}">${esc(f.nome)}<small>${f.resultado ? 'gerado' : ''}</small></button>`)
    .join('');
  if (!linkedin.atual) linkedin.atual = dados.ferramentas[0]?.id;
  renderFerramenta();
}

function renderFerramenta() {
  const f = linkedin.ferramentas.find((x) => x.id === linkedin.atual);
  if (!f) return;
  $$('.ferramenta').forEach((b) => b.classList.toggle('ativa', b.dataset.ferramenta === f.id));
  $('#linkedin-titulo').textContent = f.nome;
  const valores = valoresCampos();
  const faltando = f.campos.filter((c) => !valores[c]);
  $('#linkedin-campos-faltando').textContent = faltando.length ? `Preencha: ${faltando.map((c) => NOMES_CAMPOS[c]).join(', ')}` : '';
  $('#linkedin-gerar').disabled = faltando.length > 0;
  $('#linkedin-gerar').textContent = f.resultado ? 'Gerar de novo' : 'Gerar';
  $('#linkedin-resultado').innerHTML = f.resultado ? md(f.resultado) : '<p class="vazio">Clique em “Gerar”.</p>';
}

$('#ferramentas-linkedin').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ferramenta]');
  if (!b) return;
  linkedin.atual = b.dataset.ferramenta;
  renderFerramenta();
});

$('#salvar-linkedin').addEventListener('click', (e) =>
  ocupado(e.target, async () => {
    await apiJson('/api/linkedin/perfil-atual', { method: 'PUT', body: { texto: $('#linkedin-atual').value } });
    toast('Perfil atual do LinkedIn salvo');
  }),
);

$('#linkedin-gerar').addEventListener('click', (e) =>
  ocupado(e.target, async () => {
    const f = linkedin.ferramentas.find((x) => x.id === linkedin.atual);
    let texto = '';
    await stream(`/api/linkedin/${f.id}`, { ...ia(), campos: valoresCampos() }, (ev) => {
      if (ev.tipo === 'texto') {
        texto += ev.texto;
        $('#linkedin-resultado').innerHTML = md(texto);
      } else if (ev.tipo === 'fim') f.resultado = ev.texto;
    });
    $(`[data-ferramenta="${f.id}"] small`).textContent = 'gerado';
    renderFerramenta();
  }),
);

$('#linkedin-copiar').addEventListener('click', async () => {
  const f = linkedin.ferramentas.find((x) => x.id === linkedin.atual);
  if (!f?.resultado) return toast('Nada para copiar', true);
  await navigator.clipboard.writeText(f.resultado);
  toast('Copiado');
});

// ---------- início ----------
Promise.all([carregarProvedores(), carregarFontes(), carregarPerfil()]).catch((e) => toast(e.message, true));
