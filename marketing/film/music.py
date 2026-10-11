"""Generates the Opaya film soundtrack (85 s, 120 BPM, A minor), synced to the scene timeline."""
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve
from scipy.io import wavfile

SR = 44100
DUR = 85.0
N = int(SR * DUR)
rng = np.random.default_rng(3)
L = np.zeros(N); Rr = np.zeros(N)
BEAT = 0.5

def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)
def bp(x, a, b, o=2): return sosfilt(butter(o, [a, b], 'band', fs=SR, output='sos'), x)
def env_at(t, a, b):  # 0..1 ramp
    return np.clip((t - a) / (b - a), 0, 1)

def add(sig, t0, gain=1.0, pan=0.0):
    i = int(t0 * SR)
    if i >= N: return
    sig = sig[: N - i]
    l = np.cos((pan + 1) * np.pi / 4); r = np.sin((pan + 1) * np.pi / 4)
    L[i:i + len(sig)] += sig * gain * l * 1.41
    Rr[i:i + len(sig)] += sig * gain * r * 1.41

def tt(d): return np.arange(int(d * SR)) / SR
def hz(m): return 440 * 2 ** ((m - 69) / 12)

def saw(f, d, detune=0.0):
    t = tt(d); ph = (t * f * (1 + detune)) % 1.0
    return 2 * ph - 1

def kick(d=0.5, punch=1.0):
    t = tt(d); f = 45 + 110 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = np.sin(ph) * np.exp(-t * 7) * punch
    click = hp(rng.standard_normal(len(t)), 3000) * np.exp(-t * 180) * .25
    return np.tanh((s + click) * 1.6)

def clap(d=0.35):
    t = tt(d); n = rng.standard_normal(len(t))
    e = np.exp(-t * 18) + .6 * np.exp(-((t - .012) * 400) ** 2) + .5 * np.exp(-((t - .024) * 400) ** 2)
    return bp(n, 900, 4500) * e * .9

def hat(d=0.09, open_=False):
    t = tt(d if not open_ else .3); n = rng.standard_normal(len(t))
    return hp(n, 7000, 4) * np.exp(-t * (55 if not open_ else 12)) * .5

def pluck(m, d=0.45, bright=4000):
    t = tt(d); f = hz(m)
    s = (np.sin(2 * np.pi * f * t) + .5 * np.sign(np.sin(2 * np.pi * f * t)) * .5 + .3 * np.sin(4 * np.pi * f * t))
    return lp(s * np.exp(-t * 9), bright)

def pad(notes, d, cutoff=1800, att=0.6):
    t = tt(d); s = np.zeros(len(t))
    for m in notes:
        for dt in (-0.006, 0, 0.007):
            s += saw(hz(m), d, dt)
    s = lp(s / (len(notes) * 3), cutoff, 2)
    e = np.minimum(1, t / att) * np.minimum(1, (d - t) / 0.4).clip(0, 1)
    return s * e

def boom(d=4.0):
    t = tt(d); f = 32 + 60 * np.exp(-t * 6)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.3)
    n = lp(rng.standard_normal(len(t)), 1200) * np.exp(-t * 3) * .5
    return np.tanh((s + n) * 1.8)

def crash(d=3.0):
    t = tt(d); return hp(rng.standard_normal(len(t)), 4000) * np.exp(-t * 1.6) * .35

def riser(d):
    t = tt(d); n = rng.standard_normal(len(t))
    out = np.zeros(len(t)); seg = int(SR * .05)
    for i in range(0, len(t), seg):  # sweeping band
        k = i / len(t); c = 300 + 7000 * k ** 2
        out[i:i + seg] = bp(n[i:i + seg], c * .7, min(c * 1.4, 19000))
    return out * (t / d) ** 2 * .6

def whoosh(d=1.2):
    t = tt(d); n = rng.standard_normal(len(t)); out = np.zeros(len(t)); seg = int(SR * .03)
    for i in range(0, len(t), seg):
        k = i / len(t); c = 400 + 5000 * np.sin(np.pi * k)
        out[i:i + seg] = bp(n[i:i + seg], c * .6, min(c * 1.5, 19000))
    return out * np.sin(np.pi * t / d) ** 2 * .45

def blip(m):
    t = tt(.12); return np.sin(2 * np.pi * hz(m) * t) * np.exp(-t * 40) * .25

# chord progression: Am F C G (2 bars = 4 s each)
CH = [[57, 60, 64], [53, 57, 60], [48, 52, 55, 60], [55, 59, 62]]
ROOT = [45, 41, 48, 43]
def chord_at(t): return int((t // 4) % 4)

# ---------- 0 - 12.4 tension ----------
add(lp(saw(hz(33), 12.6) + saw(hz(33), 12.6, .004), 220) * np.minimum(1, tt(12.6) / 3) * .35, 0, 1)
for i, tb in enumerate(np.arange(0, 12.4, BEAT)):
    k = tb / 12.4
    add(kick(.4, .5 + .5 * k), tb, .35 + .4 * k)
    if tb > 4:
        for s in (0, .25): add(hat(), tb + s, .15 + .35 * k, .3 if s else -.3)
for i in range(14):  # terminal blips as windows pop
    add(blip([81, 84, 88, 76, 79][i % 5]), 0.6 + i * 0.62, .9, (i % 3 - 1) * .6)
add(riser(4.3), 8.1, 1.0)
add(pad([57, 60, 63], 5, 900, 2.5), 7.4, .35)  # dissonant swell

# ---------- 12.4 impact ----------
add(boom(5), 12.4, 1.1); add(crash(4), 12.4, 1.0, .2); add(crash(4), 12.42, .8, -.2)

# ---------- 12.4 - 20 reveal: pad + arp ----------
add(pad([45, 57, 60, 64], 4.0, 1400, 1.0), 12.4, .5)
add(pad([41, 57, 60, 65], 4.0, 1600), 16.4, .5)
ARP = [0, 1, 2, 1]
def arp(t0, t1, gain=.22, bright=3500):
    for tb in np.arange(t0, t1, .125):
        c = CH[chord_at(tb - 12.4)]; idx = int(round((tb - t0) / .125))
        m = c[ARP[idx % 4] % len(c)] + 12 * (1 if (idx // 4) % 2 else 0)
        add(pluck(m, .4, bright), tb, gain, np.sin(idx * .7) * .5)
arp(14.4, 20.0, .16, 2500)

# ---------- 20 - 75 groove ----------
for tb in np.arange(20.0, 75.0, BEAT):
    add(kick(), tb, .85)
    if int(round(tb / BEAT)) % 2 == 1: add(clap(), tb, .45, .05)
    add(hat(), tb + .25, .3, .25)
    if tb > 31: add(hat(), tb + .125, .12, -.3); add(hat(), tb + .375, .12, -.3)
    # bass: 8ths on root
    r = ROOT[chord_at(tb - 12.4)]
    for s in (0, .25):
        t = tt(.24); f = hz(r - 12 if s == 0 else r)
        b = lp(saw(f, .24) + saw(f, .24, .003), 600 + 600 * (tb > 40)) * np.exp(-t * 6) * .55
        add(b, tb + s, .8)
for t0 in np.arange(20.4, 75.0, 4.0):
    c = CH[chord_at(t0 - 12.4)]
    add(pad([c[0] - 12] + c, min(4.0, 75 - t0), 1500 + 900 * (t0 > 40), .4), t0, .32)
arp(20.0, 75.0, .15, 3200)
# section whooshes
for tw in (19.6, 30.8, 40.2, 48.3, 55.9, 62.9, 70.4):
    add(whoosh(1.4), tw, 1.0, .0)
for tw in (31.6, 40.9, 48.9, 56.4, 63.4):
    add(crash(1.8), tw + .9, .35)

# ---------- 75 - 79.4 slams + riser ----------
for i, ts in enumerate((75.3, 75.9, 76.5)):
    add(kick(.6, 1.3), ts, 1.0); add(boom(1.2), ts, .6)
    c = [57, 60, 64] if i < 2 else [57, 60, 64, 69]
    add(pad([m - 12 for m in c] + c, .55, 3000, .005), ts, .7)
    add(crash(1.2), ts, .4)
add(riser(2.9), 77.35, 1.0)

# ---------- 80.25 final ----------
add(boom(4.5), 80.25, 1.1); add(crash(4.5), 80.25, .9)
add(pad([45, 57, 60, 64, 69], 4.75, 1700, .2), 80.25, .65)
arp(80.25, 84.0, .12, 2600)

# ---------- master ----------
mix = np.stack([L, Rr], 1)
# reverb
ir_t = tt(2.6); ir = rng.standard_normal((len(ir_t), 2)) * np.exp(-ir_t * 2.4)[:, None]
ir[:, 0] = lp(ir[:, 0], 5000); ir[:, 1] = lp(ir[:, 1], 5000)
wet = np.stack([fftconvolve(mix[:, c], ir[:, c])[:N] for c in range(2)], 1)
mix = mix + wet * (0.18 / np.abs(wet).max() * np.abs(mix).max())
mix = hp(mix.T, 28).T
mix /= np.abs(mix).max() + 1e-9
mix = np.tanh(mix * 1.6) / np.tanh(1.6)
# fades
t = np.arange(N) / SR
mix *= (np.clip(t / .3, 0, 1) * np.clip((DUR - t) / 1.4, 0, 1))[:, None]
mix *= .89
wavfile.write('music.wav', SR, (mix * 32767).astype(np.int16))
print('ok', mix.shape)
