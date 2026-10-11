# Opaya film (1:25)

A 3D film about Opaya, built with Three.js in the app's own visual language (agent cores, flights with
sparks, Docker cubes, key tokens). The same page plays interactively in a browser and renders frame
by frame to an MP4.

## Story

| Time | Scene | Voice over |
| --- | --- | --- |
| 0:00 | Laptop, servers and Docker, each with its agent, then twelve terminals, loose `.env` keys and tangled cables | "You've got Claude Code on your laptop…" |
| 0:13 | The extruded Opaya mark lands, terminals are pulled in, the cables straighten into one hub | "Meet Opaya. One place, for all your agents." |
| 0:20 | Sonar scans each place, agents are found and fly into orbit around the hub | "Opaya finds the agents…" |
| 0:31 | An exploded app window assembles: sidebar, chat, terminal, split terminal | "Chat with any of them…" |
| 0:41 | An agent card is dragged to acme-vps; skills, memory and keys stream across, the clone assembles | "Need the same agent on a server?…" |
| 0:51 | `.env` values turn into keys, enter the Vault, agents get keys by name, a value bounces off the chat | "Your keys live in one encrypted vault…" |
| 1:00 | 02:13, an agent goes red; the Opaya Agent flies in, diagnoses, fixes and reports | "Something broke at 2 a.m.?…" |
| 1:10 | Everything sits under a dome; account, telemetry and relay are blocked | "No account. No telemetry. No relay." |
| 1:19 | The mark, opaya.dev, Windows and macOS | "Opaya. One place. All your agents." |

## Build

```bash
pip install kokoro-onnx soundfile scipy numpy
python3 vo.py af_heart 1.0                      # voice over -> vo/ (already included)
python3 soundtrack.py [optional-music.wav]      # voice + sound design (+ a licensed music bed, ducked)
ffmpeg -i soundtrack.wav -b:a 192k soundtrack.mp3
python3 -m http.server 8765                     # open http://127.0.0.1:8765/ to watch it interactively
```

Render the MP4 (1920x1080, 30 fps, 2550 frames):

```bash
npm i playwright
python3 -m http.server 8765 --bind 127.0.0.1 &
for w in 0 1 2 3; do node render.mjs range $((w*638)) $(( (w+1)*638 > 2550 ? 2550 : (w+1)*638 )) frames & done; wait
ffmpeg -framerate 30 -i frames/f%05d.jpg -i soundtrack.wav -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p \
  -c:a aac -b:a 256k -shortest -movflags +faststart opaya-film.mp4
```

`window.renderAt(t)` draws the frame at `t` seconds deterministically: `node render.mjs times 13.1,47.6 out`
renders single frames. The logo is extruded from `assets/opaya-interlock.png` using the contour in
`logo-shape.json`, with the mark itself as the face texture.
