// Worker de transcrição do Estúdio de Edição.
// Roda o Whisper (base, quantizado) inteiro no navegador, com os pesos servidos pelo próprio artefato.
// Os pesos ficam divididos em partes .bin (limite de tamanho por arquivo) e são remontados aqui.

const BASE = new URL("./", self.location.href).href;
// arquivo pedido → [quantas partes, tipo]
const PARTES = {
  "encoder_model_quantized.onnx": [2, "application/octet-stream"],
  "decoder_model_merged_quantized.onnx": [4, "application/octet-stream"],
  "ort-wasm-simd-threaded.jsep.wasm": [2, "application/wasm"],
};

const fetchOriginal = self.fetch.bind(self);
self.fetch = async (entrada, init) => {
  const url = typeof entrada === "string" ? entrada : (entrada instanceof URL ? entrada.href : entrada.url);
  const limpo = url.split("?")[0];
  const nome = limpo.slice(limpo.lastIndexOf("/") + 1);
  const info = PARTES[nome];
  if (info) {
    const [total, tipo] = info;
    const pasta = limpo.slice(0, limpo.lastIndexOf("/") + 1);
    const base = nome.replace(/\.(onnx|wasm)$/, "");
    const buffers = [];
    for (let i = 0; i < total; i++) {
      const r = await fetchOriginal(`${pasta}${base}.${i}.wasm`);
      if (!r.ok) throw new Error(`não consegui carregar ${base} parte ${i} (${r.status})`);
      buffers.push(await r.arrayBuffer());
      if (tipo !== "application/wasm") self.postMessage({ tipo: "carregando", arquivo: base, parte: i + 1, total });
    }
    const tamanho = buffers.reduce((s, b) => s + b.byteLength, 0);
    return new Response(new Blob(buffers), {
      status: 200,
      headers: { "Content-Type": tipo, "Content-Length": String(tamanho) },
    });
  }
  return fetchOriginal(entrada, init);
};

let transcrever = null;

async function preparar() {
  if (transcrever) return transcrever;
  const tf = await import(BASE + "lib/transformers.min.js");
  const { env, pipeline } = tf;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = BASE + "models/";
  env.useBrowserCache = false;
  env.backends.onnx.wasm.wasmPaths = BASE + "lib/";
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  self.postMessage({ tipo: "status", texto: "Carregando o modelo de transcrição…" });
  transcrever = await pipeline("automatic-speech-recognition", "Xenova/whisper-base", {
    dtype: "q8",
    device: "wasm",
  });
  return transcrever;
}

self.onmessage = async (ev) => {
  const { tipo, audio, duracao } = ev.data;
  if (tipo !== "transcrever") return;
  try {
    const asr = await preparar();
    self.postMessage({ tipo: "status", texto: "Transcrevendo a fala…" });
    // processa em janelas de 30 s para poder mostrar o progresso
    const SR = 16000, JAN = 30 * SR, SOBRA = 0;
    const segmentos = [];
    for (let ini = 0; ini < audio.length; ini += JAN) {
      const pedaco = audio.subarray(ini, Math.min(audio.length, ini + JAN + SOBRA));
      if (pedaco.length < SR * 0.3) break;
      const off = ini / SR;
      const r = await asr(pedaco, {
        language: "portuguese",
        task: "transcribe",
        return_timestamps: true,
        chunk_length_s: 30,
      });
      for (const c of r.chunks || []) {
        const t0 = (c.timestamp[0] ?? 0) + off;
        let t1 = c.timestamp[1];
        t1 = (t1 == null ? Math.min(duracao, off + pedaco.length / SR) : t1 + off);
        const texto = (c.text || "").trim();
        if (texto) segmentos.push({ t0, t1: Math.max(t1, t0 + 0.3), texto });
      }
      self.postMessage({ tipo: "progresso", feito: Math.min(1, (ini + JAN) / audio.length), segmentos });
    }
    self.postMessage({ tipo: "pronto", segmentos });
  } catch (e) {
    self.postMessage({ tipo: "erro", texto: String(e && e.message || e) });
  }
};
