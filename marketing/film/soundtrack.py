"""Opaya film soundtrack: voice over (Kokoro TTS lines in vo/) + sound design synced to the scene timeline.
Optional: python3 soundtrack.py path/to/music.wav  mixes a licensed music bed under everything, ducked under the voice."""
import sys, glob
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt, fftconvolve, resample_poly

SR = 44100
DUR = 85.0
N = int(SR * DUR)
rng = np.random.default_rng(5)
FX = np.zeros((N, 2))
VO = np.zeros((N, 2))

def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)
def bp(x, a, b, o=2): return sosfilt(butter(o, [a, b], 'band', fs=SR, output='sos'), x)
def tt(d): return np.arange(int(d * SR)) / SR
def hz(m): return 440 * 2 ** ((m - 69) / 12)

def add(buf, sig, t0, gain=1.0, pan=0.0):
    i = int(t0 * SR)
    if i >= N or i < 0: return
    sig = sig[: N - i]
    buf[i:i + len(sig), 0] += sig * gain * np.cos((pan + 1) * np.pi / 4) * 1.41
    buf[i:i + len(sig), 1] += sig * gain * np.sin((pan + 1) * np.pi / 4) * 1.41

def sweep_noise(d, f0, f1, q=.5):
    t = tt(d); n = rng.standard_normal(len(t)); out = np.zeros(len(t)); seg = int(SR * .02)
    for i in range(0, len(t), seg):
        k = i / len(t); c = f0 * (f1 / f0) ** k
        out[i:i + seg] = bp(n[i:i + seg], max(30, c * (1 - q)), min(c * (1 + q), 19000))
    return out

def whoosh(d=.9, up=True):
    t = tt(d); s = sweep_noise(d, 300 if up else 4000, 4000 if up else 300)
    return s * np.sin(np.pi * t / d) ** 2 * .5

def boom(d=3.5, f=48):
    t = tt(d); fr = f * .7 + f * 1.4 * np.exp(-t * 7)
    s = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t * 1.6)
    n = lp(rng.standard_normal(len(t)), 900) * np.exp(-t * 5) * .6
    return np.tanh((s + n) * 1.6)

def click(f=2200, d=.05):
    t = tt(d); return np.sin(2 * np.pi * f * t) * np.exp(-t * 90) * .6 + hp(rng.standard_normal(len(t)), 3000) * np.exp(-t * 300) * .3

def blip(m, d=.18, wave='sine'):
    t = tt(d); s = np.sin(2 * np.pi * hz(m) * t)
    if wave == 'square': s = np.sign(s) * .5
    return lp(s, 5000) * np.exp(-t * 22) * .4

def chime(notes, d=2.2, bright=1.0):
    t = tt(d); s = np.zeros(len(t))
    for i, m in enumerate(notes):
        f = hz(m); s += (np.sin(2 * np.pi * f * t) + .35 * np.sin(2 * np.pi * f * 2.01 * t) * bright + .12 * np.sin(2 * np.pi * f * 3.98 * t) * bright) * np.exp(-t * (2.2 + i * .3))
    return s / len(notes) * .7

def ping(f=1400, d=1.6):  # sonar
    t = tt(d); s = np.sin(2 * np.pi * f * t) * np.exp(-t * 3.2)
    return s * .35 + np.sin(2 * np.pi * f * 1.5 * t) * np.exp(-t * 6) * .1

def riser(d):
    t = tt(d); return sweep_noise(d, 200, 9000, .35) * (t / d) ** 2.2 * .7

def sparkle(d=1.0, n=14):
    out = np.zeros(int(d * SR))
    for k in range(n):
        m = rng.choice([84, 86, 88, 91, 93, 96]); s = blip(m, .25) * .5; i = int(rng.uniform(0, d - .25) * SR)
        out[i:i + len(s)] += s
    return out

def thunk(): t = tt(.35); return lp(rng.standard_normal(len(t)), 400) * np.exp(-t * 18) + np.sin(2 * np.pi * 90 * t) * np.exp(-t * 14) * .8

def pad(notes, d, cutoff=1600, att=1.2, rel=1.5):
    t = tt(d); s = np.zeros(len(t))
    for m in notes:
        for det in (-.004, 0, .005):
            ph = (t * hz(m) * (1 + det)) % 1.0; s += 2 * ph - 1
    s = lp(s / (len(notes) * 3), cutoff)
    return s * np.minimum(1, t / att) * np.clip((d - t) / rel, 0, 1)

def alarm(d):
    t = tt(d); s = np.sin(2 * np.pi * 880 * t) * (np.sin(2 * np.pi * 2.5 * t) > 0) * .18
    return lp(s, 3000) * np.exp(-t * .15)

# ---------------- scene A: chaos ----------------
t = tt(13.2); drone = lp(rng.standard_normal(len(t)), 120) * 2.2 + np.sin(2 * np.pi * 55 * t) * .25 * (1 + .3 * np.sin(2 * np.pi * .3 * t))
add(FX, drone * np.minimum(1, t / 2) * np.clip((13.2 - t) / .3, 0, 1) * (.5 + .5 * t / 13.2), 0, .5)
for i, t0 in enumerate([.2, 1.8, 3.4] + [6.5 + k * .32 for k in range(9)]):
    add(FX, blip([79, 83, 86, 81, 88][i % 5], .14, 'square'), t0, .55, (i % 3 - 1) * .5)
for t0 in (2.6, 4.15, 6.2): add(FX, whoosh(.8), t0, .7)
for i, t0 in enumerate(np.arange(7.9, 9.2, .18)): add(FX, click(3200 + i * 120, .06), t0, .35, (i % 2) * .6 - .3)  # keys
for t0 in np.arange(9.5, 12.9, .25): add(FX, click(1200, .04), t0, .18 + .25 * (t0 - 9.5) / 3.4)  # tension ticks
add(FX, riser(1.9), 11.15, .9)
add(FX, whoosh(.6, False), 12.45, .8)
# ---------------- scene B: logo ----------------
add(FX, boom(4.5, 46), 13.05, 1.1); add(FX, hp(rng.standard_normal(int(SR * 2.5)), 5000) * np.exp(-tt(2.5) * 2) * .35, 13.05, .8)
add(FX, sweep_noise(1.6, 3000, 300) * np.exp(-tt(1.6) * 1.5) * .5, 13.3, .6)  # windows sucked in
add(FX, chime([69, 76, 81, 85], 3.5, .8), 14.25, .55)
add(FX, pad([57, 64, 69, 73, 76], 6.0, 1400, 1.5, 2.0), 14.2, .16)
# ---------------- scene C: discover ----------------
add(FX, whoosh(1.1), 19.9, .6)
for t0, f in ((22.4, 1300), (24.0, 1500), (25.8, 1750)): add(FX, ping(f, 1.8), t0, .8)
for i, t0 in enumerate((22.7, 22.9, 24.3, 26.1)): add(FX, chime([81 + [0, 4, 7, 12][i]], .8), t0, .45, [-.5, -.3, .5, 0][i])
for i in range(4):
    t0 = 27.1 + i * .22; add(FX, whoosh(1.2), t0, .35, [-.6, -.3, .6, 0][i]); add(FX, blip(88 + i * 2, .2), t0 + 1.2, .5)
add(FX, pad([57, 64, 69, 73], 5.0, 1200, 1.5, 1.5), 26.5, .1)
# ---------------- scene D: one window ----------------
add(FX, whoosh(1.0), 30.6, .6)
for i, t0 in enumerate((31.6, 32.1, 32.6, 33.1)): add(FX, thunk(), t0, .35); add(FX, click(1800 + i * 300, .05), t0, .3)
for k in range(30): add(FX, click(2600 + (k % 5) * 100, .03), 32.1 + k * .045, .08)  # typing
add(FX, whoosh(.6), 34.6, .5); add(FX, thunk(), 35.3, .3)
for k in range(10): add(FX, click(4200, .02), 33.3 + k * .4, .07)  # terminal lines
# ---------------- scene E: clone ----------------
add(FX, whoosh(1.1), 40.4, .6)
add(FX, click(1400, .06), 43.06, .6); add(FX, sweep_noise(1.4, 500, 2500) * np.sin(np.pi * tt(1.4) / 1.4) * .25, 43.1, .6)
add(FX, thunk(), 44.6, .55); add(FX, ping(2000, .7), 44.62, .3)
add(FX, sparkle(2.6, 26), 45.0, .55)
add(FX, boom(2.2, 70), 47.6, .45); add(FX, chime([76, 81, 85, 88], 2.6), 47.6, .6)
# ---------------- scene F: vault ----------------
add(FX, whoosh(1.0), 51.3, .6)
for i in range(5): add(FX, chime([93 + (i % 3) * 2], .5, .6), 52.5 + i * .3 + .9, .3, -.3)
add(FX, thunk(), 54.0, .8); add(FX, boom(1.4, 60), 54.3, .5)
for k in range(10): add(FX, click(900, .05), 54.0 + k * .08, .25)  # lock dial
for i in range(3): add(FX, blip(81 + i * 4, .3), 55.8 + i * .3, .4, .5)
add(FX, sweep_noise(.5, 6000, 900) * np.exp(-tt(.5) * 6) * .6, 57.95, .7); add(FX, click(600, .1), 57.95, .7)  # shield zap
# ---------------- scene G: 2 a.m. ----------------
add(FX, whoosh(1.1, False), 59.7, .5)
add(FX, alarm(4.8), 60.6, .55)
add(FX, whoosh(1.1), 63.3, .55)
for k in range(3): add(FX, ping(900 + k * 150, .6), 64.2 + k * .4, .35)
add(FX, boom(2.0, 64), 65.4, .5); add(FX, chime([74, 79, 83, 86], 2.4), 65.4, .6)
for k in range(40): add(FX, click(2700 + (k % 4) * 90, .025), 66.3 + k * .055, .06)
# ---------------- scene H: privacy ----------------
add(FX, whoosh(1.1), 69.9, .5)
for t0 in (71.2, 72.14, 72.9):
    add(FX, boom(1.1, 55), t0, .75); add(FX, sweep_noise(.4, 5000, 700) * np.exp(-tt(.4) * 7) * .7, t0 + .35, .6)
add(FX, pad([57, 64, 69, 73, 76], 5.0, 1300, 1.0, 1.2), 73.6, .14)
# ---------------- scene I: outro ----------------
add(FX, riser(1.5), 78.5, .8)
add(FX, boom(5.0, 44), 80.0, 1.1); add(FX, chime([57, 64, 69, 73, 76, 81], 4.5, .7), 80.0, .7)
add(FX, pad([45, 57, 64, 69, 73, 76], 5.0, 1700, .3, 2.5), 80.0, .3)

# ---------------- ambient bed (no beat, very low) ----------------
BED = [(13.0, [45, 57, 64, 69, 73]), (20.5, [42, 54, 61, 66, 69]), (30.6, [38, 50, 57, 62, 66]), (40.4, [40, 52, 59, 64, 68]),
       (51.3, [45, 57, 64, 69, 72]), (59.7, [41, 53, 60, 65, 69]), (69.9, [43, 55, 62, 67, 71]), (78.5, [45, 57, 64, 69, 73])]
for i, (t0, ch) in enumerate(BED):
    t1 = BED[i + 1][0] if i + 1 < len(BED) else 85.0
    add(FX, pad(ch, t1 - t0 + 1.2, 900, 1.2, 1.2), t0, .22)
air = hp(rng.standard_normal(N), 6000) * .015
FX[:, 0] += air; FX[:, 1] += np.roll(air, 977)

# ---------------- voice over ----------------
VO_AT = [0.8, 6.6, 14.2, 15.9, 21.0, 32.0, 41.2, 52.2, 61.3, 71.2, 79.6]
for i, t0 in enumerate(VO_AT):
    a, sr = sf.read(f'vo/{i:02d}.wav')
    if a.ndim > 1: a = a.mean(1)
    a = resample_poly(a, SR, sr) if sr != SR else a
    a = hp(a, 80); a = a / (np.abs(a).max() + 1e-9) * .9
    add(VO, a, t0, 1.0, 0)
# warmth: gentle compression on the voice
env = np.sqrt(np.maximum(lp(VO[:, 0] ** 2, 8), 0))
gain = 1 / np.maximum(1, (env / .25) ** .5)
VO *= gain[:, None]

# small room on the effects
ir_t = tt(1.8); ir = rng.standard_normal((len(ir_t), 2)) * np.exp(-ir_t * 3.2)[:, None]
for c in range(2): ir[:, c] = lp(ir[:, c], 6000)
wet = np.stack([fftconvolve(FX[:, c], ir[:, c])[:N] for c in range(2)], 1)
FX = FX + wet * (.12 * np.abs(FX).max() / (np.abs(wet).max() + 1e-9))

# duck effects under the voice
venv = np.sqrt(np.maximum(lp(VO.mean(1) ** 2, 4), 0)); duck = 1 - .45 * np.clip(venv / .08, 0, 1)
mix = FX * .55 * duck[:, None] + VO * 1.0

if len(sys.argv) > 1:  # optional licensed music bed
    m, msr = sf.read(sys.argv[1])
    if m.ndim == 1: m = np.stack([m, m], 1)
    if msr != SR: m = np.stack([resample_poly(m[:, c], SR, msr) for c in range(2)], 1)
    m = m[:N]; m = np.pad(m, ((0, N - len(m)), (0, 0)))
    m = m / (np.abs(m).max() + 1e-9) * .35
    mix += m * (1 - .55 * np.clip(venv / .08, 0, 1))[:, None]

mix = hp(mix.T, 30).T
mix /= np.abs(mix).max() + 1e-9
mix = np.tanh(mix * 1.3) / np.tanh(1.3) * .92
t = np.arange(N) / SR
mix *= (np.clip(t / .2, 0, 1) * np.clip((DUR - t) / 1.2, 0, 1))[:, None]
sf.write('soundtrack.wav', mix.astype(np.float32), SR, subtype='PCM_16')
print('ok')
