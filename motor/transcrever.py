#!/usr/bin/env python3
"""Transcreve a fala de um vídeo com marcação de tempo por palavra.

Uso: python3 transcrever.py <video> [saida.json] [--modelo small|medium|large-v3]

Gera um JSON {"idioma": "pt", "palavras": [{"t0": 0.42, "t1": 0.71, "p": "Olá"}, ...]}
que o editar.py usa para montar as legendas palavra a palavra.

Roda na CPU (faster-whisper / CTranslate2). No Windows com placa AMD não há CUDA;
o modelo "small" já é bom para português e leva cerca de 1x a duração do vídeo.
"""
import json, os, sys, subprocess, tempfile


def extrair_audio(video, wav):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video,
                    "-vn", "-ac", "1", "-ar", "16000", wav], check=True)


def transcrever(video, modelo="small"):
    from faster_whisper import WhisperModel
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "a.wav")
        extrair_audio(video, wav)
        m = WhisperModel(modelo, device="cpu", compute_type="int8")
        segs, info = m.transcribe(wav, language="pt", word_timestamps=True,
                                  vad_filter=True)
        palavras = []
        for s in segs:
            for w in s.words or []:
                txt = w.word.strip()
                if txt:
                    palavras.append({"t0": round(w.start, 3), "t1": round(w.end, 3), "p": txt})
    return {"idioma": info.language, "palavras": palavras}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    modelo = "small"
    if "--modelo" in sys.argv:
        modelo = sys.argv[sys.argv.index("--modelo") + 1]
        args = [a for a in args if a != modelo]
    video = args[0]
    saida = args[1] if len(args) > 1 else os.path.splitext(video)[0] + ".transcricao.json"
    dados = transcrever(video, modelo)
    with open(saida, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, indent=1)
    print(f"{len(dados['palavras'])} palavras → {saida}")


if __name__ == "__main__":
    main()
