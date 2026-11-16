#!/usr/bin/env python3
"""Motor do Estúdio de Edição: vídeo gravado no celular + plano de edição → vídeo vertical pronto.

Uso: python3 editar.py planos/<plano>.json [--previa]

O plano (ver docs/PLANO-DE-EDICAO.md) diz:
  - qual vídeo bruto usar e quais trechos manter (cortes);
  - o estilo das legendas palavra a palavra (vêm da transcrição do transcrever.py);
  - os grafismos ligados ao que é dito (cartelas, números, palavras-chave);
  - a trilha opcional, com ducking automático sob a voz;
  - a legenda do post e as hashtags.

Saída em saida/<id>/: <id>.mp4, legenda-post.txt e legendas.ass (para conferência).
--previa renderiza em 540x960, mais rápido, para aprovação.
"""
import json, os, re, subprocess, sys

BASE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(BASE, "fonts")
W, H, FPS = 1080, 1920, 30


# ============================================================ utilidades
def sondar(video):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                        "format=duration:stream=codec_type,width,height",
                        "-of", "json", video], capture_output=True, text=True, check=True)
    d = json.loads(r.stdout)
    v = next(s for s in d["streams"] if s["codec_type"] == "video")
    tem_audio = any(s["codec_type"] == "audio" for s in d["streams"])
    return float(d["format"]["duration"]), v["width"], v["height"], tem_audio


def cor_ass(hexcor, alfa=0):
    """#RRGGBB → &HAABBGGRR (formato do ASS)."""
    h = hexcor.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alfa:02X}{b}{g}{r}".upper()


def tempo_ass(t):
    t = max(0.0, t)
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def escapar(txt):
    return txt.replace("\\", "").replace("{", "(").replace("}", ")")


# ============================================================ cortes
def remapear(t, cortes):
    """Tempo no vídeo bruto → tempo no vídeo editado (None se caiu num trecho cortado)."""
    off = 0.0
    for a, b in cortes:
        if a <= t <= b:
            return off + (t - a)
        off += b - a
    return None


def palavras_editadas(transcricao, cortes):
    saida = []
    for w in transcricao["palavras"]:
        t0 = remapear(w["t0"], cortes)
        t1 = remapear(min(w["t1"], w["t0"] + 2.0), cortes)
        if t0 is None:
            continue
        if t1 is None or t1 <= t0:
            t1 = t0 + 0.25
        saida.append({"t0": t0, "t1": t1, "p": w["p"]})
    return saida


# ============================================================ legendas
def blocos(palavras, por_bloco, pausa_quebra=0.45):
    """Agrupa palavras em blocos curtos; quebra também em pausas e pontuação final."""
    atual, todos = [], []
    for i, w in enumerate(palavras):
        atual.append(w)
        fim_frase = re.search(r"[.!?…]$", w["p"])
        prox = palavras[i + 1] if i + 1 < len(palavras) else None
        pausa = prox is not None and prox["t0"] - w["t1"] > pausa_quebra
        if len(atual) >= por_bloco or fim_frase or pausa or prox is None:
            todos.append(atual); atual = []
    return todos


def montar_ass(palavras, graficos, cfg, largura, altura):
    leg = cfg.get("legenda", {})
    fonte = leg.get("fonte", "Anton")
    tam = int(leg.get("tamanho", 92) * altura / H)
    cor = cor_ass(leg.get("cor", "#FFFFFF"))
    destaque = cor_ass(leg.get("cor_destaque", "#FFD400"))
    contorno = max(2, int(6 * altura / H))
    y = int(altura * leg.get("posicao", 0.70))
    maiusc = leg.get("maiusculas", True)
    por_bloco = int(leg.get("palavras_por_bloco", 3))

    g_tam = int(78 * altura / H)
    linhas = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {largura}", f"PlayResY: {altura}",
        "WrapStyle: 0", "", "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Leg,{fonte},{tam},{cor},{cor},&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,{contorno},2,5,60,60,0,1",
        f"Style: Graf,{fonte},{g_tam},&H00FFFFFF,&H00FFFFFF,&H00000000,{destaque},0,0,0,0,100,100,1,0,3,18,0,5,60,60,0,1",
        "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    # legendas palavra a palavra: o bloco inteiro aparece e a palavra falada acende e cresce
    lista = blocos(palavras, por_bloco)
    for k, bl in enumerate(lista):
        fim_bloco = bl[-1]["t1"] + 0.12
        if k + 1 < len(lista):  # nunca sobrepor o bloco seguinte
            fim_bloco = min(fim_bloco, lista[k + 1][0]["t0"])
        for i, w in enumerate(bl):
            ini = w["t0"]
            fim = bl[i + 1]["t0"] if i + 1 < len(bl) else fim_bloco
            partes = []
            for j, x in enumerate(bl):
                txt = escapar(x["p"].upper() if maiusc else x["p"])
                if j == i:
                    partes.append(r"{\c" + destaque + r"\fscx110\fscy110}" + txt + r"{\c" + cor + r"\fscx100\fscy100}")
                else:
                    partes.append(txt)
            entrada = r"{\fad(60,0)}" if i == 0 else ""
            linhas.append(f"Dialogue: 1,{tempo_ass(ini)},{tempo_ass(fim)},Leg,,0,0,0,,"
                          + r"{\pos(" + f"{largura // 2},{y}" + r")}" + entrada + " ".join(partes))

    # grafismos: cartelas que entram deslizando no momento em que o assunto é dito
    for g in graficos:
        t0, t1 = g["t0"], g["t1"]
        gy = int(altura * g.get("posicao", 0.22))
        lado = g.get("entrada", "esquerda")
        x_fora = -largura // 2 if lado == "esquerda" else largura + largura // 2
        cx = largura // 2
        txt = escapar(g["texto"].upper() if g.get("maiusculas", True) else g["texto"])
        mov = r"{\move(" + f"{x_fora},{gy},{cx},{gy},0,220" + r")\fad(0,180)}"
        linhas.append(f"Dialogue: 2,{tempo_ass(t0)},{tempo_ass(t1)},Graf,,0,0,0,,{mov}{txt}")
    return "\n".join(linhas) + "\n"


# ============================================================ render
def editar(plano_path, previa=False):
    base_plano = os.path.dirname(os.path.abspath(plano_path))
    with open(plano_path, encoding="utf-8") as f:
        cfg = json.load(f)
    caminho = lambda p: p if os.path.isabs(p) else os.path.join(base_plano, p)

    vid = cfg["id"]
    video = caminho(cfg["video"])
    dur, vw, vh, tem_audio = sondar(video)
    if not tem_audio:
        sys.exit("o vídeo não tem áudio: o Estúdio de Edição parte da fala gravada")
    cortes = [tuple(c) for c in cfg.get("cortes") or [[0, dur]]]
    dur_final = sum(b - a for a, b in cortes)

    with open(caminho(cfg["transcricao"]), encoding="utf-8") as f:
        transcricao = json.load(f)
    palavras = palavras_editadas(transcricao, cortes)

    graficos = []
    for g in cfg.get("graficos", []):
        if g.get("camada") == "atras":
            print(f"aviso: grafismo {g['texto']!r} pediu camada 'atras'; o recorte da pessoa "
                  "ainda não existe, então ele vai na frente por enquanto")
        if "t0_bruto" in g:  # tempos marcados no vídeo bruto
            t0 = remapear(g["t0_bruto"], cortes)
            if t0 is None:
                continue
            g = dict(g, t0=t0, t1=t0 + (g["t1_bruto"] - g["t0_bruto"]))
        graficos.append(g)

    largura, altura = (540, 960) if previa else (W, H)
    pasta = os.path.join(BASE, "saida", vid)
    os.makedirs(pasta, exist_ok=True)
    ass = os.path.join(pasta, "legendas.ass")
    with open(ass, "w", encoding="utf-8") as f:
        f.write(montar_ass(palavras, graficos, cfg, largura, altura))

    # 1) cortes  2) enquadrar em 9:16 (preenche a tela, recorta o excesso)  3) legendas e grafismos
    fc, rotulos = [], []
    for i, (a, b) in enumerate(cortes):
        fc.append(f"[0:v]trim={a}:{b},setpts=PTS-STARTPTS[v{i}]")
        fc.append(f"[0:a]atrim={a}:{b},asetpts=PTS-STARTPTS[a{i}]")
        rotulos.append(f"[v{i}][a{i}]")
    fc.append("".join(rotulos) + f"concat=n={len(cortes)}:v=1:a=1[vc][ac]")
    ass_ff = ass.replace("\\", "/").replace(":", r"\:")
    fontes_ff = FONTS.replace("\\", "/").replace(":", r"\:")
    fc.append(f"[vc]scale={largura}:{altura}:force_original_aspect_ratio=increase,"
              f"crop={largura}:{altura},fps={FPS},setsar=1,"
              f"ass='{ass_ff}':fontsdir='{fontes_ff}'[vout]")

    # voz: limpa graves, comprime de leve e normaliza para o padrão das redes (-14 LUFS)
    fc.append("[ac]highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,"
              "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[voz]")

    entradas = ["-i", video]
    trilha = cfg.get("trilha")
    if trilha and trilha.get("arquivo"):
        entradas += ["-stream_loop", "-1", "-i", caminho(trilha["arquivo"])]
        vol = trilha.get("volume", 0.25)
        fc.append(f"[1:a]aresample=48000,volume={vol},atrim=0:{dur_final},"
                  f"afade=t=out:st={max(0, dur_final - 1.5)}:d=1.5[mus]")
        fc.append("[voz]asplit=2[voz1][voz2]")
        fc.append("[mus][voz2]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[musd]")
        fc.append("[voz1][musd]amix=inputs=2:duration=first:normalize=0[aout]")
    else:
        fc.append("[voz]anull[aout]")

    saida = os.path.join(pasta, f"{vid}{'-previa' if previa else ''}.mp4")
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-stats", *entradas,
           "-filter_complex", ";".join(fc), "-map", "[vout]", "-map", "[aout]",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "26" if previa else "18",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
           "-movflags", "+faststart", "-t", f"{dur_final:.3f}", saida]
    subprocess.run(cmd, check=True)

    post = cfg.get("post", {})
    texto_post = post.get("legenda", "").strip()
    tags = " ".join(post.get("hashtags", []))
    with open(os.path.join(pasta, "legenda-post.txt"), "w", encoding="utf-8") as f:
        f.write(texto_post + ("\n\n" + tags if tags else "") + "\n")

    print(f"pronto: {saida} ({dur_final:.1f}s, {len(palavras)} palavras, {len(graficos)} grafismos)")
    return saida


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    editar(args[0], previa="--previa" in sys.argv)
