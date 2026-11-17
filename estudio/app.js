"use strict";
// Estúdio de Edição — vídeo do celular → vertical pronto para postar.
// Tudo roda no navegador: transcrição (transcritor.js), prévia e exportação (canvas + MediaRecorder).
// O Claude (capacidade sample) monta o plano de edição; db guarda biblioteca de sons, logos e presets.

// ================================================================ estado
const $ = (id) => document.getElementById(id);
const TONS = ["Humor ácido", "Humor leve", "Sarcástico", "Absurdo", "Autodepreciativo", "Informativo", "Motivacional", "Sério"];
const CORES = ["#FFD400", "#38E07B", "#FF4FA3", "#4FD2FF", "#FF7A1A", "#FFFFFF"];
const SONS_EMBUTIDOS = ["pop", "whoosh", "ding", "boom", "grilo"];
const OPCOES = ["op-gancho", "op-camera", "op-humor", "op-silencio", "op-vozprincipal", "op-ruido", "op-muletas", "op-sfx", "op-emoji", "op-barra", "op-atras", "op-luz", "op-final"];
const AJUSTES = { "aj-pausa": 0.35, "aj-respiro": 0.12, "aj-sens": 0.3 };
const st = {
  arquivo: null, chave: null, dur: 0, vw: 0, vh: 0,
  segs: [],            // {id, t0, t1, texto, marca}
  plano: null,
  versao: "completa",
  estilo: { fonte: "Anton", destaque: "#FFD400", posicao: 0.68, caixa: true, porBloco: 3 },
  audio: null,         // análise do áudio: energia e tom por quadro de 20 ms
  tons: new Set(),
  musicaUrl: null,
  luz: { brilho: 1, contraste: 1, saturacao: 1.08 },
  exportando: false, videoBlob: null, videoNome: "",
  sons: [],            // biblioteca {id, nome, b64, mime}
  logos: [],           // {id, nome, b64}
  presets: [],         // {id, nome, ...}
  logoId: "",
  capaBlob: null,
  analise: null, analisando: false, quadrosAnalise: null,
};
const video = $("video"), musica = $("musica");
const tela = $("tela"), ctxTela = tela.getContext("2d");
const imgsLogo = new Map();     // id → HTMLImageElement
const buffersSom = new Map();   // nome normalizado → AudioBuffer

let downloads = null, sample = null, sampleImagens = false, db = null, ditado = null;

// ================================================================ utilidades
const fmt = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, "0")}`; };
const fmtD = (t) => `${fmt(t)}.${Math.floor((Math.max(0, t) % 1) * 10)}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const normal = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
const op = (id) => $(id).checked;
function mostrar(el, texto, tipo) { el.hidden = !texto; el.textContent = texto || ""; el.className = "aviso" + (tipo ? " " + tipo : ""); }
function escapar(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function marcarEtapa(id, estado) { const el = $(id); el.classList.remove("ativa", "feita"); if (estado) el.classList.add(estado); }
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
function idNovo() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function b64DeBlob(blob) { return new Promise((ok, falha) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = falha; r.readAsDataURL(blob); }); }
function blobDeB64(b64, mime) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: mime }); }

// ---------------------------------------------------------------- estado local da sessão (por vídeo)
function lerDirecao() {
  const o = {}; OPCOES.forEach((id) => o[id] = op(id));
  return {
    tons: [...st.tons], tomLivre: $("tom-livre").value, quero: $("quero").value, naoQuero: $("nao-quero").value,
    opcoes: o, estilo: { ...st.estilo }, logoId: st.logoId, logoPos: $("logo-pos").value, logoOpac: $("logo-opac").value,
    arroba: $("final-arroba").value, chamada: $("final-chamada").value,
    ajustes: Object.fromEntries(Object.keys(AJUSTES).map((id) => [id, parseFloat($(id).value)])),
  };
}
function aplicarDirecao(d) {
  if (!d) return;
  st.tons = new Set(d.tons || []);
  $("tom-livre").value = d.tomLivre || ""; $("quero").value = d.quero || ""; $("nao-quero").value = d.naoQuero || "";
  for (const id of OPCOES) if (d.opcoes && id in d.opcoes) $(id).checked = !!d.opcoes[id];
  if (d.estilo) Object.assign(st.estilo, d.estilo);
  if (d.logoId !== undefined) st.logoId = d.logoId;
  if (d.logoPos) $("logo-pos").value = d.logoPos;
  if (d.logoOpac) $("logo-opac").value = d.logoOpac;
  if (d.arroba !== undefined) $("final-arroba").value = d.arroba;
  if (d.chamada !== undefined) $("final-chamada").value = d.chamada;
  if (d.ajustes) for (const id of Object.keys(AJUSTES)) if (typeof d.ajustes[id] === "number") $(id).value = d.ajustes[id];
  mostrarAjustes();
  desenharChips(); sincronizarEstiloUI(); desenharLogos();
}
function salvarLocal() {
  if (!st.chave) return;
  try { localStorage.setItem(st.chave, JSON.stringify({ segs: st.segs, plano: st.plano, versao: st.versao, analise: st.analise, direcao: lerDirecao() })); } catch {}
}
function lerLocal(chave) { try { return JSON.parse(localStorage.getItem(chave) || "null"); } catch { return null; } }

// ================================================================ capacidades
(async () => {
  for (let i = 0; i < 30 && !window.claude?.use; i++) await espera(100);
  const usar = async (n) => { try { return await window.claude?.use?.(n); } catch { return null; } };
  [downloads, sample, db, ditado] = await Promise.all([usar("downloads"), usar("sample"), usar("db"), usar("dictation")]);
  if (sample) { try { sampleImagens = !!(await sample.limits())?.images; } catch { sampleImagens = false; } }
  if (ditado) prepararDitado();
  if (db) assinarBiblioteca();
  else {
    ["msg-som", "msg-logo"].forEach((id) => $(id).textContent = "A biblioteca de sons e logos só funciona no app do Claude.");
    ["btn-som", "btn-logo"].forEach((id) => $(id).disabled = true);
  }
  carregarPresetsLocais();
  if (sample && st.segs.length && !st.analise && !st.analisando) analisarVideo();
  atualizarBotoes();
})();

// ================================================================ 1. vídeo
const solta = $("solta");
["dragenter", "dragover"].forEach((e) => solta.addEventListener(e, (ev) => { ev.preventDefault(); solta.classList.add("sobre"); }));
["dragleave", "drop"].forEach((e) => solta.addEventListener(e, (ev) => { ev.preventDefault(); solta.classList.remove("sobre"); }));
solta.addEventListener("drop", (ev) => { const f = ev.dataTransfer.files[0]; if (f) carregarVideo(f); });
$("arq-video").addEventListener("change", (ev) => { const f = ev.target.files[0]; if (f) carregarVideo(f); });

async function carregarVideo(f) {
  pararReproducao();
  mostrar($("erro-video"), "");
  st.arquivo = f; st.chave = `estudio-edicao:${f.name}:${f.size}`;
  st.segs = []; st.plano = null; st.videoBlob = null; st.versao = "completa"; st.analise = null; st.quadrosAnalise = null; st.audio = null;
  mostrarAnalise();
  $("exp-acoes").hidden = true; mostrar($("exp-msg"), ""); $("plano-box").hidden = true;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(f);
  try {
    await new Promise((ok, falha) => { video.onloadedmetadata = ok; video.onerror = () => falha(new Error("formato")); });
  } catch {
    mostrar($("erro-video"), "Este vídeo não abre no navegador. Se veio de iPhone, ele pode estar em HEVC: em Ajustes › Câmera › Formatos, escolha \"Mais compatível\" e grave de novo, ou converta para MP4 (H.264).");
    return;
  }
  st.dur = video.duration; st.vw = video.videoWidth; st.vh = video.videoHeight;
  const info = $("info-video"); info.hidden = false;
  info.innerHTML = `<span><b>${escapar(f.name)}</b></span><span>${fmt(st.dur)}</span><span>${st.vw}×${st.vh}</span><span>${(f.size / 1048576).toFixed(1)} MB</span>`;
  $("est-video").textContent = "Pronto";
  marcarEtapa("et-video", "feita"); marcarEtapa("et-trans", "ativa");
  $("tela-vazia").hidden = true;
  $("btn-play").disabled = false; $("scrub").disabled = false;
  await saltar(Math.min(0.5, st.dur / 2));
  await analisarLuz();
  const salvo = lerLocal(st.chave);
  if (salvo?.segs?.length) {
    st.segs = salvo.segs; st.plano = salvo.plano || null; st.versao = salvo.versao || "completa";
    st.analise = salvo.analise || null;
    aplicarDirecao(salvo.direcao);
    mostrarAnalise();
    if (!st.analise && sample) analisarVideo();
    recalcular(); mostrarTrechos(); if (st.plano) mostrarPlano(); atualizarBotoes();
    $("est-trans").textContent = "Recuperado da última sessão";
    await irPara(0);
    garantirAudio();
    return;
  }
  recalcular(); desenharTela();
  transcrever();
}

// correção de luz: mede brilho e contraste em alguns quadros
async function analisarLuz() {
  const c = document.createElement("canvas"); c.width = 64; c.height = 112;
  const cx = c.getContext("2d", { willReadFrequently: true });
  let soma = 0, soma2 = 0, n = 0, sat = 0;
  const volta = video.currentTime;
  for (const f of [0.2, 0.5, 0.8]) {
    await saltar(st.dur * f);
    cx.drawImage(video, 0, 0, c.width, c.height);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) {
      const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      soma += l; soma2 += l * l; n++;
      sat += (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2])) / 255;
    }
  }
  await saltar(volta);
  const media = soma / n, desvio = Math.sqrt(Math.max(0, soma2 / n - media * media)), satMedia = sat / n;
  st.luz = {
    brilho: clamp(0.47 / Math.max(media, 0.05), 0.9, 1.45),
    contraste: clamp(0.21 / Math.max(desvio, 0.05), 0.95, 1.3),
    saturacao: clamp(0.22 / Math.max(satMedia, 0.05), 1.0, 1.3),
  };
}
const filtroLuz = () => op("op-luz") ? `brightness(${st.luz.brilho.toFixed(3)}) contrast(${st.luz.contraste.toFixed(3)}) saturate(${st.luz.saturacao.toFixed(3)})` : "none";

// ================================================================ 2. transcrição
let worker = null;
async function audio16k(file) {
  const buf = await file.arrayBuffer();
  const ac0 = new AudioContext();
  let dec;
  try { dec = await ac0.decodeAudioData(buf); } finally { ac0.close(); }
  const off = new OfflineAudioContext(1, Math.ceil(dec.duration * 16000), 16000);
  const src = off.createBufferSource(); src.buffer = dec; src.connect(off.destination); src.start();
  return (await off.startRendering()).getChannelData(0);
}

async function transcrever() {
  $("trans-vazio").hidden = true; $("trans-pronto").hidden = true; $("trans-progresso").hidden = false;
  $("trans-status").textContent = "Extraindo o áudio…"; $("trans-barra").style.width = "4%";
  $("est-trans").textContent = "Transcrevendo";
  let audio;
  try { audio = await audio16k(st.arquivo); }
  catch { $("trans-status").textContent = "Não consegui ler o áudio deste vídeo. Confira se ele tem som e está em MP4."; return; }
  $("trans-status").textContent = "Analisando o áudio (voz, silêncios e ruído)…";
  await espera(30);
  st.audio = analisarAudio(audio);
  if (!worker) worker = new Worker("transcritor.js", { type: "module" });
  const inicio = performance.now();
  st.quadrosAnalise = capturarQuadros(6); // análise visual em paralelo à transcrição
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.tipo === "status") $("trans-status").textContent = m.texto;
    if (m.tipo === "carregando") $("trans-status").textContent = `Carregando o modelo de transcrição (${m.parte}/${m.total})…`;
    if (m.tipo === "progresso") {
      $("trans-barra").style.width = `${Math.round(8 + m.feito * 92)}%`;
      $("trans-status").textContent = `Transcrevendo… ${Math.round(m.feito * 100)}% (${Math.round((performance.now() - inicio) / 1000)} s)`;
    }
    if (m.tipo === "erro") { $("trans-status").textContent = "A transcrição falhou: " + m.texto; $("est-trans").textContent = "Erro"; }
    if (m.tipo === "pronto") {
      st.segs = limparSegmentos(m.segmentos).map((s, i) => ({ id: i + 1, t0: s.t0, t1: s.t1, texto: s.texto, marca: "manter" }));
      classificarVozes(true);
      $("trans-progresso").hidden = true;
      if (!st.segs.length) { $("trans-vazio").hidden = false; $("trans-vazio").textContent = "Não encontrei fala neste vídeo."; return; }
      recalcular(); mostrarTrechos(); salvarLocal(); atualizarBotoes(); irPara(0);
      analisarVideo();
    }
  };
  worker.postMessage({ tipo: "transcrever", audio, duracao: st.dur }, [audio.buffer]);
}

function limparSegmentos(segs) {
  const fora = /^[\[(].*[\])]$/;
  const out = [];
  for (const s of segs) {
    const texto = s.texto.replace(/\s+/g, " ").trim();
    if (!texto || fora.test(texto)) continue;
    const ant = out[out.length - 1];
    if (ant && ant.texto === texto && s.t0 - ant.t1 < 1) continue;
    out.push({ t0: clamp(s.t0, 0, st.dur), t1: clamp(s.t1, 0, st.dur), texto });
  }
  return out;
}

function mostrarTrechos() {
  $("trans-vazio").hidden = true; $("trans-pronto").hidden = false;
  marcarEtapa("et-trans", "feita"); if (!st.plano) marcarEtapa("et-direcao", "ativa");
  $("est-trans").textContent = `${st.segs.length} trechos`;
  const box = $("trechos"); box.innerHTML = "";
  const cortClaude = cortesClaude();
  for (const s of st.segs) {
    const el = document.createElement("div");
    el.className = "trecho " + s.marca + (s.marca === "manter" && cortClaude.has(s.id) ? " cortado-claude" : "");
    el.dataset.id = s.id;
    el.innerHTML = `<button class="tempo" type="button" title="Ver no monitor">${fmtD(s.t0)}</button>
      <div class="txt-box"><textarea class="txt" rows="1" spellcheck="true" aria-label="Legenda do trecho"></textarea>${s.voz ? `<span class="voz-info${s.voz.outra ? " outra" : ""}">${s.voz.outra ? "outra voz? " : ""}${s.voz.rel > 0 ? "+" : ""}${s.voz.rel.toFixed(0)} dB</span>` : ""}</div>
      <div class="marcas" role="group" aria-label="Marcação do trecho">
        <button type="button" data-m="manter">Manter</button><button type="button" data-m="cortar">Cortar</button><button type="button" data-m="outra">Outra voz</button><button type="button" data-m="destacar">Destacar</button>
      </div>`;
    const ta = el.querySelector(".txt"); ta.value = s.texto;
    requestAnimationFrame(() => crescer(ta));
    el.querySelectorAll(".marcas button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.m === s.marca)));
    el.querySelector(".tempo").onclick = () => irParaBruto(s.t0 + 0.01);
    ta.addEventListener("input", () => { s.texto = ta.value.replace(/\s+/g, " ").trim(); s.editado = true; crescer(ta); recalcular(); salvarLocal(); desenharTela(); sincronizarLegendaAtual(true); });
    el.querySelectorAll(".marcas button").forEach((b) => b.onclick = () => {
      s.marca = b.dataset.m;
      if (st.plano && s.marca !== "manter") st.plano.cortar_segmentos = (st.plano.cortar_segmentos || []).filter((x) => x !== s.id);
      recalcular(); mostrarTrechos(); if (st.plano) mostrarPlano(); salvarLocal(); desenharTela();
    });
    box.appendChild(el);
  }
}

// ================================================================ linha do tempo
// "peças" em ordem: clipes do vídeo bruto (o gancho é um clipe repetido na frente),
// pausas congeladas e a tela final. Legendas e grafismos ficam no tempo do bruto.
let palavras = [], blocos = [], pecas = [], inicioPeca = [], durEditada = 0, intervalos = [];
const MULETAS = new Set(["ahn", "an", "hum", "hmm", "eh", "ehh", "ee", "aa", "ah"]);

const cortado = (s, cortC) => s.marca === "cortar" || (s.marca === "outra" && op("op-vozprincipal")) || (s.marca === "manter" && cortC.has(s.id));
function cortesClaude() {
  const ids = new Set(st.plano?.cortar_segmentos || []);
  const v = st.plano?.versoes?.[st.versao];
  if (v) { const manter = new Set(v); for (const s of st.segs) if (!manter.has(s.id)) ids.add(s.id); }
  return ids;
}

// palavras distribuídas só pelos momentos com voz (não caem nas pausas que serão cortadas)
function quebrarPalavras(s) {
  if (s.semLegenda) return [];
  let ps = s.texto.split(/\s+/).filter(Boolean);
  if (op("op-muletas")) ps = ps.filter((p) => !MULETAS.has(normal(p)));
  if (!ps.length) return [];
  const pesos = ps.map((p) => p.length + 2);
  const tot = pesos.reduce((a, b) => a + b, 0) || 1;
  const a0 = s.a ?? s.t0, b0 = s.b ?? s.t1;
  const A = st.audio;
  let trechos = [[a0, b0]];
  if (A) {
    const lim = limiarVoz(); trechos = []; let ini = null;
    const i0 = Math.max(0, Math.floor(a0 / A.hop)), i1 = Math.min(A.db.length, Math.ceil(b0 / A.hop));
    for (let i = i0; i <= i1; i++) {
      const voz = i < i1 && A.db[i] > lim;
      if (voz && ini === null) ini = i; else if (!voz && ini !== null) { trechos.push([ini * A.hop, i * A.hop]); ini = null; }
    }
    if (!trechos.length) trechos = [[a0, b0]];
  }
  const total = trechos.reduce((n, [x, y]) => n + y - x, 0);
  const mapear = (u) => { let r = u * total; for (const [x, y] of trechos) { if (r <= y - x) return x + r; r -= y - x; } return trechos[trechos.length - 1][1]; };
  return ps.map((p, i) => {
    const u0 = pesos.slice(0, i).reduce((x, y) => x + y, 0) / tot, u1 = u0 + pesos[i] / tot;
    const c = mapear((u0 + u1) / 2);
    let t0 = mapear(u0 + 1e-4), t1 = mapear(u1 - 1e-4);
    const r = trechos.find(([x, y]) => c >= x && c <= y);
    if (r) { t0 = clamp(t0, r[0], c); t1 = clamp(t1, c, r[1]); } // não deixa a palavra atravessar uma pausa
    return { t0, t1: Math.max(t1, t0 + 0.08), c, p, seg: s.id };
  });
}

function recalcular() {
  const removidos = [];
  const cortC = cortesClaude();
  const ativos = [];
  ajustarLimites();
  for (const s of st.segs) {
    if (cortado(s, cortC)) removidos.push([s.a ?? s.t0, s.b ?? s.t1]);
    else ativos.push(s);
  }
  if (op("op-silencio") && ativos.length) {
    // mantém só as regiões com fala dos trechos ativos; tudo fora delas (silêncio, ruído, outras vozes) sai
    const m = parseFloat($("aj-respiro").value), pmin = parseFloat($("aj-pausa").value);
    const falas = [];
    for (const s of ativos) for (const r of regioesDeFala(s.a ?? s.t0, s.b ?? s.t1, pmin)) falas.push([...r]);
    falas.sort((x, y) => x[0] - y[0]);
    const brutas = [];
    for (const f of falas) { const u = brutas[brutas.length - 1]; if (u && f[0] - u[1] < pmin) u[1] = Math.max(u[1], f[1]); else brutas.push([...f]); }
    const juntas = [];
    for (const [x, y] of brutas) { const f = [Math.max(0, x - m), Math.min(st.dur, y + m)]; const u = juntas[juntas.length - 1]; if (u && f[0] <= u[1]) u[1] = Math.max(u[1], f[1]); else juntas.push(f); }
    let t = 0;
    for (const [a, b] of juntas) { if (a - t > 0.04) removidos.push([t, a]); t = Math.max(t, b); }
    if (st.dur - t > 0.04) removidos.push([t, st.dur]);
  }
  removidos.sort((a, b) => a[0] - b[0]);
  const uniao = [];
  for (const r of removidos) { const u = uniao[uniao.length - 1]; if (u && r[0] <= u[1] + 0.02) u[1] = Math.max(u[1], r[1]); else uniao.push([...r]); }
  intervalos = []; let t = 0;
  for (const [a, b] of uniao) { if (a - t > 0.08) intervalos.push([t, a]); t = Math.max(t, b); }
  if (st.dur - t > 0.08) intervalos.push([t, st.dur]);
  if (!intervalos.length) intervalos = [[0, st.dur || 0.1]];

  // peças: gancho + clipes, com pausas congeladas inseridas
  pecas = [];
  const g = st.plano?.gancho;
  if (g && op("op-gancho") && g.t1 > g.t0) pecas.push({ tipo: "clip", a: g.t0, b: g.t1, gancho: true });
  const pausas = op("op-humor") ? [...(st.plano?.pausas || [])].sort((x, y) => x.t - y.t) : [];
  for (const [a, b] of intervalos) {
    let ini = a;
    for (const p of pausas) if (p.t > ini + 0.05 && p.t < b - 0.05) { pecas.push({ tipo: "clip", a: ini, b: p.t }); pecas.push({ tipo: "pausa", t: p.t, d: p.d, estilo: p.estilo, texto: p.texto }); ini = p.t; }
    pecas.push({ tipo: "clip", a: ini, b });
  }
  if (op("op-final") && st.plano) pecas.push({ tipo: "final", d: 2.2 });
  inicioPeca = []; durEditada = 0;
  for (const p of pecas) { inicioPeca.push(durEditada); durEditada += p.tipo === "clip" ? p.b - p.a : p.d; }

  // legendas: palavras de trechos que aparecem em algum clipe
  const emClipe = (x) => pecas.some((p) => p.tipo === "clip" && x >= p.a && x < p.b);
  palavras = [];
  const usuarioCortou = new Set(st.segs.filter((s) => s.marca === "cortar" || (s.marca === "outra" && op("op-vozprincipal"))).map((s) => s.id));
  for (const s of st.segs) if (!usuarioCortou.has(s.id)) for (const w of quebrarPalavras(s)) if (emClipe(w.c ?? (w.t0 + w.t1) / 2)) palavras.push(w);
  palavras.sort((a, b) => a.t0 - b.t0);
  blocos = [];
  let atual = [];
  palavras.forEach((w, i) => {
    atual.push(w);
    const prox = palavras[i + 1];
    const chars = atual.reduce((n, x) => n + x.p.length + 1, 0);
    if (atual.length >= (st.estilo.porBloco || 3) || chars > 6 + 5 * (st.estilo.porBloco || 3) || /[.!?…,]$/.test(w.p) || !prox || prox.t0 - w.t1 > 0.4 || prox.seg !== w.seg) { blocos.push(atual); atual = []; }
  });
  blocos.forEach((b, i) => { b.ini = b[0].t0; b.fim = Math.min(b[b.length - 1].t1 + 0.15, blocos[i + 1] ? blocos[i + 1][0].t0 : Infinity); });
  // planos de câmera: alterna por trecho
  const ordemSeg = new Map(); let k = 0;
  for (const s of [...st.segs].sort((a, b) => a.t0 - b.t0)) if (!usuarioCortou.has(s.id) && !cortC.has(s.id)) ordemSeg.set(s.id, k++);
  st.planoSeg = ordemSeg;
  if (eng.idx >= pecas.length) eng.idx = Math.max(0, pecas.length - 1);
  const cortadoS = st.dur - (pecas.filter((p) => p.tipo === "clip" && !p.gancho).reduce((n, p) => n + p.b - p.a, 0));
  $("aj-resumo").textContent = st.segs.length ? `Do bruto de ${fmt(st.dur)}, saem ${cortadoS.toFixed(1)} s (silêncios, ruídos, outras vozes e cortes marcados).` : "";
  atualizarTempo();
}

function posicaoEditada(e) {
  e = clamp(e, 0, Math.max(0, durEditada - 0.001));
  for (let i = pecas.length - 1; i >= 0; i--) if (e >= inicioPeca[i]) return { idx: i, off: e - inicioPeca[i] };
  return { idx: 0, off: 0 };
}
function segEm(t) { return st.segs.find((s) => t >= s.t0 && t < s.t1); }

// ================================================================ motor de reprodução
const eng = { idx: 0, u: 0, wall0: 0, rodando: false, ultimoT: 0, ocupado: false };
const congelado = document.createElement("canvas");
let mascara = null, mascaraCongelada = null;

function saltar(t) {
  return new Promise((ok) => {
    if (Math.abs(video.currentTime - t) < 0.01 && video.readyState >= 2) return ok();
    const fim = () => { video.removeEventListener("seeked", fim); ok(); };
    video.addEventListener("seeked", fim); video.currentTime = t;
  });
}

function congelar() {
  congelado.width = st.vw; congelado.height = st.vh;
  congelado.getContext("2d").drawImage(video, 0, 0);
  mascaraCongelada = null;
  if (precisaRecorte()) segmentar(congelado).then((m) => { mascaraCongelada = m; });
}

async function entrarPeca(i, off = 0) {
  eng.idx = i; eng.u = off;
  const p = pecas[i]; if (!p) return;
  if (p.tipo === "clip") await saltar(p.a + off);
  else if (p.tipo === "pausa") { await saltar(p.t); congelar(); }
  else { const ult = [...pecas].reverse().find((x) => x.tipo === "clip"); await saltar(Math.max(0, (ult?.b || st.dur) - 0.05)); congelar(); }
}

async function irPara(e) {
  if (st.exportando) return;
  pararReproducao();
  const { idx, off } = posicaoEditada(e);
  await entrarPeca(idx, off);
  await atualizarMascara();
  desenharTela(); atualizarTempo();
}
async function irParaBruto(t) {
  const i = pecas.findIndex((p) => p.tipo === "clip" && !p.gancho && t >= p.a && t < p.b);
  if (i < 0) { pararReproducao(); await saltar(t); desenharTela(); return; }
  await irPara(inicioPeca[i] + (t - pecas[i].a));
}

async function reproduzir() {
  if (!st.arquivo || !pecas.length) return;
  prepararAudio(); await ac.resume();
  monitorGain.gain.value = st.exportando && !op("op-ouvir") ? 0 : 1;
  const e = tempoEditado();
  if (e >= durEditada - 0.05) await entrarPeca(0, 0);
  else await entrarPeca(eng.idx, eng.u);
  eng.ultimoT = video.currentTime;
  if (st.musicaUrl) { musica.currentTime = tempoEditado() % (musica.duration || 1e9); musica.play().catch(() => {}); }
  eng.rodando = true; $("btn-play").textContent = "❚❚ Pausar";
  if (pecas[eng.idx].tipo === "clip") await video.play();
  else eng.wall0 = performance.now() - eng.u * 1000;
  requestAnimationFrame(passo);
}

function pararReproducao() {
  eng.rodando = false; video.pause(); musica.pause();
  $("btn-play").textContent = "▶ Reproduzir";
}

function tempoEditado() {
  const p = pecas[eng.idx]; if (!p) return 0;
  return inicioPeca[eng.idx] + (p.tipo === "clip" ? clamp(video.currentTime - p.a, 0, p.b - p.a) : eng.u);
}

async function avancar() {
  const ant = pecas[eng.idx];
  eng.idx++;
  if (eng.idx >= pecas.length) { terminar(); return; }
  const p = pecas[eng.idx];
  eng.u = 0;
  if (p.tipo === "clip") {
    const continuo = Math.abs(video.currentTime - p.a) < 0.08;
    if (!continuo || video.paused) {
      if (!continuo) {
        if (gravador?.state === "recording") gravador.pause();
        video.pause(); musica.pause();
        await saltar(p.a);
        if (st.musicaUrl && eng.rodando) musica.play().catch(() => {});
      }
      if (!eng.rodando) return;
      if (ant?.gancho) flashAte = performance.now() + 110;
      await video.play();
      if (gravador?.state === "paused") gravador.resume();
    }
    eng.ultimoT = video.currentTime;
  } else {
    video.pause();
    congelar();
    eng.wall0 = performance.now();
    if (p.tipo === "pausa") tocarSom(p.estilo === "grilo" ? "grilo" : p.estilo === "interrogacao" ? "ding" : "boom");
    else tocarSom("whoosh");
  }
}

let flashAte = 0;
async function passo() {
  if (!eng.rodando) return;
  if (eng.ocupado) { requestAnimationFrame(passo); return; }
  eng.ocupado = true;
  try {
    const p = pecas[eng.idx];
    if (p.tipo === "clip") {
      const t = video.currentTime;
      if (t >= p.b - 0.02 || video.ended) { await avancar(); }
      else {
        if (t > eng.ultimoT && t - eng.ultimoT < 0.5) dispararSons(eng.ultimoT, t);
        eng.ultimoT = t;
      }
    } else {
      eng.u = (performance.now() - eng.wall0) / 1000;
      if (eng.u >= p.d) await avancar();
    }
    if (!eng.rodando) return;
    const pa = pecas[eng.idx];
    if (gateGain) gateGain.gain.setTargetAtTime(alvoGate(pa), ac.currentTime, 0.025);
    if (musGain) {
      const falando = pa?.tipo === "clip" && falandoEm(video.currentTime);
      musGain.gain.setTargetAtTime(volMusica() * (falando ? 0.32 : 1), ac.currentTime, 0.12);
    }
    await atualizarMascara();
    desenharTela();
    if (exportCtx) desenharQuadro(exportCtx, exportCanvas.width, exportCanvas.height);
    atualizarTempo();
    if (st.exportando) $("exp-barra").style.width = `${Math.round(100 * tempoEditado() / durEditada)}%`;
  } finally { eng.ocupado = false; }
  if (eng.rodando) requestAnimationFrame(passo);
}

function terminar() {
  pararReproducao();
  eng.idx = pecas.length - 1; eng.u = pecas[eng.idx]?.d || 0;
  if (aoTerminar) { const f = aoTerminar; aoTerminar = null; f(); }
}

let arrastando = false;
function atualizarTempo() {
  const e = tempoEditado();
  $("tempo").textContent = `${fmt(e)} / ${fmt(durEditada)}`;
  if (!arrastando) $("scrub").value = durEditada ? Math.round(1000 * e / durEditada) : 0;
  const p = pecas[eng.idx];
  const id = p?.tipo === "clip" ? segEm(video.currentTime)?.id : null;
  document.querySelectorAll(".trecho").forEach((el) => el.classList.toggle("atual", +el.dataset.id === id));
  sincronizarLegendaAtual();
}
$("btn-play").onclick = () => { if (st.exportando) return; eng.rodando ? pararReproducao() : reproduzir(); };
$("scrub").addEventListener("input", (ev) => { if (st.exportando) return; arrastando = true; irPara(durEditada * ev.target.value / 1000); });
$("scrub").addEventListener("change", () => { arrastando = false; });

// ================================================================ recorte da pessoa (MediaPipe)
let segmentador = null, segCarregando = null, segResolver = null;
function precisaRecorte() { return op("op-atras") && (st.plano?.grafismos || []).some((g) => g.camada === "atras"); }
function carregarSegmentador() {
  if (segCarregando) return segCarregando;
  segCarregando = new Promise((ok, falha) => {
    const s = document.createElement("script"); s.src = "mp/selfie_segmentation.js";
    s.onload = async () => {
      try {
        const seg = new window.SelfieSegmentation({ locateFile: (f) => "mp/" + (f.endsWith(".js") ? f : f + ".wasm") });
        seg.setOptions({ modelSelection: 0, selfieMode: false });
        seg.onResults((r) => { if (segResolver) { const f = segResolver; segResolver = null; f(r.segmentationMask); } });
        await seg.initialize();
        segmentador = seg; ok(seg);
      } catch (e) { falha(e); }
    };
    s.onerror = () => falha(new Error("não carregou o recorte"));
    document.head.appendChild(s);
  });
  return segCarregando;
}
async function segmentar(imagem) {
  try {
    await carregarSegmentador();
    const r = new Promise((ok) => { segResolver = ok; });
    await segmentador.send({ image: imagem });
    const m = await r;
    return await createImageBitmap(m);
  } catch { return null; }
}
async function atualizarMascara() {
  const p = pecas[eng.idx];
  if (!precisaRecorte() || p?.tipo !== "clip") { mascara = null; return; }
  const t = video.currentTime;
  const ativo = (st.plano.grafismos || []).some((g) => g.camada === "atras" && t >= g.t0 - 0.2 && t <= g.t1);
  if (!ativo) { mascara = null; return; }
  const m = await segmentar(video);
  if (mascara?.close) mascara.close();
  mascara = m;
}

// ================================================================ desenho de um quadro
const temp = document.createElement("canvas"), tempCtx = temp.getContext("2d");

function zoomEm(t, peca) {
  let z = 1;
  if (op("op-camera") && peca?.tipo === "clip") {
    if (peca.gancho) z = 1.2;
    else { const s = segEm(t); const k = s ? st.planoSeg?.get(s.id) : undefined; if (k !== undefined && k % 2 === 1) z = 1.18; }
  }
  for (const zz of st.plano?.zooms || []) {
    if (t >= zz.t0 && t <= zz.t1) {
      const ent = clamp((t - zz.t0) / 0.08, 0, 1), sai = clamp((zz.t1 - t) / 0.15, 0, 1);
      z *= 1 + (zz.intensidade - 1) * easeOut(Math.min(ent, sai));
    }
  }
  return z;
}

function efeitosEm(t) {
  const r = { tremor: 0, pb: false, vinheta: 0 };
  if (!op("op-humor")) return r;
  for (const e of st.plano?.efeitos || []) if (t >= e.t0 && t <= e.t1) {
    if (e.tipo === "tremor") r.tremor = 1; else if (e.tipo === "pb") r.pb = true; else if (e.tipo === "vinheta") r.vinheta = 1;
  }
  return r;
}

function geometria(W, H, z, fy = 0.42) {
  const esc = Math.max(W / st.vw, H / st.vh) * z;
  const dw = st.vw * esc, dh = st.vh * esc;
  return { dx: clamp((W - dw) / 2, W - dw, 0), dy: clamp(H * 0.46 - dh * fy, H - dh, 0), dw, dh };
}

function desenharQuadro(ctx, W, H) {
  const p = pecas[eng.idx];
  ctx.save();
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
  if (!st.vw || !p) { ctx.restore(); return; }
  const t = video.currentTime;
  if (p.tipo === "final") { desenharFinal(ctx, W, H); ctx.restore(); return; }

  let z, fonte = video, ef = { tremor: 0, pb: false, vinheta: 0 }, msk = mascara;
  if (p.tipo === "pausa") {
    const k = clamp(eng.u / p.d, 0, 1);
    z = zoomEm(t, null) * (1 + 0.28 * easeOut(k));
    fonte = congelado; msk = mascaraCongelada;
    ef = { tremor: p.estilo === "dramatico" ? 0.4 : 0, pb: p.estilo === "dramatico" || p.estilo === "grilo", vinheta: 1 };
  } else { z = zoomEm(t, p); ef = efeitosEm(t); }

  const g = geometria(W, H, z);
  const tr = ef.tremor ? (Math.random() - 0.5) * W * 0.02 * ef.tremor : 0, tr2 = ef.tremor ? (Math.random() - 0.5) * W * 0.02 * ef.tremor : 0;
  const filtro = [filtroLuz(), ef.pb ? "grayscale(1) contrast(1.15)" : ""].filter((x) => x && x !== "none").join(" ") || "none";
  ctx.filter = filtro;
  ctx.drawImage(fonte, g.dx + tr, g.dy + tr2, g.dw, g.dh);
  ctx.filter = "none";

  // grafismos atrás da pessoa
  const grafs = p.tipo === "clip" ? (st.plano?.grafismos || []).filter((x) => t >= x.t0 && t <= x.t1) : [];
  const atras = op("op-atras") && msk ? grafs.filter((x) => x.camada === "atras") : [];
  for (const x of atras) desenharGrafismo(ctx, W, H, x, t);
  if (atras.length) {
    temp.width = W; temp.height = H;
    tempCtx.clearRect(0, 0, W, H);
    tempCtx.drawImage(msk, g.dx + tr, g.dy + tr2, g.dw, g.dh);
    tempCtx.globalCompositeOperation = "source-in";
    tempCtx.filter = filtro;
    tempCtx.drawImage(fonte, g.dx + tr, g.dy + tr2, g.dw, g.dh);
    tempCtx.filter = "none"; tempCtx.globalCompositeOperation = "source-over";
    ctx.drawImage(temp, 0, 0);
  }
  if (ef.vinheta) {
    const rg = ctx.createRadialGradient(W / 2, H * 0.45, W * 0.3, W / 2, H * 0.45, H * 0.75);
    rg.addColorStop(0, "rgba(0,0,0,0)"); rg.addColorStop(1, `rgba(0,0,0,${0.75 * ef.vinheta})`);
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  }
  for (const x of grafs) if (!atras.includes(x)) desenharGrafismo(ctx, W, H, x, t);

  if (p.tipo === "clip") {
    desenharLegenda(ctx, W, H, t);
    if (p.gancho && st.plano?.gancho?.texto) desenharGancho(ctx, W, H, st.plano.gancho.texto, t - p.a);
  } else if (p.texto) {
    desenharTextoPausa(ctx, W, H, p.texto, eng.u);
  }
  if (performance.now() < flashAte) { ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.fillRect(0, 0, W, H); }
  desenharLogo(ctx, W, H);
  if (op("op-barra")) {
    const f = durEditada ? tempoEditado() / durEditada : 0;
    ctx.fillStyle = "rgba(255,255,255,.25)"; ctx.fillRect(0, 0, W, H * 0.006);
    ctx.fillStyle = st.estilo.destaque; ctx.fillRect(0, 0, W * f, H * 0.006);
  }
  ctx.restore();
}

function fonteLegenda(px) {
  const f = st.estilo.fonte;
  if (f === "Montserrat") return `900 ${px}px Montserrat, sans-serif`;
  return `${px}px ${f}, Impact, sans-serif`;
}

function desenharLegenda(ctx, W, H, t) {
  const b = blocos.find((x) => t >= x.ini && t < x.fim);
  if (!b) return;
  const chaves = new Set((st.plano?.palavras_chave || []).map(normal));
  let tam = Math.round(W * (st.estilo.fonte === "Montserrat" ? 0.074 : 0.088));
  const txt = (w) => st.estilo.caixa ? w.p.toUpperCase() : w.p;
  ctx.font = fonteLegenda(tam);
  let esp = ctx.measureText(" ").width, larg = b.map((w) => ctx.measureText(txt(w)).width);
  let total = larg.reduce((a, c) => a + c, 0) + esp * (b.length - 1);
  if (total > W * 0.86) { tam = Math.floor(tam * W * 0.86 / total); ctx.font = fonteLegenda(tam); esp = ctx.measureText(" ").width; larg = b.map((w) => ctx.measureText(txt(w)).width); total = larg.reduce((a, c) => a + c, 0) + esp * (b.length - 1); }
  const y = H * st.estilo.posicao;
  const entrada = easeOutBack(clamp((t - b.ini) / 0.12, 0, 1));
  let x = W / 2 - total / 2;
  ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.lineJoin = "round";
  let emoji = null;
  b.forEach((w, i) => {
    const falando = t >= w.t0 && t < (b[i + 1] ? b[i + 1].t0 : b.fim);
    const chave = chaves.has(normal(w.p));
    if (falando && op("op-emoji")) { const e = (st.plano?.emojis || []).find((e) => normal(e.palavra) === normal(w.p)); if (e) emoji = { e: e.emoji, x: x + larg[i] / 2, t0: w.t0 }; }
    const pop = falando ? 1 + 0.12 * (1 - clamp((t - w.t0) / 0.12, 0, 1)) + 0.04 : 1;
    const s = (0.85 + 0.15 * entrada) * pop;
    ctx.save();
    ctx.translate(x + larg[i] / 2, y); ctx.scale(s, s);
    ctx.lineWidth = tam * 0.17; ctx.strokeStyle = "#000";
    ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = tam * 0.18; ctx.shadowOffsetY = tam * 0.06;
    ctx.strokeText(txt(w), -larg[i] / 2, 0);
    ctx.shadowColor = "transparent";
    ctx.fillStyle = falando || chave ? st.estilo.destaque : "#FFFFFF";
    ctx.fillText(txt(w), -larg[i] / 2, 0);
    ctx.restore();
    x += larg[i] + esp;
  });
  if (emoji) {
    const k = easeOutBack(clamp((t - emoji.t0) / 0.18, 0, 1));
    ctx.save(); ctx.textAlign = "center";
    ctx.translate(clamp(emoji.x, W * 0.15, W * 0.85), y - tam * 1.15); ctx.scale(k, k); ctx.rotate(Math.sin(t * 8) * 0.08);
    ctx.font = `${Math.round(tam * 1.05)}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    ctx.fillText(emoji.e, 0, 0);
    ctx.restore();
  }
}

function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

function quebrarLinhas(ctx, texto, max) {
  const ps = texto.split(/\s+/); const linhas = []; let l = "";
  for (const p of ps) { const n = l ? l + " " + p : p; if (ctx.measureText(n).width > max && l) { linhas.push(l); l = p; } else l = n; }
  if (l) linhas.push(l);
  return linhas;
}

function desenharGancho(ctx, W, H, texto, u) {
  const k = easeOutBack(clamp(u / 0.25, 0, 1));
  const tam = W * 0.085;
  ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
  ctx.font = `${tam}px Anton, Impact, sans-serif`;
  const linhas = quebrarLinhas(ctx, texto.toUpperCase(), W * 0.8);
  ctx.translate(W / 2, H * 0.2); ctx.scale(k, k); ctx.rotate(-0.03);
  linhas.forEach((l, i) => {
    const y = (i - (linhas.length - 1) / 2) * tam * 1.12;
    const tw = ctx.measureText(l).width + tam * 0.6;
    ctx.fillStyle = i % 2 ? "#fff" : st.estilo.destaque;
    rrect(ctx, -tw / 2, y - tam * 0.62, tw, tam * 1.24, tam * 0.16); ctx.fill();
    ctx.fillStyle = "#111"; ctx.fillText(l, 0, y + tam * 0.03);
  });
  ctx.restore();
}

function desenharTextoPausa(ctx, W, H, texto, u) {
  const k = easeOutBack(clamp(u / 0.2, 0, 1));
  const tam = W * 0.12;
  ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
  ctx.translate(W / 2, H * 0.32); ctx.scale(k, k);
  ctx.font = `${tam}px Anton, Impact, sans-serif`;
  ctx.lineWidth = tam * 0.14; ctx.strokeStyle = "#000"; ctx.strokeText(texto.toUpperCase(), 0, 0);
  ctx.fillStyle = "#fff"; ctx.fillText(texto.toUpperCase(), 0, 0);
  ctx.restore();
}

function desenharGrafismo(ctx, W, H, g, t) {
  const u = t - g.t0, resta = g.t1 - t;
  ctx.save(); ctx.globalAlpha = clamp(resta / 0.15, 0, 1);
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
  const y = H * (g.posicao === "meio" ? 0.42 : 0.2);
  const texto = String(g.texto || "");
  if (g.estilo === "numero") {
    const tam = W * (g.camada === "atras" ? 0.3 : 0.2), s = easeOutBack(clamp(u / 0.22, 0, 1));
    ctx.translate(W / 2, g.camada === "atras" ? H * 0.28 : y); ctx.scale(s, s); ctx.rotate(-0.04);
    ctx.font = `${tam}px Anton, Impact, sans-serif`;
    ctx.lineWidth = tam * 0.1; ctx.strokeStyle = "#000"; ctx.strokeText(texto.toUpperCase(), 0, 0);
    ctx.fillStyle = st.estilo.destaque; ctx.fillText(texto.toUpperCase(), 0, 0);
  } else if (g.estilo === "emoji") {
    const tam = W * 0.2, s = easeOutBack(clamp(u / 0.2, 0, 1));
    ctx.translate(W * 0.5, y); ctx.scale(s, s); ctx.rotate(Math.sin(u * 9) * 0.12);
    ctx.font = `${tam}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    ctx.fillText(texto, 0, 0);
  } else if (g.estilo === "alerta") {
    const tam = W * 0.068;
    ctx.font = `${tam}px Anton, Impact, sans-serif`;
    const tw = ctx.measureText(texto.toUpperCase()).width + tam * 1.2;
    const tremor = u < 0.35 ? Math.sin(u * 80) * W * 0.008 * (1 - u / 0.35) : 0;
    ctx.translate(W / 2 + tremor, y); ctx.scale(1, easeOut(clamp(u / 0.12, 0, 1))); ctx.rotate(0.02);
    ctx.fillStyle = "#E5322D"; rrect(ctx, -tw / 2, -tam * 0.85, tw, tam * 1.7, tam * 0.25); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.fillText(texto.toUpperCase(), 0, tam * 0.04);
  } else if (g.camada === "atras") { // título grande atrás da pessoa
    const tam = W * 0.2;
    ctx.font = `${tam}px Anton, Impact, sans-serif`;
    const linhas = quebrarLinhas(ctx, texto.toUpperCase(), W * 0.95);
    const p = easeOut(clamp(u / 0.3, 0, 1));
    ctx.translate(W / 2, H * 0.24 + (1 - p) * H * 0.05);
    linhas.forEach((l, i) => {
      const yy = (i - (linhas.length - 1) / 2) * tam * 0.98;
      ctx.fillStyle = i % 2 ? "#fff" : st.estilo.destaque; ctx.fillText(l, 0, yy, W * 0.96);
    });
  } else { // cartela
    const tam = W * 0.064;
    ctx.font = `${tam}px Anton, Impact, sans-serif`;
    const tw = Math.min(W * 0.9, ctx.measureText(texto.toUpperCase()).width + tam * 1.1);
    const lado = g.entrada === "direita" ? 1 : -1;
    const p = easeOutBack(clamp(u / 0.28, 0, 1));
    ctx.translate(W / 2 + lado * (1 - p) * W, y); ctx.rotate(-0.035);
    ctx.fillStyle = "rgba(0,0,0,.35)"; rrect(ctx, -tw / 2 + tam * 0.12, -tam * 0.66, tw, tam * 1.6, tam * 0.22); ctx.fill();
    ctx.fillStyle = st.estilo.destaque; rrect(ctx, -tw / 2, -tam * 0.8, tw, tam * 1.6, tam * 0.22); ctx.fill();
    ctx.fillStyle = "#111"; ctx.fillText(texto.toUpperCase(), 0, tam * 0.04, tw - tam * 0.6);
  }
  ctx.restore();
}

function logoAtual() { return st.logoId ? imgsLogo.get(st.logoId) : null; }
function desenharLogo(ctx, W, H, forcar) {
  const img = logoAtual();
  if (!img || !img.complete || !img.naturalWidth) return;
  if (pecas[eng.idx]?.tipo === "final" && !forcar) return;
  const w = W * 0.17, h = w * img.naturalHeight / img.naturalWidth;
  const m = W * 0.045, pos = $("logo-pos").value;
  const x = pos.endsWith("d") ? W - m - w : m;
  const y = pos.startsWith("s") ? m + H * 0.012 : H - m - h - H * 0.06;
  ctx.save(); ctx.globalAlpha = parseFloat($("logo-opac").value);
  ctx.drawImage(img, x, y, w, h); ctx.restore();
}

function desenharFinal(ctx, W, H) {
  const u = eng.u;
  const g = geometria(W, H, 1.1);
  ctx.filter = "blur(26px) brightness(0.45)";
  ctx.drawImage(congelado, g.dx, g.dy, g.dw, g.dh);
  ctx.filter = "none";
  const k = easeOutBack(clamp(u / 0.35, 0, 1));
  ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const img = logoAtual();
  let y = H * 0.4;
  if (img?.naturalWidth) {
    const w = W * 0.36, h = w * img.naturalHeight / img.naturalWidth;
    ctx.save(); ctx.translate(W / 2, H * 0.32); ctx.scale(k, k); ctx.drawImage(img, -w / 2, -h / 2, w, h); ctx.restore();
    y = H * 0.32 + h / 2 + H * 0.07;
  }
  const arroba = $("final-arroba").value.trim(), chamada = $("final-chamada").value.trim();
  ctx.globalAlpha = clamp(u / 0.3, 0, 1);
  if (arroba) { ctx.font = `${W * 0.085}px Anton, Impact, sans-serif`; ctx.fillStyle = "#fff"; ctx.fillText(arroba, W / 2, y); y += W * 0.11; }
  if (chamada) {
    ctx.font = `${W * 0.06}px Anton, Impact, sans-serif`;
    const tw = ctx.measureText(chamada.toUpperCase()).width + W * 0.08;
    const s = 1 + 0.04 * Math.sin(u * 6);
    ctx.translate(W / 2, y + W * 0.02); ctx.scale(s, s);
    ctx.fillStyle = st.estilo.destaque; rrect(ctx, -tw / 2, -W * 0.055, tw, W * 0.11, W * 0.03); ctx.fill();
    ctx.fillStyle = "#111"; ctx.fillText(chamada.toUpperCase(), 0, W * 0.004);
  }
  ctx.restore();
}

function desenharTela() { desenharQuadro(ctxTela, tela.width, tela.height); }

// ================================================================ áudio
let ac = null, saidaGravacao = null, monitorGain = null, musGain = null, sfxGain = null, gateGain = null, filtroAlto = null, filtroBaixo = null;
function prepararAudio() {
  if (ac) return;
  ac = new AudioContext();
  const master = ac.createGain();
  monitorGain = ac.createGain(); monitorGain.connect(ac.destination);
  saidaGravacao = ac.createMediaStreamDestination();
  master.connect(monitorGain); master.connect(saidaGravacao);
  const voz = ac.createMediaElementSource(video);
  const comp = ac.createDynamicsCompressor(); comp.threshold.value = -22; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.12;
  const passaAlta = ac.createBiquadFilter(); passaAlta.type = "highpass"; passaAlta.frequency.value = 80;
  const ganhoVoz = ac.createGain(); ganhoVoz.gain.value = 1.25;
  filtroAlto = passaAlta;
  filtroBaixo = ac.createBiquadFilter(); filtroBaixo.type = "lowpass"; filtroBaixo.frequency.value = 20000;
  gateGain = ac.createGain(); gateGain.gain.value = 1;
  voz.connect(passaAlta).connect(filtroBaixo).connect(gateGain).connect(comp).connect(ganhoVoz).connect(master);
  ajustarFiltros();
  const mus = ac.createMediaElementSource(musica);
  musGain = ac.createGain(); musGain.gain.value = 0; mus.connect(musGain).connect(master);
  sfxGain = ac.createGain(); sfxGain.gain.value = 0.55; sfxGain.connect(master);
  decodificarBiblioteca();
}

let ruido = null;
function bufRuido() { if (ruido) return ruido; ruido = ac.createBuffer(1, ac.sampleRate, ac.sampleRate); const d = ruido.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return ruido; }
function tocarSom(nome) {
  if (!ac || !op("op-sfx")) return;
  const t = ac.currentTime;
  const buf = buffersSom.get(normal(nome));
  if (buf) { const s = ac.createBufferSource(); s.buffer = buf; s.connect(sfxGain); s.start(t); return; }
  if (nome === "whoosh") {
    const n = ac.createBufferSource(); n.buffer = bufRuido();
    const f = ac.createBiquadFilter(); f.type = "bandpass"; f.Q.value = 1.2;
    f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(3500, t + 0.22);
    const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.7, t + 0.1); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    n.connect(f).connect(g).connect(sfxGain); n.start(t); n.stop(t + 0.32);
  } else if (nome === "ding") {
    for (const [fr, v] of [[1320, 0.35], [1980, 0.15]]) {
      const o = ac.createOscillator(); o.frequency.value = fr;
      const g = ac.createGain(); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.connect(g).connect(sfxGain); o.start(t); o.stop(t + 0.72);
    }
  } else if (nome === "boom") {
    const o = ac.createOscillator(); o.type = "sine";
    o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.9);
    const sh = ac.createWaveShaper(); const cur = new Float32Array(256); for (let i = 0; i < 256; i++) { const x = i / 128 - 1; cur[i] = Math.tanh(3 * x); } sh.curve = cur;
    const g = ac.createGain(); g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    o.connect(sh).connect(g).connect(sfxGain); o.start(t); o.stop(t + 1.25);
  } else if (nome === "grilo") {
    for (let k = 0; k < 6; k++) {
      const t0 = t + 0.15 + k * 0.32 + (k % 2) * 0.06;
      for (let j = 0; j < 3; j++) {
        const o = ac.createOscillator(); o.frequency.value = 4400;
        const g = ac.createGain(); const tj = t0 + j * 0.045;
        g.gain.setValueAtTime(0.0001, tj); g.gain.exponentialRampToValueAtTime(0.12, tj + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, tj + 0.035);
        o.connect(g).connect(sfxGain); o.start(tj); o.stop(tj + 0.04);
      }
    }
  } else { // pop
    const o = ac.createOscillator();
    o.frequency.setValueAtTime(700, t); o.frequency.exponentialRampToValueAtTime(180, t + 0.09);
    const g = ac.createGain(); g.gain.setValueAtTime(0.6, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(sfxGain); o.start(t); o.stop(t + 0.13);
  }
}
function dispararSons(de, ate) {
  if (!op("op-sfx")) return;
  const cruzou = (x) => x > de && x <= ate;
  const sons = st.plano?.sons || [];
  for (const g of st.plano?.grafismos || []) if (cruzou(g.t0) && !sons.some((s) => Math.abs(s.t - g.t0) < 0.3)) tocarSom(g.estilo === "alerta" ? "whoosh" : g.estilo === "numero" ? "ding" : "pop");
  for (const z of st.plano?.zooms || []) if (cruzou(z.t0) && !sons.some((s) => Math.abs(s.t - z.t0) < 0.3)) tocarSom("whoosh");
  for (const s of sons) if (cruzou(s.t)) tocarSom(s.nome);
}
const volMusica = () => st.musicaUrl ? parseFloat($("vol-musica").value) : 0;
const falandoEm = (t) => palavras.some((w) => t >= w.t0 - 0.15 && t <= w.t1 + 0.25);

// ================================================================ 3. direção
function desenharChips() {
  const box = $("chips-tom"); box.innerHTML = "";
  for (const t of TONS) {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.textContent = t;
    b.setAttribute("aria-pressed", String(st.tons.has(t)));
    b.onclick = () => { st.tons.has(t) ? st.tons.delete(t) : st.tons.add(t); b.setAttribute("aria-pressed", String(st.tons.has(t))); salvarLocal(); };
    box.appendChild(b);
  }
}
["tom-livre", "quero", "nao-quero", "final-arroba", "final-chamada"].forEach((id) => $(id).addEventListener("input", () => { salvarLocal(); desenharTela(); }));
for (const id of OPCOES) $(id).addEventListener("change", () => { recalcular(); salvarLocal(); if (!eng.rodando) irPara(Math.min(tempoEditado(), durEditada)); });
["logo-pos", "logo-opac"].forEach((id) => $(id).addEventListener("input", () => { desenharTela(); salvarLocal(); }));
$("btn-musica").onclick = () => $("arq-musica").click();
$("arq-musica").addEventListener("change", (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  if (st.musicaUrl) URL.revokeObjectURL(st.musicaUrl);
  st.musicaUrl = URL.createObjectURL(f); musica.src = st.musicaUrl;
  $("nome-musica").textContent = f.name; $("tirar-musica").hidden = false; $("vol-musica-box").hidden = false;
});
$("tirar-musica").onclick = () => { musica.pause(); musica.removeAttribute("src"); st.musicaUrl = null; $("nome-musica").textContent = "Sem trilha (abaixa sozinha quando você fala)"; $("tirar-musica").hidden = true; $("vol-musica-box").hidden = true; $("arq-musica").value = ""; };

// ---------------------------------------------------------------- ditado por voz
let alvoDitado = null, ditadoBase = "";
function prepararDitado() {
  const icone = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12h-2Z"/></svg>';
  document.querySelectorAll(".mic").forEach((b) => {
    b.innerHTML = icone; b.hidden = false;
    b.onclick = () => {
      if (alvoDitado === b.dataset.alvo) { ditado.stop().catch(() => {}); return; }
      if (alvoDitado) ditado.stop().catch(() => {});
      alvoDitado = b.dataset.alvo; ditadoBase = $(alvoDitado).value;
      ditado.start().catch((e) => { if (e?.code === "not_granted") document.querySelectorAll(".mic").forEach((m) => m.hidden = true); alvoDitado = null; marcarMic(); });
      marcarMic();
    };
  });
  const juntar = (a, b) => (a && !/\s$/.test(a) ? a + " " : a) + b;
  ditado.onPartial(({ text }) => { if (alvoDitado) $(alvoDitado).value = juntar(ditadoBase, text); });
  ditado.onFinal(({ text }) => { if (alvoDitado) { ditadoBase = juntar(ditadoBase, text); $(alvoDitado).value = ditadoBase; salvarLocal(); } });
  ditado.onState(({ state }) => { if (state === "idle") { alvoDitado = null; marcarMic(); } });
}
function marcarMic() { document.querySelectorAll(".mic").forEach((b) => b.classList.toggle("ouvindo", b.dataset.alvo === alvoDitado)); }

// ---------------------------------------------------------------- biblioteca (db): sons, logos, presets
function assinarBiblioteca() {
  const erro = () => {};
  db.collection("sons").onSnapshot((s) => { st.sons = s.docs.map((d) => ({ id: d.id, ...d.data() })); desenharSons(); decodificarBiblioteca(); }, erro);
  db.collection("logos").onSnapshot((s) => { st.logos = s.docs.map((d) => ({ id: d.id, ...d.data() })); carregarImgsLogo(); desenharLogos(); }, erro);
  db.collection("presets").onSnapshot((s) => { presetsDb = s.docs.map((d) => ({ id: d.id, ...d.data() })); juntarPresets(); }, erro);
}
function desenharSons() {
  const box = $("lista-sons"); box.innerHTML = "";
  for (const n of SONS_EMBUTIDOS) {
    const el = document.createElement("span"); el.className = "lib-item"; el.innerHTML = `${n}<button type="button" aria-label="Ouvir ${n}">▶</button>`;
    el.querySelector("button").onclick = () => { prepararAudio(); ac.resume(); tocarSom(n); };
    box.appendChild(el);
  }
  for (const s of st.sons) {
    const el = document.createElement("span"); el.className = "lib-item";
    el.innerHTML = `${escapar(s.nome)}<button type="button" aria-label="Ouvir">▶</button><button type="button" aria-label="Apagar ${escapar(s.nome)}">✕</button>`;
    const [ouvir, apagar] = el.querySelectorAll("button");
    ouvir.onclick = async () => { prepararAudio(); await ac.resume(); await decodificarBiblioteca(); tocarSom(s.nome); };
    apagar.onclick = async () => { if (apagar.dataset.ok) { await db.doc("sons/" + s.id).delete().catch(() => {}); } else { apagar.dataset.ok = 1; apagar.textContent = "apagar?"; setTimeout(() => { delete apagar.dataset.ok; apagar.textContent = "✕"; }, 2500); } };
    box.appendChild(el);
  }
}
async function decodificarBiblioteca() {
  if (!ac) return;
  for (const s of st.sons) {
    const k = normal(s.nome);
    if (buffersSom.has(k)) continue;
    try { const buf = await blobDeB64(s.b64, s.mime).arrayBuffer(); buffersSom.set(k, await ac.decodeAudioData(buf)); } catch {}
  }
}
$("btn-som").onclick = () => $("arq-som").click();
$("arq-som").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; ev.target.value = ""; if (!f || !db) return;
  const nome = f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 30) || "som";
  $("msg-som").textContent = "Preparando…";
  try {
    let blob = f, mime = f.type || "audio/mpeg";
    if (f.size > 180000) { const r = await reduzirSom(f); blob = r.blob; mime = r.mime; }
    if (blob.size > 180000) { $("msg-som").textContent = "Esse som é longo demais. Use um trecho de até uns 10 s."; return; }
    await db.collection("sons").doc(idNovo()).set({ nome, mime, b64: await b64DeBlob(blob) });
    $("msg-som").textContent = `"${nome}" adicionado.`;
  } catch (e) { $("msg-som").textContent = "Não consegui salvar o som (" + (e?.code || e?.message || e) + ")."; }
});
// sons grandes: regrava em Opus (mono, 64 kb/s), no máximo 10 s
async function reduzirSom(f) {
  const ctx = new AudioContext();
  try {
    const dec = await ctx.decodeAudioData(await f.arrayBuffer());
    const d = Math.min(dec.duration, 10);
    const src = ctx.createBufferSource(); src.buffer = dec;
    const dest = ctx.createMediaStreamDestination(); dest.channelCount = 1; src.connect(dest);
    const mime = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 64000 });
    const partes = []; rec.ondataavailable = (e) => partes.push(e.data);
    const fim = new Promise((ok) => rec.onstop = ok);
    rec.start(); src.start(); await espera(d * 1000 + 150); rec.stop(); src.stop(); await fim;
    return { blob: new Blob(partes, { type: mime.split(";")[0] }), mime: mime.split(";")[0] };
  } finally { ctx.close(); }
}

function carregarImgsLogo() {
  for (const l of st.logos) if (!imgsLogo.has(l.id)) { const img = new Image(); img.onload = () => desenharTela(); img.src = `data:${l.mime || "image/webp"};base64,${l.b64}`; imgsLogo.set(l.id, img); }
}
function desenharLogos() {
  const box = $("lista-logos"); box.innerHTML = "";
  for (const l of st.logos) {
    const el = document.createElement("span"); el.className = "lib-item" + (l.id === st.logoId ? " sel-logo" : "");
    el.innerHTML = `<img alt=""><button type="button">${escapar(l.nome)}</button><button type="button" aria-label="Apagar logo">✕</button>`;
    el.querySelector("img").src = `data:${l.mime || "image/webp"};base64,${l.b64}`;
    const [usar, apagar] = el.querySelectorAll("button");
    usar.onclick = () => { st.logoId = st.logoId === l.id ? "" : l.id; desenharLogos(); desenharTela(); salvarLocal(); };
    apagar.onclick = async () => { if (apagar.dataset.ok) { if (st.logoId === l.id) st.logoId = ""; await db.doc("logos/" + l.id).delete().catch(() => {}); } else { apagar.dataset.ok = 1; apagar.textContent = "apagar?"; setTimeout(() => { delete apagar.dataset.ok; apagar.textContent = "✕"; }, 2500); } };
    box.appendChild(el);
  }
  if (!st.logos.length) box.innerHTML = '<span class="dica">Nenhum logo ainda.</span>';
}
$("btn-logo").onclick = () => $("arq-logo").click();
$("arq-logo").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; ev.target.value = ""; if (!f || !db) return;
  $("msg-logo").textContent = "Preparando…";
  try {
    const img = new Image(); img.src = URL.createObjectURL(f); await img.decode();
    const esc = Math.min(1, 600 / Math.max(img.naturalWidth || 600, img.naturalHeight || 600));
    const c = document.createElement("canvas"); c.width = Math.round((img.naturalWidth || 600) * esc); c.height = Math.round((img.naturalHeight || 600) * esc);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((ok) => c.toBlob(ok, "image/webp", 0.9));
    const id = idNovo();
    await db.collection("logos").doc(id).set({ nome: f.name.replace(/\.[^.]+$/, "").slice(0, 30), mime: "image/webp", b64: await b64DeBlob(blob) });
    st.logoId = id; salvarLocal();
    $("msg-logo").textContent = "Clique num logo para usar ou tirar a marca d'água.";
  } catch (e) { $("msg-logo").textContent = "Não consegui salvar o logo (" + (e?.code || e?.message || e) + ")."; }
});

const CHAVE_PRESETS = "estudio-edicao:presets";
let presetsDb = [], presetsLocais = [];
function carregarPresetsLocais() {
  try { presetsLocais = JSON.parse(localStorage.getItem(CHAVE_PRESETS) || "[]"); } catch { presetsLocais = []; }
  juntarPresets();
}
function juntarPresets() {
  const nomes = new Set(presetsDb.map((p) => p.nome.toLowerCase()));
  st.presets = [...presetsDb, ...presetsLocais.filter((p) => !nomes.has(p.nome.toLowerCase())).map((p) => ({ ...p, local: true }))];
  desenharPresets();
}
function salvarPresetsLocais() { try { localStorage.setItem(CHAVE_PRESETS, JSON.stringify(presetsLocais)); return true; } catch { return false; } }
function desenharPresets() {
  const sel = $("sel-preset"), atual = sel.value;
  sel.innerHTML = '<option value="">Nenhum (direção solta)</option>' + st.presets.map((p) => `<option value="${escapar(p.id)}">${escapar(p.nome)}</option>`).join("");
  if (st.presets.some((p) => p.id === atual)) sel.value = atual;
  $("btn-apagar-preset").hidden = !sel.value;
}
$("sel-preset").onchange = () => {
  const p = st.presets.find((x) => x.id === $("sel-preset").value);
  $("btn-apagar-preset").hidden = !p;
  if (!p) return;
  aplicarDirecao(p.direcao); recalcular(); salvarLocal(); carregarFontes().then(desenharTela);
  $("est-direcao").textContent = "Preset: " + p.nome;
};
$("btn-salvar-preset").onclick = () => { $("novo-preset").hidden = false; $("nome-preset").value = st.presets.find((x) => x.id === $("sel-preset").value)?.nome || ""; $("novo-preset").scrollIntoView({ block: "nearest" }); $("nome-preset").focus(); };
$("nome-preset").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("btn-confirmar-preset").click(); } });
$("btn-cancelar-preset").onclick = () => { $("novo-preset").hidden = true; };
$("btn-confirmar-preset").onclick = async () => {
  const nome = $("nome-preset").value.trim(); if (!nome) { $("nome-preset").focus(); return; }
  const existente = st.presets.find((x) => x.nome.toLowerCase() === nome.toLowerCase());
  const id = existente?.id || idNovo();
  const dados = { nome, direcao: lerDirecao() };
  let ondeSalvou = "";
  if (db && !existente?.local) {
    try { await db.collection("presets").doc(id).set(dados); ondeSalvou = "na sua conta"; }
    catch (e) { console.warn("preset no db falhou", e); }
  }
  if (!ondeSalvou) {
    presetsLocais = presetsLocais.filter((p) => p.id !== id && p.nome.toLowerCase() !== nome.toLowerCase());
    presetsLocais.push({ id, ...dados });
    if (salvarPresetsLocais()) { ondeSalvou = "neste computador"; juntarPresets(); }
  }
  if (ondeSalvou) { $("novo-preset").hidden = true; $("sel-preset").value = id; $("btn-apagar-preset").hidden = false; $("est-direcao").textContent = `Preset "${nome}" salvo ${ondeSalvou}`; }
  else $("est-direcao").textContent = "Não consegui salvar o preset: o navegador bloqueou o armazenamento.";
};
$("btn-apagar-preset").onclick = async () => {
  const b = $("btn-apagar-preset"), id = $("sel-preset").value; if (!id) return;
  if (!b.dataset.ok) { b.dataset.ok = 1; b.textContent = "Apagar mesmo?"; setTimeout(() => { delete b.dataset.ok; b.textContent = "Apagar"; }, 2500); return; }
  const p = st.presets.find((x) => x.id === id);
  if (p?.local) { presetsLocais = presetsLocais.filter((x) => x.id !== id); salvarPresetsLocais(); juntarPresets(); }
  else if (db) await db.doc("presets/" + id).delete().catch(() => {});
  $("sel-preset").value = ""; b.hidden = true; delete b.dataset.ok; b.textContent = "Apagar";
};

// ---------------------------------------------------------------- estilo da legenda
function sincronizarEstiloUI() {
  $("leg-bloco").value = String(st.estilo.porBloco || 3);
  $("leg-fonte").value = st.estilo.fonte; $("leg-pos").value = st.estilo.posicao; $("leg-caixa").checked = st.estilo.caixa;
  const box = $("leg-cores"); box.innerHTML = "";
  for (const c of CORES) {
    const b = document.createElement("button"); b.type = "button"; b.className = "cor"; b.style.setProperty("--c", c);
    b.setAttribute("aria-label", "Destaque " + c); b.setAttribute("aria-pressed", String(c.toLowerCase() === st.estilo.destaque.toLowerCase()));
    b.onclick = () => { st.estilo.destaque = c; sincronizarEstiloUI(); desenharTela(); salvarLocal(); };
    box.appendChild(b);
  }
}
$("leg-fonte").onchange = async (e) => { st.estilo.fonte = e.target.value; await carregarFontes(); desenharTela(); salvarLocal(); };
$("leg-pos").oninput = (e) => { st.estilo.posicao = parseFloat(e.target.value); desenharTela(); salvarLocal(); };
$("leg-caixa").onchange = (e) => { st.estilo.caixa = e.target.checked; desenharTela(); salvarLocal(); };
async function carregarFontes() { try { await Promise.all(["80px Anton", "80px Bangers", "900 80px Montserrat"].map((f) => document.fonts.load(f))); } catch {} }

// ================================================================ 4. edição com o Claude
function atualizarBotoes() {
  const pronto = st.segs.length > 0;
  const btn = $("btn-editar");
  btn.disabled = !pronto || !sample || st.exportando;
  btn.textContent = st.plano ? "Refazer a edição do zero" : "Começar a edição com o Claude";
  $("dica-editar").textContent = !sample ? "A conexão com o Claude não está disponível nesta visualização. Abra o Estúdio no app do Claude."
    : !pronto ? "Envie o vídeo e espere a transcrição para começar."
    : "O Claude lê a fala, suas marcações e a direção, e monta gancho, cortes, legendas, grafismos, zooms, efeitos, versões curtas, capa e o texto do post.";
  $("btn-exportar").disabled = !st.arquivo || !pronto || st.exportando;
  $("btn-capa-atual").disabled = !st.arquivo || st.exportando;
  $("btn-capa-claude").disabled = !st.plano?.capa || st.exportando;
  if (typeof atualizarAnaliseUI === "function") atualizarAnaliseUI();
}

async function quadrosParaClaude() {
  if (!sampleImagens) return [];
  const c = document.createElement("canvas"); c.width = 288; c.height = 512;
  const cx = c.getContext("2d"); const blobs = [];
  const volta = video.currentTime;
  for (const f of [0.15, 0.5, 0.85]) {
    const [a, b] = intervalos[Math.min(intervalos.length - 1, Math.floor(f * intervalos.length))];
    await saltar(a + (b - a) / 2);
    const g = geometria(c.width, c.height, 1);
    cx.drawImage(video, g.dx, g.dy, g.dw, g.dh);
    blobs.push(await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.75)));
  }
  await saltar(volta);
  return blobs.filter(Boolean);
}

function montarPedido(ajuste) {
  const trechos = st.segs.map((s) => `[${s.id}] ${s.t0.toFixed(2)}–${s.t1.toFixed(2)}s (${s.marca === "outra" ? "OUTRA VOZ" : s.marca.toUpperCase()}${infoVoz(s)}) ${s.texto}`).join("\n");
  const sons = [...SONS_EMBUTIDOS, ...st.sons.map((s) => s.nome)];
  const ativo = (id) => op(id) ? "SIM" : "NÃO";
  let txt = `Você é editor de vídeos verticais curtos (TikTok, Reels, Shorts) para um criador brasileiro. Edite o vídeo abaixo, gravado no celular, com a pessoa falando para a câmera.

DURAÇÃO DO BRUTO: ${st.dur.toFixed(1)} s

TRANSCRIÇÃO AUTOMÁTICA (pode ter erros), com id, tempo no bruto, marcação do criador e texto:
${trechos}

Marcações do criador (são ordens):
- CORTAR: já saiu; não traga de volta.
- DESTACAR: precisa ganhar grafismo, zoom ou efeito nesse trecho.
- OUTRA VOZ: fala de outra pessoa ou ruído; já saiu.
- MANTER: fala da pessoa principal. SEJA CONSERVADOR: só sugira cortar (cortar_segmentos) uma repetição literal da mesma frase, uma tomada claramente errada/abandonada ou um trecho sem nenhum conteúdo. Na dúvida, NÃO corte: cortar fala boa da pessoa principal é o pior erro possível.
- O nível em dB é relativo à voz principal: trechos bem mais baixos (−8 dB ou menos) ou de outro timbre costumam ser outra pessoa fora da câmera ou ruído. Se o texto também indicar outra pessoa (resposta de alguém de fora, "tá gravando?", conversa paralela), liste o id em "outras_vozes".

${st.analise ? `ANÁLISE PRÉVIA DO VÍDEO\nTema: ${st.analise.tema}\nPúblico: ${st.analise.publico}\nTom percebido: ${st.analise.tom}\nEstrutura: ${(st.analise.estrutura || []).map((p) => `${p.parte} (${fmt(p.t0)}–${fmt(p.t1)}): ${p.resumo}`).join(" | ")}\nCuidados: ${(st.analise.atencao || []).join("; ") || "—"}\n` : ""}
DIREÇÃO DO CRIADOR
Tom: ${[...st.tons].join(", ") || "não informado"}
Sobre o humor: ${$("tom-livre").value.trim() || "—"}
Quero: ${$("quero").value.trim() || "—"}
Não quero: ${$("nao-quero").value.trim() || "—"}

RECURSOS LIGADOS: gancho na abertura ${ativo("op-gancho")}; efeitos de humor ${ativo("op-humor")}; limpar muletas ${ativo("op-muletas")}; efeitos sonoros ${ativo("op-sfx")}; emoji na legenda ${ativo("op-emoji")}; grafismos atrás da pessoa ${ativo("op-atras")}. Os cortes de câmera (plano aberto/fechado) são automáticos.
SONS DISPONÍVEIS (use só estes nomes): ${sons.join(", ")}
${sampleImagens ? "\nAs imagens anexadas são quadros do vídeo (início, meio e fim), para você ver o cenário e a pessoa." : ""}

REGRAS DE EDIÇÃO
- Ritmo de vídeo curto: algo novo na tela a cada 2–4 s, sem poluir. Nunca dois grafismos ao mesmo tempo.
- Tudo alinhado ao momento exato da fala (use os tempos dos trechos) e só em trechos que ficam no vídeo.
- Gancho: o trecho mais forte ou curioso do vídeo (de preferência do meio ou fim), 1,5 a 3,5 s, que funcione sozinho na abertura; "texto" é uma frase curta na tela que gera curiosidade (até 6 palavras). Se o recurso estiver desligado, devolva null.
- Grafismos: "cartela" (até 4 palavras numa faixa), "numero" (número ou valor grande), "emoji" (um único emoji), "alerta" (faixa vermelha com tremor), duração 0,8–2,5 s. "camada": "atras" faz o grafismo passar atrás da pessoa (bom para títulos grandes de 1–3 palavras e números); use só se o recurso estiver ligado, no máximo 2 vezes.
- Zoom (punch-in) em reações, piadas e ênfases: intensidade 1.12–1.35, duração 0,5–2 s.
- Pausas (só com efeitos de humor ligados): congelam a imagem logo depois de uma piada ou virada. "estilo": "dramatico" (P&B, tremor, boom), "grilo" (silêncio constrangedor com grilos), "interrogacao". Duração 0,8–1,8 s; "texto" opcional curtíssimo (ex.: "...", "?"). No máximo 2 por vídeo.
- Efeitos: "tremor", "pb" (preto e branco) ou "vinheta", de 0,4 a 2 s, para reforçar a piada.
- Sons: momentos para tocar um som da lista (os grafismos e zooms já têm som automático; aqui vão os extras, como risada ou vine boom). No máximo 1 a cada 5 s.
- Emojis: até 6 pares palavra→emoji para aparecer sobre a legenda quando a palavra é dita (só se ligado).
- Para humor: o efeito reforça a piada no tempo certo, nunca explica a piada.
- Correções: conserte erros óbvios da transcrição e pontuação, sem mudar o que a pessoa disse${op("op-muletas") ? "; tire muletas como \"né\", \"tipo\", \"ahn\", \"então\" de enrolação" : ""}. Só envie trechos que mudaram.
- Versões curtas: escolha os ids dos trechos para uma versão de até 30 s e outra de até 15 s, que façam sentido sozinhas (gancho e conclusão). Se o vídeo já for mais curto que isso, repita todos os ids mantidos.
- Capa: o melhor momento para a foto de capa (expressão forte) e um título de até 5 palavras.
- Legenda do post no tom do vídeo, com gancho na primeira linha; 3 a 6 hashtags em português; comentário fixado que puxe respostas.

Responda SOMENTE com JSON válido, neste formato:
{
  "titulo": "título curto do vídeo",
  "resumo": "1 ou 2 frases explicando a linha da edição",
  "gancho": {"t0": 21.4, "t1": 23.8, "texto": "ninguém te conta isso"},
  "correcoes": [{"id": 3, "texto": "texto corrigido do trecho"}],
  "cortar_segmentos": [9],
  "outras_vozes": [5],
  "motivo_cortes": "por que esses cortes",
  "palavras_chave": ["palavra"],
  "emojis": [{"palavra": "dinheiro", "emoji": "💸"}],
  "grafismos": [{"t0": 2.1, "t1": 3.6, "texto": "3 ERROS", "estilo": "cartela", "posicao": "topo", "entrada": "esquerda", "camada": "frente"}],
  "zooms": [{"t0": 7.2, "t1": 8.4, "intensidade": 1.25}],
  "pausas": [{"t": 12.3, "d": 1.2, "estilo": "grilo", "texto": "..."}],
  "efeitos": [{"t0": 9.0, "t1": 9.8, "tipo": "tremor"}],
  "sons": [{"t": 15.2, "nome": "boom"}],
  "versoes": {"30": [1, 2, 4], "15": [2, 4]},
  "capa": {"t": 8.1, "titulo": "o erro que todo mundo comete"},
  "estilo_legenda": {"fonte": "Anton|Bangers|Montserrat", "destaque": "#FFD400"},
  "post": {"legenda": "texto", "hashtags": ["#exemplo"], "comentario_fixado": "comentário"},
  "sugestao_trilha": "clima de trilha que combina"
}
"posicao" é "topo" ou "meio" (a legenda fica embaixo). "entrada" é "esquerda" ou "direita". Tempos em segundos do bruto.`;
  if (ajuste && st.plano) txt += `\n\nEDIÇÃO ATUAL (refaça aplicando o pedido do criador e mantendo o que não foi pedido para mudar):\n${JSON.stringify(planoParaClaude())}\n\nPEDIDO DE AJUSTE: ${ajuste}`;
  return txt;
}

function planoParaClaude() {
  const p = st.plano; if (!p) return null;
  const { titulo, gancho, cortar_segmentos, palavras_chave, emojis, grafismos, zooms, pausas, efeitos, sons, versoes, capa } = p;
  return { titulo, gancho, cortar_segmentos, palavras_chave, emojis, grafismos, zooms, pausas, efeitos, sons, versoes, capa, estilo_legenda: { fonte: st.estilo.fonte, destaque: st.estilo.destaque }, post: lerPost() };
}

function validarPlano(p) {
  const num = (v, d) => (typeof v === "number" && isFinite(v) ? v : (typeof v === "string" && isFinite(+v) && v !== "" ? +v : d));
  const ids = new Set(st.segs.map((s) => s.id));
  const sons = new Set([...SONS_EMBUTIDOS, ...st.sons.map((s) => s.nome)].map(normal));
  const out = {
    titulo: String(p.titulo || "video").slice(0, 80),
    resumo: String(p.resumo || ""),
    motivo_cortes: String(p.motivo_cortes || ""),
    cortar_segmentos: (p.cortar_segmentos || []).map(Number).filter((id) => ids.has(id) && st.segs.find((s) => s.id === id).marca === "manter"),
    palavras_chave: (p.palavras_chave || []).map(String).slice(0, 12),
    emojis: (p.emojis || []).filter((e) => e && e.palavra && e.emoji).slice(0, 8).map((e) => ({ palavra: String(e.palavra), emoji: String(e.emoji).slice(0, 8) })),
    grafismos: [], zooms: [], pausas: [], efeitos: [], sons: [],
    sugestao_trilha: String(p.sugestao_trilha || ""),
    gancho: null, versoes: {}, capa: null,
  };
  if (p.gancho && typeof p.gancho === "object") {
    const t0 = clamp(num(p.gancho.t0, 0), 0, st.dur), t1 = clamp(num(p.gancho.t1, t0 + 2.5), t0 + 1, Math.min(st.dur, t0 + 4));
    out.gancho = { t0, t1, texto: String(p.gancho.texto || "").slice(0, 60) };
  }
  for (const g of p.grafismos || []) {
    const t0 = clamp(num(g.t0, 0), 0, st.dur), t1 = clamp(num(g.t1, t0 + 1.5), t0 + 0.4, Math.min(st.dur, t0 + 4));
    if (!g.texto) continue;
    out.grafismos.push({ t0, t1, texto: String(g.texto).slice(0, 40), estilo: ["cartela", "numero", "emoji", "alerta"].includes(g.estilo) ? g.estilo : "cartela", posicao: g.posicao === "meio" ? "meio" : "topo", entrada: g.entrada === "direita" ? "direita" : "esquerda", camada: g.camada === "atras" ? "atras" : "frente" });
  }
  for (const z of p.zooms || []) { const t0 = clamp(num(z.t0, 0), 0, st.dur); out.zooms.push({ t0, t1: clamp(num(z.t1, t0 + 1), t0 + 0.3, Math.min(st.dur, t0 + 3)), intensidade: clamp(num(z.intensidade, 1.2), 1.05, 1.5) }); }
  for (const x of p.pausas || []) out.pausas.push({ t: clamp(num(x.t, 0), 0, st.dur), d: clamp(num(x.d, 1.2), 0.5, 2.5), estilo: ["dramatico", "grilo", "interrogacao"].includes(x.estilo) ? x.estilo : "dramatico", texto: String(x.texto || "").slice(0, 12) });
  out.pausas = out.pausas.slice(0, 3);
  for (const e of p.efeitos || []) { const t0 = clamp(num(e.t0, 0), 0, st.dur); if (["tremor", "pb", "vinheta"].includes(e.tipo)) out.efeitos.push({ t0, t1: clamp(num(e.t1, t0 + 0.8), t0 + 0.2, Math.min(st.dur, t0 + 3)), tipo: e.tipo }); }
  for (const s of p.sons || []) if (s && sons.has(normal(s.nome))) out.sons.push({ t: clamp(num(s.t, 0), 0, st.dur), nome: String(s.nome) });
  for (const k of ["30", "15"]) { const v = (p.versoes?.[k] || []).map(Number).filter((id) => ids.has(id)); if (v.length) out.versoes[k] = v; }
  if (p.capa) out.capa = { t: clamp(num(p.capa.t, st.dur / 2), 0, st.dur), titulo: String(p.capa.titulo || "").slice(0, 60) };
  for (const k of ["grafismos", "zooms", "efeitos"]) out[k].sort((a, b) => a.t0 - b.t0);
  out.sons.sort((a, b) => a.t - b.t); out.pausas.sort((a, b) => a.t - b.t);
  return out;
}

async function editarComClaude(ajuste) {
  if (!sample) return;
  [$("btn-editar"), $("btn-ajustar")].forEach((b) => b.disabled = true);
  mostrar($("erro-claude"), "");
  $("est-claude").textContent = "O Claude está editando…";
  marcarEtapa("et-direcao", "feita"); marcarEtapa("et-claude", "ativa");
  pararReproducao();
  try {
    recalcular();
    const imagens = await quadrosParaClaude();
    const opts = { modelTier: "complex" };
    if (imagens.length) opts.images = imagens;
    const p = await pedirJSON(montarPedido(ajuste), imagens);
    let corrigidos = 0;
    for (const c of p.correcoes || []) { const s = st.segs.find((x) => x.id === Number(c.id)); if (s && !s.editado && c.texto && String(c.texto).trim() !== s.texto) { s.texto = String(c.texto).trim(); corrigidos++; } }
    for (const id of p.outras_vozes || []) { const s = st.segs.find((x) => x.id === Number(id)); if (s && s.marca === "manter") s.marca = "outra"; }
    st.plano = validarPlano(p);
    st.plano.corrigidos = corrigidos;
    const est = p.estilo_legenda || {};
    if (["Anton", "Bangers", "Montserrat"].includes(est.fonte)) st.estilo.fonte = est.fonte;
    if (/^#[0-9a-f]{6}$/i.test(est.destaque || "")) st.estilo.destaque = est.destaque.toUpperCase();
    sincronizarEstiloUI(); await carregarFontes();
    const post = p.post || {};
    $("post-legenda").value = post.legenda || ""; $("post-hashtags").value = (post.hashtags || []).join(" "); $("post-comentario").value = post.comentario_fixado || "";
    st.plano.post = lerPost();
    if (st.plano.capa) $("capa-titulo").value = st.plano.capa.titulo;
    if (ajuste) $("ajuste").value = "";
    if (!st.plano.versoes[st.versao]) st.versao = "completa";
    recalcular(); mostrarTrechos(); mostrarPlano(); salvarLocal();
    if (precisaRecorte()) carregarSegmentador().catch(() => {});
    await irPara(0);
    $("est-claude").textContent = "Pronto para revisar";
    marcarEtapa("et-claude", "feita"); marcarEtapa("et-exportar", "ativa");
  } catch (e) {
    const cod = e?.code;
    mostrar($("erro-claude"), cod === "not_granted" ? "Sem permissão para chamar o Claude por esta página."
      : cod === "rate_limited" ? "Muitos pedidos seguidos. Espere um minuto e tente de novo."
      : "Não consegui montar a edição: " + (e?.message || e));
    $("est-claude").textContent = "";
  } finally { atualizarBotoes(); $("btn-ajustar").disabled = false; }
}
$("btn-editar").onclick = () => editarComClaude(null);
$("btn-ajustar").onclick = () => { const a = $("ajuste").value.trim(); if (!a) { $("ajuste").focus(); return; } editarComClaude(a); };

function lerPost() { return { legenda: $("post-legenda").value.trim(), hashtags: $("post-hashtags").value.split(/\s+/).filter(Boolean), comentario_fixado: $("post-comentario").value.trim() }; }
["post-legenda", "post-hashtags", "post-comentario"].forEach((id) => $(id).addEventListener("input", () => { if (st.plano) { st.plano.post = lerPost(); salvarLocal(); } }));

function desenharVersoes() {
  const box = $("versoes"); box.innerHTML = "";
  const opcoes = [["completa", "Completa"], ...["30", "15"].filter((k) => st.plano?.versoes?.[k]).map((k) => [k, `Até ${k} s`])];
  for (const [k, nome] of opcoes) {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.textContent = nome;
    b.setAttribute("aria-pressed", String(st.versao === k));
    b.onclick = async () => { st.versao = k; recalcular(); mostrarTrechos(); mostrarPlano(); salvarLocal(); await irPara(0); };
    box.appendChild(b);
  }
}

function mostrarPlano() {
  const p = st.plano; if (!p) return;
  $("plano-box").hidden = false;
  if (p.post && !$("post-legenda").value) { $("post-legenda").value = p.post.legenda || ""; $("post-hashtags").value = (p.post.hashtags || []).join(" "); $("post-comentario").value = p.post.comentario_fixado || ""; }
  if (p.capa && !$("capa-titulo").value) $("capa-titulo").value = p.capa.titulo;
  const nC = p.cortar_segmentos.length;
  $("resumo-plano").innerHTML = `<b>${escapar(p.titulo)}</b><br>${escapar(p.resumo)}<br><span class="dica">${p.grafismos.length} grafismos · ${p.zooms.length} zooms · ${p.pausas.length} pausas · ${p.efeitos.length + p.sons.length} efeitos e sons · ${nC} trechos cortados${p.corrigidos ? ` · ${p.corrigidos} legendas corrigidas` : ""} · vídeo final com ${fmt(durEditada)}</span>`;
  $("btn-restaurar-cortes").hidden = !p.cortar_segmentos.length;
  $("sugestao-trilha").textContent = p.sugestao_trilha ? "Trilha sugerida: " + p.sugestao_trilha : "";
  desenharVersoes();
  const box = $("plano-lista"); box.innerHTML = "";
  const itens = [];
  if (p.gancho) itens.push({ tipo: "gancho", t: -1 });
  p.grafismos.forEach((g, i) => itens.push({ tipo: "grafismo", t: g.t0, i }));
  p.zooms.forEach((z, i) => itens.push({ tipo: "zoom", t: z.t0, i }));
  p.pausas.forEach((x, i) => itens.push({ tipo: "pausa", t: x.t, i }));
  p.efeitos.forEach((x, i) => itens.push({ tipo: "efeito", t: x.t0, i }));
  p.sons.forEach((x, i) => itens.push({ tipo: "som", t: x.t, i }));
  p.cortar_segmentos.forEach((id) => itens.push({ tipo: "corte", t: st.segs.find((s) => s.id === id)?.t0 || 0, id }));
  itens.sort((a, b) => a.t - b.t);
  const botoes = (ver) => `<div class="linha-botoes">${ver ? '<button class="btn mini" type="button" data-a="ver">Ver</button>' : ""}<button class="btn mini" type="button" data-a="tirar">Tirar</button></div>`;
  const quando = (t) => fmtD(Math.max(0, tempoDoBruto(t)));
  for (const it of itens) {
    const el = document.createElement("div"); el.className = "item-plano";
    let ver = null, tirar = null;
    if (it.tipo === "gancho") {
      el.innerHTML = `<span class="tipo gancho">gancho</span><div><input type="text" aria-label="Texto do gancho"><div class="t">${fmtD(p.gancho.t0)}–${fmtD(p.gancho.t1)} do bruto, na abertura</div></div>${botoes(true)}`;
      const inp = el.querySelector("input"); inp.value = p.gancho.texto; inp.oninput = () => { p.gancho.texto = inp.value; desenharTela(); salvarLocal(); };
      ver = () => irPara(0.3); tirar = () => { p.gancho = null; };
    } else if (it.tipo === "grafismo") {
      const g = p.grafismos[it.i];
      el.innerHTML = `<span class="tipo grafismo">${escapar(g.estilo)}${g.camada === "atras" ? " ⇣" : ""}</span><div><input type="text" aria-label="Texto do grafismo"><div class="t">${quando(g.t0)} · ${(g.t1 - g.t0).toFixed(1)} s${g.camada === "atras" ? " · atrás de você" : ""}</div></div>${botoes(true)}`;
      const inp = el.querySelector("input"); inp.value = g.texto; inp.oninput = () => { g.texto = inp.value; desenharTela(); salvarLocal(); };
      ver = () => irParaBruto(g.t0 + 0.4); tirar = () => p.grafismos.splice(it.i, 1);
    } else if (it.tipo === "zoom") {
      const z = p.zooms[it.i];
      el.innerHTML = `<span class="tipo zoom">zoom</span><div>${Math.round((z.intensidade - 1) * 100)}% mais perto<div class="t">${quando(z.t0)} · ${(z.t1 - z.t0).toFixed(1)} s</div></div>${botoes(true)}`;
      ver = () => irParaBruto(z.t0 + 0.2); tirar = () => p.zooms.splice(it.i, 1);
    } else if (it.tipo === "pausa") {
      const x = p.pausas[it.i];
      const nomes = { dramatico: "pausa dramática", grilo: "silêncio com grilo", interrogacao: "pausa com interrogação" };
      el.innerHTML = `<span class="tipo pausa">pausa</span><div>${nomes[x.estilo]}${x.texto ? ` "${escapar(x.texto)}"` : ""}<div class="t">${quando(x.t)} · ${x.d.toFixed(1)} s congelado</div></div>${botoes(true)}`;
      ver = () => irParaBruto(Math.max(0, x.t - 1)); tirar = () => p.pausas.splice(it.i, 1);
    } else if (it.tipo === "efeito") {
      const x = p.efeitos[it.i];
      const nomes = { tremor: "tremor", pb: "preto e branco", vinheta: "vinheta escura" };
      el.innerHTML = `<span class="tipo efeito">efeito</span><div>${nomes[x.tipo]}<div class="t">${quando(x.t0)} · ${(x.t1 - x.t0).toFixed(1)} s</div></div>${botoes(true)}`;
      ver = () => irParaBruto(x.t0 + 0.1); tirar = () => p.efeitos.splice(it.i, 1);
    } else if (it.tipo === "som") {
      const x = p.sons[it.i];
      el.innerHTML = `<span class="tipo som">som</span><div>${escapar(x.nome)}<div class="t">${quando(x.t)}</div></div>${botoes(true)}`;
      ver = () => irParaBruto(Math.max(0, x.t - 0.6)); tirar = () => p.sons.splice(it.i, 1);
    } else {
      const s = st.segs.find((x) => x.id === it.id);
      el.innerHTML = `<span class="tipo corte">corte</span><div>${escapar(s?.texto || "")}<div class="t">${escapar(p.motivo_cortes || "")}</div></div><div class="linha-botoes"><button class="btn mini" type="button" data-a="tirar">Manter</button></div>`;
      tirar = () => { p.cortar_segmentos = p.cortar_segmentos.filter((x) => x !== it.id); };
    }
    el.querySelector('[data-a="ver"]')?.addEventListener("click", ver);
    el.querySelector('[data-a="tirar"]').addEventListener("click", async () => { tirar(); recalcular(); mostrarTrechos(); mostrarPlano(); salvarLocal(); if (!eng.rodando) await irPara(Math.min(tempoEditado(), durEditada)); });
    box.appendChild(el);
  }
  if (!itens.length) box.innerHTML = '<p class="dica">Sem grafismos, zooms ou cortes nesta edição.</p>';
}
function tempoDoBruto(t) { const i = pecas.findIndex((p) => p.tipo === "clip" && !p.gancho && t >= p.a && t < p.b); return i < 0 ? -1 : inicioPeca[i] + t - pecas[i].a; }

// ================================================================ 5. exportação
let gravador = null, pedacos = [], exportCtx = null, exportCanvas = null, aoTerminar = null;
function tipoGravacao() {
  const op = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1.4d002a,mp4a.40.2", "video/mp4;codecs=avc1,mp4a", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return op.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
}
const slug = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 60) || "video";
const nomeArquivo = (ext, extra = "") => slug(st.plano?.titulo || st.arquivo?.name.replace(/\.[^.]+$/, "") || "video") + (st.versao !== "completa" ? `-${st.versao}s` : "") + extra + "." + ext;

$("btn-exportar").onclick = async () => {
  if (st.exportando) return;
  const mime = tipoGravacao();
  if (!mime) { mostrar($("exp-msg"), "Este navegador não grava vídeo. Use o app do Claude no computador ou o Chrome."); return; }
  pararReproducao();
  await carregarFontes();
  if (precisaRecorte()) { mostrar($("exp-msg"), "Preparando o recorte…", "neutro"); try { await carregarSegmentador(); } catch {} }
  prepararAudio(); await ac.resume(); await decodificarBiblioteca();
  exportCanvas = document.createElement("canvas"); exportCanvas.width = 1080; exportCanvas.height = 1920;
  exportCtx = exportCanvas.getContext("2d");
  await entrarPeca(0, 0);
  desenharQuadro(exportCtx, 1080, 1920);
  const stream = exportCanvas.captureStream(30);
  saidaGravacao.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
  pedacos = [];
  gravador = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 9_000_000, audioBitsPerSecond: 192_000 });
  gravador.ondataavailable = (e) => { if (e.data.size) pedacos.push(e.data); };
  st.exportando = true; atualizarBotoes();
  $("btn-cancelar").hidden = false; $("exp-progresso").hidden = false; $("exp-acoes").hidden = true;
  mostrar($("exp-msg"), "Gravando… deixe esta janela aberta e visível.", "neutro");
  $("est-exportar").textContent = "Gravando";
  let cancelado = false;
  $("btn-cancelar").onclick = () => { cancelado = true; terminar(); };
  const fim = new Promise((ok) => { gravador.onstop = ok; });
  aoTerminar = () => { if (gravador.state !== "inactive") gravador.stop(); };
  if (st.musicaUrl) musica.currentTime = 0;
  gravador.start(1000);
  await reproduzir();
  await fim;
  st.exportando = false; exportCtx = null; exportCanvas = null; gravador = null;
  $("btn-cancelar").hidden = true; atualizarBotoes();
  if (monitorGain) monitorGain.gain.value = 1;
  if (cancelado) { $("exp-progresso").hidden = true; mostrar($("exp-msg"), "Exportação cancelada.", "neutro"); $("est-exportar").textContent = ""; return; }
  const real = mime.toLowerCase();
  const ext = real.includes("mp4") ? "mp4" : "webm";
  st.videoBlob = new Blob(pedacos, { type: ext === "mp4" ? "video/mp4" : "video/webm" });
  st.videoNome = nomeArquivo(ext);
  $("exp-barra").style.width = "100%";
  mostrar($("exp-msg"), `Pronto: ${st.videoNome} (${(st.videoBlob.size / 1048576).toFixed(1)} MB, ${fmt(durEditada)}).${ext === "webm" ? " Saiu em WebM porque este navegador não grava MP4 com H.264; o TikTok e o Instagram aceitam, mas se precisar de MP4 converta antes." : ""}`, "ok");
  $("exp-acoes").hidden = false;
  $("est-exportar").textContent = "Pronto";
  marcarEtapa("et-exportar", "feita");
  if (!downloads) { $("btn-baixar").disabled = true; $("btn-baixar-txt").disabled = true; mostrar($("exp-msg"), "O vídeo ficou pronto, mas esta visualização não permite baixar arquivos. Abra o Estúdio no app do Claude."); }
};

function textoPost() {
  const p = lerPost();
  return [p.legenda, p.hashtags.join(" "), p.comentario_fixado ? "\nComentário fixado:\n" + p.comentario_fixado : ""].filter(Boolean).join("\n\n").trim() + "\n";
}
async function baixar(nome, dados) {
  if (!downloads) return;
  try { await downloads.save({ filename: nome, data: dados }); }
  catch (e) { if (e?.code !== "declined") mostrar($("exp-msg"), "Não consegui salvar o arquivo (" + (e?.code || e) + ")."); }
}
$("btn-baixar").onclick = () => st.videoBlob && baixar(st.videoNome, st.videoBlob);
$("btn-baixar-txt").onclick = () => baixar(nomeArquivo("txt", "-post"), textoPost());
$("btn-copiar").onclick = async () => {
  try { await navigator.clipboard.writeText(textoPost()); $("btn-copiar").textContent = "Copiado"; setTimeout(() => $("btn-copiar").textContent = "Copiar legenda do post", 1500); }
  catch { $("btn-copiar").textContent = "Não deu para copiar"; }
};

// ---------------------------------------------------------------- capa
async function gerarCapa(t) {
  pararReproducao();
  await carregarFontes();
  if (t !== undefined) await saltar(t);
  const W = 1080, H = 1920;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const g = geometria(W, H, 1.12);
  ctx.filter = filtroLuz(); ctx.drawImage(video, g.dx, g.dy, g.dw, g.dh); ctx.filter = "none";
  const grad = ctx.createLinearGradient(0, H * 0.45, 0, H); grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0,.75)");
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  const titulo = ($("capa-titulo").value || st.plano?.capa?.titulo || st.plano?.titulo || "").toUpperCase();
  if (titulo) {
    const tam = W * 0.12;
    ctx.font = `${tam}px Anton, Impact, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
    const linhas = quebrarLinhas(ctx, titulo, W * 0.86);
    const y0 = H * 0.66 - (linhas.length - 1) * tam * 0.55;
    linhas.forEach((l, i) => {
      const y = y0 + i * tam * 1.1;
      ctx.lineWidth = tam * 0.16; ctx.strokeStyle = "#000"; ctx.strokeText(l, W / 2, y);
      ctx.fillStyle = i === linhas.length - 1 ? st.estilo.destaque : "#fff"; ctx.fillText(l, W / 2, y);
    });
  }
  const idx = eng.idx; eng.idx = -1; desenharLogo(ctx, W, H, true); eng.idx = idx;
  st.capaBlob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.92));
  const img = $("capa-img"); if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(st.capaBlob); img.hidden = false;
  $("btn-capa-baixar").hidden = !downloads;
  desenharTela();
}
$("btn-capa-claude").onclick = () => st.plano?.capa && gerarCapa(st.plano.capa.t);
$("btn-capa-atual").onclick = () => gerarCapa();
$("btn-capa-baixar").onclick = () => st.capaBlob && baixar(nomeArquivo("jpg", "-capa"), st.capaBlob);

// ================================================================ início
desenharChips(); sincronizarEstiloUI(); desenharLogos(); desenharSons(); carregarFontes(); atualizarBotoes();
ctxTela.fillStyle = "#000"; ctxTela.fillRect(0, 0, tela.width, tela.height);


// ================================================================ análise do vídeo e preenchimento automático da direção
const DESC_OPCOES = {
  "op-gancho": "gancho na abertura (repete a frase mais forte no início)",
  "op-camera": "cortes de câmera (alterna plano aberto e fechado)",
  "op-humor": "efeitos de humor (pausa congelada, tremor, P&B, grilo)",
  "op-silencio": "cortar silêncios",
  "op-muletas": "limpar muletas (né, tipo, ahn)",
  "op-sfx": "efeitos sonoros",
  "op-emoji": "emoji na legenda",
  "op-barra": "barra de progresso",
  "op-atras": "grafismos atrás da pessoa (recorte, mais pesado)",
  "op-luz": "corrigir luz e cor",
  "op-final": "tela final com @ e chamada",
};

async function capturarQuadros(n) {
  if (!st.vw) return [];
  const c = document.createElement("canvas"); c.width = 288; c.height = 512;
  const cx = c.getContext("2d"); const blobs = [];
  const volta = video.currentTime;
  try {
    for (let i = 0; i < n; i++) {
      if (eng.rodando || st.exportando) break;
      await saltar(st.dur * (i + 0.5) / n);
      const g = geometria(c.width, c.height, 1);
      cx.drawImage(video, g.dx, g.dy, g.dw, g.dh);
      const b = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.72));
      if (b) blobs.push(b);
    }
  } catch {}
  if (!eng.rodando && !st.exportando) { await saltar(volta); desenharTela(); }
  return blobs;
}

function statusAnalise(texto) { $("analise-status").textContent = texto; }

async function analisarVideo() {
  if (!sample || st.analisando || !st.segs.length) { atualizarAnaliseUI(); return st.analise; }
  st.analisando = true; atualizarAnaliseUI();
  statusAnalise("O Claude está analisando o vídeo…");
  const chave = st.chave;
  try {
    let imagens = [];
    if (sampleImagens) imagens = (await (st.quadrosAnalise || capturarQuadros(6))) || [];
    const trechos = st.segs.map((s) => `[${s.id}] ${s.t0.toFixed(1)}–${s.t1.toFixed(1)}s${infoVoz(s) ? ` (${infoVoz(s).slice(2)})` : ""} ${s.texto}`).join("\n");
    const sons = [...SONS_EMBUTIDOS, ...st.sons.map((s) => s.nome)];
    const pedido = `Você é diretor de vídeos verticais curtos (TikTok, Reels, Shorts) para um criador brasileiro. Analise o vídeo bruto abaixo, gravado no celular, e prepare a direção de edição.

DURAÇÃO: ${st.dur.toFixed(1)} s
TRANSCRIÇÃO AUTOMÁTICA (pode ter erros), com id e tempo:
${trechos}
${imagens.length ? `\nAs ${imagens.length} imagens anexadas são quadros espalhados pelo vídeo inteiro, em ordem: veja cenário, enquadramento, luz, expressão e energia da pessoa.` : ""}

O QUE FAZER
1. Entenda o tema, o público provável, o tom real da fala (não o que você imagina) e a estrutura do roteiro (gancho, desenvolvimento, virada, fechamento, chamada).
2. Aponte cuidados: temas sensíveis, pessoas ou grupos que não devem virar alvo da piada, estímulos visuais a evitar, partes que não podem ser cortadas.
3. Preencha a direção do Estúdio como um editor experiente faria para ESTE vídeo:
   - "tons": de 1 a 3, só desta lista: ${TONS.join(", ")}.
   - "tom_livre": 2 ou 3 frases descrevendo o humor/clima, citando falas reais do vídeo onde a ênfase deve cair.
   - "quero": pedidos concretos ligados a momentos e palavras reais do vídeo (grafismos, zooms, efeitos, destaques).
   - "nao_quero": o que evitar, com base no tema e no tom.
   - "opcoes": verdadeiro/falso para cada recurso: ${Object.entries(DESC_OPCOES).map(([k, v]) => `${k} = ${v}`).join("; ")}. Desligue o que não combina (ex.: efeitos de humor num tema sério; recorte se a pessoa não aparece bem ou o fundo é confuso; correção de luz se já está bem iluminado).
   - "fonte": Anton (impacto), Bangers (humor/cartoon) ou Montserrat (limpo, sério/informativo).
   - "destaque": uma destas cores: ${CORES.join(", ")}.
   - "posicao": altura da legenda de 0.55 a 0.80 (evite cobrir o rosto e a parte de baixo, onde ficam os botões da rede).
   - "caixa_alta": verdadeiro/falso.
   - "chamada_final": chamada curta para a tela final (até 4 palavras), coerente com o fechamento.
   - "trilha": clima de música sugerido; "volume_trilha" de 0.08 a 0.35 (mais baixo em temas sérios).
4. "marcacoes": sugira DESTACAR para os momentos-chave (gancho, piadas, viradas, frases de efeito); CORTAR só para repetição literal ou tomada claramente errada (na dúvida, não corte fala da pessoa principal); OUTRA para fala de outra pessoa fora da câmera ou ruído (use o nível em dB relativo e o texto como pistas). Só ids da lista. Use poucos.

Sons disponíveis no Estúdio: ${sons.join(", ")}.

Responda SOMENTE com JSON válido:
{
  "tema": "assunto em uma frase",
  "publico": "para quem é",
  "tom": "como a pessoa fala de fato, em uma frase",
  "estrutura": [{"parte": "gancho", "t0": 0, "t1": 6, "resumo": "o que acontece"}],
  "pontos_fortes": ["..."],
  "atencao": ["..."],
  "direcao": {"tons": [], "tom_livre": "", "quero": "", "nao_quero": "", "opcoes": {"op-gancho": true}, "fonte": "Anton", "destaque": "#FFD400", "posicao": 0.68, "caixa_alta": true, "chamada_final": "", "trilha": "", "volume_trilha": 0.2},
  "marcacoes": [{"id": 3, "marca": "destacar|cortar|outra", "motivo": "por quê"}]
}`;
    let r = await pedirJSON(pedido, imagens);
    if (chave !== st.chave) return null; // trocou de vídeo no meio
    if (!direcaoDe(r)) throw new Error("a resposta veio sem a direção");
    st.analise = r;
    salvarLocal();
    statusAnalise("Análise pronta. Revise abaixo e use o botão para preencher a direção.");
  } catch (e) {
    statusAnalise(e?.code === "not_granted" ? "Sem permissão para chamar o Claude por esta página."
      : e?.code === "rate_limited" ? "Muitos pedidos seguidos. Espere um minuto e clique para analisar de novo."
      : "Não consegui analisar o vídeo: " + (e?.message || e));
  } finally {
    st.analisando = false; mostrarAnalise();
  }
  return st.analise;
}

function atualizarAnaliseUI() {
  const b = $("btn-autopreencher"), re = $("btn-reanalisar");
  const pronto = !!sample && st.segs.length > 0;
  b.disabled = !pronto || st.analisando || st.exportando;
  b.textContent = st.analisando ? "Analisando o vídeo…" : st.analise ? "Preencher direção automaticamente" : "Analisar e preencher a direção";
  re.hidden = !st.analise || st.analisando;
  if (!sample) statusAnalise("A análise usa o Claude: abra o Estúdio no app do Claude.");
  else if (!st.segs.length && !st.analisando) statusAnalise("A análise começa sozinha quando a transcrição terminar.");
}

function mostrarAnalise() {
  atualizarAnaliseUI();
  const box = $("analise-resumo"), a = st.analise;
  if (!a) { box.hidden = true; box.innerHTML = ""; return; }
  const lista = (xs) => (xs || []).filter(Boolean).map((x) => `<li>${escapar(x)}</li>`).join("");
  const estr = (a.estrutura || []).map((p) => `<li><button class="tempo" type="button" data-t="${Number(p.t0) || 0}">${fmt(p.t0)}</button> <b>${escapar(p.parte || "")}</b>: ${escapar(p.resumo || "")}</li>`).join("");
  box.innerHTML = `
    <p><b>Tema:</b> ${escapar(a.tema || "—")}</p>
    <p><b>Público:</b> ${escapar(a.publico || "—")}</p>
    <p><b>Tom:</b> ${escapar(a.tom || "—")}</p>
    ${estr ? `<p class="sub">Roteiro</p><ul class="lista-analise">${estr}</ul>` : ""}
    ${a.pontos_fortes?.length ? `<p class="sub">Pontos fortes</p><ul class="lista-analise">${lista(a.pontos_fortes)}</ul>` : ""}
    ${a.atencao?.length ? `<p class="sub">Cuidados</p><ul class="lista-analise">${lista(a.atencao)}</ul>` : ""}`;
  box.querySelectorAll("button[data-t]").forEach((b) => b.onclick = () => irParaBruto(parseFloat(b.dataset.t) + 0.01));
  box.hidden = false;
}

function aplicarAnalise() {
  const d = direcaoDe(st.analise); if (!d) { statusAnalise("A análise não trouxe a direção. Clique em Analisar de novo."); return; }
  if (d.opcoes && typeof d.opcoes === "object") for (const [k, v] of Object.entries(d.opcoes)) { const kk = k.startsWith("op-") ? k : "op-" + k; if (!(kk in d.opcoes)) d.opcoes[kk] = v; }
  const tons = (Array.isArray(d.tons) ? d.tons : String(d.tons || "").split(",")).map((t) => TONS.find((x) => normal(x) === normal(t))).filter(Boolean);
  if (tons.length) st.tons = new Set(tons);
  if (d.tom_livre) $("tom-livre").value = d.tom_livre;
  if (d.quero) $("quero").value = d.quero;
  if (d.nao_quero) $("nao-quero").value = d.nao_quero;
  for (const id of OPCOES) if (d.opcoes && typeof d.opcoes[id] === "boolean") $(id).checked = d.opcoes[id];
  if (["Anton", "Bangers", "Montserrat"].includes(d.fonte)) st.estilo.fonte = d.fonte;
  const cor = CORES.find((c) => c.toLowerCase() === String(d.destaque || "").toLowerCase()) || (/^#[0-9a-f]{6}$/i.test(d.destaque || "") ? d.destaque.toUpperCase() : null);
  if (cor) st.estilo.destaque = cor;
  if (typeof d.posicao === "number") st.estilo.posicao = clamp(d.posicao, 0.5, 0.85);
  if (typeof d.caixa_alta === "boolean") st.estilo.caixa = d.caixa_alta;
  if (d.chamada_final) $("final-chamada").value = String(d.chamada_final).slice(0, 40);
  if (typeof d.volume_trilha === "number") $("vol-musica").value = clamp(d.volume_trilha, 0.05, 0.6);
  // marcações: só nos trechos que o criador ainda não marcou
  let marcados = 0;
  for (const m of st.analise.marcacoes || []) {
    const s = st.segs.find((x) => x.id === Number(m.id));
    const mm = normal(m.marca).startsWith("outra") ? "outra" : normal(m.marca);
    if (s && s.marca === "manter" && ["destacar", "cortar", "outra"].includes(mm)) { s.marca = mm; marcados++; }
  }
  $("sel-preset").value = ""; $("btn-apagar-preset").hidden = true;
  desenharChips(); sincronizarEstiloUI(); carregarFontes().then(desenharTela);
  recalcular(); mostrarTrechos(); salvarLocal();
  if (!eng.rodando) irPara(Math.min(tempoEditado(), durEditada));
  $("est-direcao").textContent = "Preenchida pelo Claude";
  const trilha = d.trilha ? ` Trilha sugerida: ${d.trilha}.` : "";
  statusAnalise(`Direção preenchida${marcados ? ` e ${marcados} trechos marcados` : ""}. Ajuste o que quiser antes de editar.${trilha}`);
  for (const id of ["tom-livre", "quero", "nao-quero"]) { const el = $(id); el.style.height = "auto"; el.style.height = Math.min(260, el.scrollHeight + 4) + "px"; }
}

$("btn-autopreencher").onclick = async () => {
  if (!st.analise) await analisarVideo();
  if (st.analise) aplicarAnalise();
};
$("btn-restaurar-cortes").onclick = async () => { if (!st.plano) return; st.plano.cortar_segmentos = []; recalcular(); mostrarTrechos(); mostrarPlano(); salvarLocal(); await irPara(0); };
$("btn-reanalisar").onclick = async () => { st.analise = null; st.quadrosAnalise = null; mostrarAnalise(); await analisarVideo(); };
mostrarAnalise();


// ================================================================ análise do áudio: voz, silêncio, outras vozes
function analisarAudio(pcm) {
  const SR = 16000, HOP = 320, WIN = 640, hop = HOP / SR;
  const n = Math.max(1, Math.floor((pcm.length - WIN) / HOP) + 1);
  const db = new Float32Array(n), f0 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0; const o = i * HOP;
    for (let k = 0; k < WIN; k++) { const x = pcm[o + k] || 0; e += x * x; }
    db[i] = 10 * Math.log10(e / WIN + 1e-10);
  }
  const ord = Float32Array.from(db).sort();
  const pct = (p) => ord[Math.min(ord.length - 1, Math.floor(p * ord.length))];
  const piso = pct(0.1), pico = pct(0.97);
  // tom (f0) por autocorrelação em 8 kHz, só nos quadros com energia
  const W8 = 320, L0 = 20, L1 = 115, buf = new Float32Array(W8);
  for (let i = 0; i < n; i++) {
    if (db[i] < piso + 8) continue;
    const o = i * HOP;
    let m = 0;
    for (let k = 0; k < W8; k++) { buf[k] = ((pcm[o + 2 * k] || 0) + (pcm[o + 2 * k + 1] || 0)) / 2; m += buf[k]; }
    m /= W8; let e0 = 0;
    for (let k = 0; k < W8; k++) { buf[k] -= m; e0 += buf[k] * buf[k]; }
    if (e0 <= 0) continue;
    let melhor = 0, lag = 0;
    for (let L = L0; L <= L1; L++) {
      let c = 0, e1 = 0;
      for (let k = 0; k + L < W8; k++) { c += buf[k] * buf[k + L]; e1 += buf[k + L] * buf[k + L]; }
      const r = c / Math.sqrt(e0 * e1 + 1e-12);
      if (r > melhor) { melhor = r; lag = L; }
    }
    if (melhor > 0.5) f0[i] = 8000 / lag;
  }
  return { hop, db, f0, piso, pico };
}

function limiarVoz() {
  const A = st.audio; if (!A) return -Infinity;
  const sens = parseFloat($("aj-sens").value); // 0.15 (pega tudo) … 0.5 (só voz forte)
  return Math.max(A.piso + 6, A.piso + sens * (A.pico - A.piso));
}
const quadro = (t) => st.audio ? clamp(Math.floor(t / st.audio.hop), 0, st.audio.db.length - 1) : 0;

// regiões com voz dentro de [a, b], separadas por pausas maiores que pmin
function regioesDeFala(a, b, pmin) {
  const A = st.audio; if (!A) return [[a, b]];
  const lim = limiarVoz(), regs = [];
  let ini = null, ultVoz = null;
  for (let i = quadro(a); i <= quadro(b); i++) {
    if (A.db[i] > lim) { if (ini === null) ini = i; ultVoz = i; }
    else if (ini !== null && (i - ultVoz) * A.hop >= pmin) { regs.push([ini * A.hop, (ultVoz + 1) * A.hop]); ini = null; }
  }
  if (ini !== null) regs.push([ini * A.hop, Math.min(b, (ultVoz + 1) * A.hop)]);
  // a transcrição diz que há fala aqui: se a energia não achou nada, confia na transcrição
  return regs.length ? regs : [[a, b]];
}

// estende o começo e o fim de cada trecho até onde a voz realmente começa e termina
function ajustarLimites() {
  const A = st.audio, ord = [...st.segs].sort((x, y) => x.t0 - y.t0);
  const lim = limiarVoz();
  ord.forEach((s, k) => {
    if (!A) { s.a = s.t0; s.b = s.t1; return; }
    const minA = Math.max(0, k ? ord[k - 1].t1 : 0, s.t0 - 0.5), maxB = Math.min(st.dur, k + 1 < ord.length ? ord[k + 1].t0 : st.dur, s.t1 + 0.8);
    let i = quadro(s.t0);
    while (i > 0 && (i - 1) * A.hop >= minA && A.db[i - 1] > lim) i--;
    let j = quadro(s.t1);
    while (j + 1 < A.db.length && (j + 1) * A.hop <= maxB && A.db[j + 1] > lim) j++;
    s.a = Math.min(s.t0, i * A.hop); s.b = Math.max(s.t1, Math.min(maxB, (j + 1) * A.hop));
  });
}

function mediana(xs) { if (!xs.length) return null; const o = [...xs].sort((a, b) => a - b); return o[Math.floor(o.length / 2)]; }

// nível e tom de cada trecho em relação à voz principal (a que mais fala)
function classificarVozes(marcar) {
  const A = st.audio; if (!A || !st.segs.length) return;
  const lim = limiarVoz();
  for (const s of st.segs) {
    const niveis = [], tons = []; let voz = 0, total = 0;
    for (let i = quadro(s.t0); i <= quadro(s.t1); i++) { total++; if (A.db[i] > lim) { voz++; niveis.push(A.db[i]); if (A.f0[i]) tons.push(A.f0[i]); } }
    s.voz = { nivel: mediana(niveis) ?? A.piso, tom: mediana(tons), frac: total ? voz / total : 0 };
  }
  const pesados = [];
  for (const s of st.segs) { const peso = Math.max(1, Math.round((s.t1 - s.t0) * 4)); for (let k = 0; k < peso; k++) pesados.push(s); }
  const ref = mediana(pesados.map((s) => s.voz.nivel));
  const refTom = mediana(pesados.map((s) => s.voz.tom).filter(Boolean));
  for (const s of st.segs) {
    s.voz.rel = s.voz.nivel - ref;
    const difTom = s.voz.tom && refTom ? Math.abs(Math.log2(s.voz.tom / refTom)) : 0;
    s.voz.outra = s.voz.rel < -9 || (difTom > 0.5 && s.voz.rel < -3) || s.voz.frac < 0.12;
    if (marcar && s.voz.outra && s.marca === "manter" && op("op-vozprincipal")) s.marca = "outra";
  }
}
function infoVoz(s) { return s.voz ? `, voz ${s.voz.rel > 0 ? "+" : ""}${s.voz.rel.toFixed(0)} dB${s.voz.outra ? ", parece outra voz" : ""}` : ""; }

async function garantirAudio() {
  if (st.audio || !st.arquivo) return;
  const chave = st.chave;
  try {
    const pcm = await audio16k(st.arquivo);
    if (chave !== st.chave) return;
    st.audio = analisarAudio(pcm);
    classificarVozes(false);
    recalcular(); mostrarTrechos(); if (st.plano) mostrarPlano(); desenharTela();
  } catch {}
}

// redução de ruído: abaixa a voz fora das falas mantidas e nos quadros sem voz
function alvoGate(peca) {
  if (!op("op-ruido") || !st.audio || peca?.tipo !== "clip") return 1;
  const t = video.currentTime;
  const s = st.segs.find((x) => t >= (x.a ?? x.t0) - 0.08 && t <= (x.b ?? x.t1) + 0.12 && x.marca !== "cortar" && !(x.marca === "outra" && op("op-vozprincipal")));
  if (!s) return 0.06;
  const i = quadro(t), lim = limiarVoz();
  let max = -Infinity; for (let k = Math.max(0, i - 3); k <= Math.min(st.audio.db.length - 1, i + 3); k++) max = Math.max(max, st.audio.db[k]);
  return max > lim ? 1 : 0.3;
}
function ajustarFiltros() {
  if (!filtroAlto) return;
  const r = op("op-ruido");
  filtroAlto.frequency.value = r ? 100 : 80;
  filtroBaixo.frequency.value = r ? 8500 : 20000;
}

// ---------------------------------------------------------------- ajustes dos cortes
function mostrarAjustes() {
  $("aj-pausa-v").textContent = `${parseFloat($("aj-pausa").value).toFixed(2)} s`;
  $("aj-respiro-v").textContent = `${parseFloat($("aj-respiro").value).toFixed(2)} s`;
  const v = parseFloat($("aj-sens").value);
  $("aj-sens-v").textContent = v < 0.22 ? "pega tudo" : v < 0.34 ? "equilibrado" : v < 0.44 ? "só voz clara" : "só voz forte";
}
for (const id of Object.keys(AJUSTES)) $(id).addEventListener("input", () => {
  mostrarAjustes();
  if (id === "aj-sens" && st.audio) classificarVozes(false);
  recalcular(); if (id === "aj-sens") mostrarTrechos(); salvarLocal();
  if (!eng.rodando) irPara(Math.min(tempoEditado(), durEditada));
});
$("op-ruido").addEventListener("change", ajustarFiltros);
$("aj-padrao").onclick = () => { for (const [id, v] of Object.entries(AJUSTES)) $(id).value = v; $("aj-sens").dispatchEvent(new Event("input")); };
$("aj-ouvir").onclick = async () => { if (!st.segs.length) return; await irPara(0); reproduzir(); };
mostrarAjustes();

// ---------------------------------------------------------------- edição de legenda no monitor
let segLegenda = null;
function crescer(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; }
function segsVisiveis() { const c = cortesClaude(); return st.segs.filter((s) => !cortado(s, c)).sort((a, b) => a.t0 - b.t0); }
function sincronizarLegendaAtual(forcar) {
  const box = $("leg-editor"); if (!box) return;
  const p = pecas[eng.idx];
  const t = video.currentTime;
  let s = p?.tipo === "clip" ? st.segs.find((x) => t >= (x.a ?? x.t0) && t < (x.b ?? x.t1)) : null;
  if (!s && segLegenda) s = segLegenda;
  if (!s) { const v = segsVisiveis(); s = v.find((x) => x.t0 >= t) || v[v.length - 1] || null; }
  box.hidden = !s;
  if (!s) return;
  const ta = $("leg-texto");
  if (s !== segLegenda || (forcar && document.activeElement !== ta)) {
    segLegenda = s;
    if (document.activeElement !== ta) ta.value = s.texto;
    $("leg-oculta").checked = !!s.semLegenda;
    $("leg-tempo").textContent = `Trecho ${s.id} · ${fmtD(s.t0)} do bruto`;
  }
}
$("leg-texto").addEventListener("input", () => {
  const s = segLegenda; if (!s) return;
  s.texto = $("leg-texto").value.replace(/\s+/g, " ").trim(); s.editado = true;
  const el = document.querySelector(`.trecho[data-id="${s.id}"] .txt`); if (el) { el.value = s.texto; crescer(el); }
  recalcular(); desenharTela(); salvarLocal();
});
$("leg-oculta").addEventListener("change", () => { const s = segLegenda; if (!s) return; s.semLegenda = $("leg-oculta").checked; recalcular(); desenharTela(); salvarLocal(); });
async function irSegLegenda(dir) {
  const v = segsVisiveis(); if (!v.length) return;
  let i = v.indexOf(segLegenda); i = i < 0 ? 0 : clamp(i + dir, 0, v.length - 1);
  segLegenda = v[i]; await irParaBruto(v[i].t0 + 0.05); segLegenda = v[i]; sincronizarLegendaAtual(true);
  $("leg-texto").value = v[i].texto; $("leg-oculta").checked = !!v[i].semLegenda;
  $("leg-tempo").textContent = `Trecho ${v[i].id} · ${fmtD(v[i].t0)} do bruto`;
}
$("leg-ant").onclick = () => irSegLegenda(-1);
$("leg-prox").onclick = () => irSegLegenda(1);
$("leg-bloco").onchange = (e) => { st.estilo.porBloco = parseInt(e.target.value, 10); recalcular(); desenharTela(); salvarLocal(); };
tela.addEventListener("click", () => { if (!st.segs.length || eng.rodando) return; sincronizarLegendaAtual(true); $("leg-texto").focus(); });

// ---------------------------------------------------------------- pedidos ao Claude que sempre devolvem JSON
function extrairJSON(txt) {
  if (!txt) return null;
  let t = String(txt).replace(/```(?:json)?/gi, "");
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(t.slice(i, j + 1)); } catch { return null; }
}
async function pedirJSON(pedido, imagens) {
  const tentativas = imagens?.length ? [{ images: imagens }, {}] : [{}];
  let ultimo = null;
  for (const extra of tentativas) {
    try { const r = await sample.json(pedido, { modelTier: "complex", ...extra }); if (r && typeof r === "object") return r; }
    catch (e) { ultimo = e; if (e?.code === "not_granted" || e?.code === "rate_limited") throw e; console.warn("sample.json falhou", e); }
    try { const r = await sample(pedido, { modelTier: "complex", ...extra }); const j = extrairJSON(r?.text); if (j) return j; ultimo = new Error("a resposta não veio em JSON"); }
    catch (e) { ultimo = e; if (e?.code === "not_granted" || e?.code === "rate_limited") throw e; console.warn("sample falhou", e); }
  }
  throw ultimo || new Error("sem resposta");
}
function direcaoDe(a) {
  if (!a || typeof a !== "object") return null;
  const d = a.direcao || a["direção"] || a.direction || (a.tom_livre || a.quero ? a : null);
  return d && typeof d === "object" ? d : null;
}
