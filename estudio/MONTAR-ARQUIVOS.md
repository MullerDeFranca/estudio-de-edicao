# Arquivos pesados da página do Estúdio

A página (`index.html` + `transcritor.js`) roda a transcrição no navegador com o Whisper base quantizado.
Os pesos não ficam no Git; para republicar o artefato, monte a pasta assim:

```bash
# transformers.js 3.8.1 (inclui o onnxruntime-web)
npm pack @huggingface/transformers@3.8.1 && tar xzf huggingface-transformers-3.8.1.tgz
mkdir -p lib && cp package/dist/transformers.min.js package/dist/ort-wasm-simd-threaded.jsep.mjs lib/
split -b 12000000 -d -a 1 package/dist/ort-wasm-simd-threaded.jsep.wasm lib/ort-wasm-simd-threaded.jsep.
for f in lib/ort-wasm-simd-threaded.jsep.[0-9]; do mv $f $f.wasm; done

# Whisper base (Xenova, q8) — pacote npm sts-whisper-base 1.0.0 (Apache-2.0)
npm pack sts-whisper-base@1.0.0 && tar xzf sts-whisper-base-1.0.0.tgz
M=models/Xenova/whisper-base; mkdir -p $M/onnx
cp package/$M/*.json package/$M/merges.txt $M/
for f in encoder_model_quantized decoder_model_merged_quantized; do
  split -b 15000000 -d -a 1 package/$M/onnx/$f.onnx $M/onnx/$f.
  for p in $M/onnx/$f.[0-9]; do mv $p $p.wasm; done
done
```

Cada arquivo publicado precisa ter menos de 20 MiB, por isso as partes. O `transcritor.js` remonta as partes
(quantidade em `PARTES`). A extensão `.wasm` é só para o servidor do artefato aceitar o arquivo.

## Recorte da pessoa (MediaPipe Selfie Segmentation, Apache-2.0)

```bash
npm pack @mediapipe/selfie_segmentation@0.1.1675465747 && tar xzf mediapipe-selfie_segmentation-*.tgz
mkdir -p mp && cp package/*.js mp/
for f in selfie_segmentation.binarypb selfie_segmentation.tflite selfie_segmentation_landscape.tflite \
         selfie_segmentation_solution_simd_wasm_bin.wasm selfie_segmentation_solution_wasm_bin.wasm; do
  cp package/$f mp/$f.wasm
done
```

O `app.js` carrega com `locateFile: f => "mp/" + (f.endsWith(".js") ? f : f + ".wasm")`. O arquivo `.data` (vazio) não é necessário.
