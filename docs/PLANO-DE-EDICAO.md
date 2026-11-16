# Plano de edição

Cada vídeo é descrito por um JSON em `planos/`. O motor (`motor/editar.py`) lê o plano e entrega o vídeo vertical pronto. Veja o exemplo em [`planos/exemplo.json`](../planos/exemplo.json).

Caminhos relativos são resolvidos a partir da pasta do plano.

| Campo | Obrigatório | O que é |
|---|---|---|
| `id` | sim | Nome curto do vídeo. Vira a pasta `motor/saida/<id>/`. |
| `video` | sim | Vídeo bruto gravado no celular (qualquer proporção; o motor enquadra em 9:16). |
| `transcricao` | sim | JSON gerado pelo `transcrever.py`, com o tempo de cada palavra. |
| `cortes` | não | Trechos do bruto que ficam, em segundos: `[[início, fim], ...]`. Sem o campo, o vídeo inteiro é usado. |
| `legenda` | não | Estilo das legendas palavra a palavra (fonte, tamanho, cores, posição vertical de 0 a 1, palavras por bloco, maiúsculas). |
| `graficos` | não | Cartelas ligadas ao que é dito. |
| `trilha` | não | Música de fundo com volume. Abaixa sozinha quando a pessoa fala (ducking). |
| `post` | não | Legenda do post e hashtags. Vira `legenda-post.txt`. |

## Grafismos

```json
{"t0_bruto": 2.1, "t1_bruto": 4.0, "texto": "3 erros", "entrada": "esquerda", "posicao": 0.22, "camada": "atras"}
```

- `t0_bruto` / `t1_bruto`: quando aparece e some, **no tempo do vídeo bruto** (o mesmo da transcrição). O motor ajusta aos cortes. Também aceita `t0` / `t1` já no tempo do vídeo editado.
- `entrada`: `esquerda` ou `direita` (de onde a cartela desliza).
- `posicao`: altura na tela, de 0 (topo) a 1 (base).
- `camada`: `frente` (padrão) ou `atras`. Para ficar atrás da pessoa é preciso o recorte, que é a próxima etapa. Até lá, o motor avisa e coloca na frente.

## Saída

`motor/saida/<id>/`:
- `<id>.mp4`: 1080×1920, 30 fps, voz tratada e normalizada a -14 LUFS (padrão das redes).
- `<id>-previa.mp4`: com `--previa`, 540×960, para aprovação rápida.
- `legenda-post.txt`: legenda do post e hashtags.
- `legendas.ass`: as legendas geradas, para conferir ou corrigir.
