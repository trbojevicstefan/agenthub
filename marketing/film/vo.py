"""Voice over with Kokoro TTS (kokoro-onnx). Needs kokoro-v1.0.onnx and voices-v1.0.bin from the kokoro-onnx releases.
Usage: python3 vo.py af_heart 1.0  -> vo/00.wav ... vo/10.wav"""
import os, sys, soundfile as sf, numpy as np
from kokoro_onnx import Kokoro
k = Kokoro('kokoro-v1.0.onnx', 'voices-v1.0.bin')
voice = sys.argv[1]; speed = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
LINES = [
 "You've got Claude Code on your laptop. Hermes on a server. OpenClaw, in Docker.",
 "Twelve terminals. API keys in six different files. And no idea what's running where.",
 "Meet Opaya.",
 "One place, for all your agents.",
 "Opaya finds the agents on your computer, on your servers over SSH, and inside Docker, and brings them together.",
 "Chat with any of them. Watch their terminals. Run them side by side.",
 "Need the same agent on a server? Drag it there. Opaya clones it, skills, memory and keys included, in one click.",
 "Your keys live in one encrypted vault. An agent gets a key by name. The value never shows up in a chat.",
 "Something broke at two a.m.? The Opaya Agent finds the problem, fixes it, and tells you what it did.",
 "No account. No telemetry. No relay. Your machines. Your agents.",
 "Opaya. One place. All your agents. Free, at opaya dot dev.",
]
out = {}
for i, l in enumerate(LINES):
    a, sr = k.create(l, voice=voice, speed=speed, lang='en-us')
    # trim silence
    idx = np.where(np.abs(a) > 0.01)[0]; a = a[max(0, idx[0]-800): idx[-1]+2400]
    os.makedirs('vo', exist_ok=True); sf.write(f'vo/{i:02d}.wav', a, sr); out[i] = round(len(a)/sr, 2)
print(voice, out, 'total', round(sum(out.values()), 1))
