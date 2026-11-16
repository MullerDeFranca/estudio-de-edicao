# Estúdio de Edição

Sistema para transformar vídeos gravados no celular em vídeos verticais prontos para postar (TikTok, Reels, Shorts): legendas palavra a palavra, grafismos ligados ao que é dito, trilha opcional, e o pacote de aprovação com a legenda do post e as hashtags.

Segue a mesma lógica do [Estúdio de Canais](https://github.com/MullerDeFranca/estudio-de-canais): um **plano de edição** em JSON descreve o vídeo e um **motor** em Python + ffmpeg faz a renderização.

## Fluxo de um vídeo

1. Colocar o vídeo bruto em `bruto/`.
2. Transcrever: `python3 motor/transcrever.py bruto/video.mp4` → `bruto/video.transcricao.json`.
3. Montar o plano em `planos/<id>.json`: cortes, grafismos nos momentos certos, trilha, legenda do post. Esta é a parte que o Claude faz a partir da transcrição.
4. Prévia para aprovação: `python3 motor/editar.py planos/<id>.json --previa`.
5. Depois de aprovado: `python3 motor/editar.py planos/<id>.json`.

O formato do plano está em [`docs/PLANO-DE-EDICAO.md`](docs/PLANO-DE-EDICAO.md).

## O que já funciona

- Enquadramento automático em 9:16 (1080×1920, 30 fps).
- Cortes de trechos, com legendas e grafismos acompanhando os cortes.
- Legendas palavra a palavra: o bloco aparece e a palavra falada acende na cor de destaque.
- Grafismos em cartela que entram deslizando no momento em que o assunto é dito.
- Voz tratada (corte de graves, compressão, normalização a -14 LUFS).
- Trilha opcional com ducking sob a voz e fade no final.
- `legenda-post.txt` com a legenda do post e as hashtags.

## Próximas etapas

- **Recorte da pessoa** para grafismos passarem atrás dela (`"camada": "atras"`). No Windows com a RX 7800 XT, via ONNX Runtime + DirectML.
- **Página do Estúdio** (como no Estúdio de Canais): enviar o vídeo, ver a transcrição, aprovar a prévia e baixar o pacote.
- Cortes automáticos de silêncios e repetições.
- Mais estilos de grafismo (números que contam, ícones, setas, zoom no rosto).

## Requisitos

Python 3.10+ e ffmpeg (com libass) no PATH.

```bash
pip install -r requirements.txt
```

A transcrição roda na CPU com o modelo `small` do faster-whisper (baixado automaticamente na primeira vez).

## Licenças

- Fonte Anton: OFL.
- faster-whisper: MIT. Modelos Whisper: MIT.
