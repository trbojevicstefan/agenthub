# Opaya film (1:25)

A 3D motion-graphics film about Opaya, built with Three.js. The same page plays
interactively in a browser and renders frame by frame to an MP4.

## Watch it interactively

```bash
python3 music.py && ffmpeg -i music.wav -b:a 192k music.mp3   # soundtrack (needs numpy + scipy)
python3 -m http.server 8765                                    # then open http://127.0.0.1:8765/
```

Drag to look around, Space to pause, Left/Right to skip 5 s, click the bar to scrub.

## Render the MP4 (1920x1080, 30 fps, 2550 frames)

```bash
npm i playwright
python3 -m http.server 8765 --bind 127.0.0.1 &
for w in 0 1 2 3; do node render.mjs range $((w*638)) $(( (w+1)*638 > 2550 ? 2550 : (w+1)*638 )) frames & done; wait
ffmpeg -framerate 30 -i frames/f%05d.jpg -i music.wav -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p \
  -c:a aac -b:a 256k -shortest -movflags +faststart opaya-film.mp4
```

`window.renderAt(t)` draws the frame at time `t` (seconds) deterministically, so any
frame can be re-rendered on its own: `node render.mjs times 12.5,40 out`.

## Timeline

| Time | Scene |
| --- | --- |
| 0:00 | Terminals, SSH sessions and .env files pile up |
| 0:12 | They collapse into the Opaya logo |
| 0:20 | Claude Code, Codex, Hermes, OpenClaw orbit Opaya; this computer, VPS, Docker |
| 0:31 | Chat, Machines, Vault, Clone & Share, Opaya Agent (app screenshots in 3D) |
| 1:11 | Feature wall, then "No account. No telemetry. No relay." |
| 1:19 | Logo, opaya.dev, Windows and macOS |

Screenshots and vendor logos come from the opayawebsite repo (`public/screenshots`, `public/brand/vendors`).
