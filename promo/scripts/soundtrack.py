#!/usr/bin/env python3
"""
agent-city launch film: score and sound design, synthesized from oscillators and noise.

Reads out/cues.json (exported from the picture's timeline) so every key click, tool blip,
subagent ping and drop lands on its frame. Writes public/audio/soundtrack.wav (48 kHz stereo).
120 BPM, F minor (i – VI – III – VII), one chord per bar. Deterministic (seeded).
"""
import json
import os

import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from scipy import signal

SR = 48000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
C = json.load(open(os.path.join(ROOT, 'out', 'cues.json')))
FPS, BPM = C['fps'], C['bpm']
CUE = C['cues']
DUR = C['total'] / FPS
N = int(DUR * SR)
BEAT = 60 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(11)


def fr(frame):
    return frame / FPS


def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def tt(d):
    return np.arange(int(d * SR)) / SR


def buf():
    return np.zeros((N, 2))


def place(dst, x, t, gain=1.0, pan=0.0):
    i = int(round(t * SR))
    if i >= N:
        return
    if x.ndim == 1:
        a = (pan + 1) * np.pi / 4
        x = np.stack([x * np.cos(a), x * np.sin(a)], axis=1)
    if i < 0:
        x, i = x[-i:], 0
    n = min(len(x), N - i)
    dst[i:i + n] += x[:n] * gain


def lp(x, f, order=2):
    return signal.sosfilt(signal.butter(order, min(f, SR * 0.45), 'low', fs=SR, output='sos'), x, axis=0)


def hp(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, 'high', fs=SR, output='sos'), x, axis=0)


def bp(x, lo, hi):
    return signal.sosfilt(signal.butter(2, [lo, hi], 'band', fs=SR, output='sos'), x, axis=0)


def env(n, a=0.005, r=0.2, hold=0.0):
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4))
    return e * np.where(t < a + hold, 1, np.exp(-(t - a - hold) / r))


def saw(f, t, phase=0.0):
    return 2 * ((f * t + phase) % 1) - 1


def supersaw(f, d, voices=5, detune=0.12):
    t = tt(d)
    out = sum(saw(f * 2 ** ((v - (voices - 1) / 2) * detune / 12 / 2), t, rng.random()) for v in range(voices))
    return out / voices


# F minor: i – VI – III – VII  (Fm, Db, Ab, Eb)
CHORDS = [[53, 56, 60], [49, 53, 56], [56, 60, 63], [51, 55, 58]]
ROOTS = [41, 37, 44, 39]


def chord_at(t):
    return int(t // BAR) % 4


# ---------------------------------------------------------------------------------------
pad, bass, drums, arp, fx = buf(), buf(), buf(), buf(), buf()
kicks = []

# Pad: whole film, dark and filtered, opens up with the city.
bars = int(np.ceil(DUR / BAR))
for bar in range(bars):
    t0 = bar * BAR
    ch = CHORDS[bar % 4]
    x = sum(supersaw(mtof(m), BAR + 0.4, 5, 0.18) for m in ch) / 3
    x += 0.5 * np.sin(2 * np.pi * mtof(ch[0] - 12) * tt(BAR + 0.4))
    bright = 380 if t0 < fr(CUE['enter']) else 900 if t0 < fr(CUE['reveal']) else 2200 if t0 < fr(CUE['subsDone']) else 700
    x = lp(x, bright, 2) * env(len(x), 0.25, 0.5, BAR - 0.3)
    place(pad, x, t0, 0.22, 0)

# Bass: 8ths from the enter, root of each chord, sidechained by the kick later.
for k in range(int((fr(CUE['allDone']) - fr(CUE['enter'])) / (BEAT / 2))):
    t0 = fr(CUE['enter']) + k * BEAT / 2
    m = ROOTS[chord_at(t0)] - (0 if k % 2 else 12)
    d = BEAT / 2 * 0.9
    x = saw(mtof(m), tt(d)) + 0.6 * np.sin(2 * np.pi * mtof(m) * tt(d))
    cut = 500 if t0 < fr(CUE['reveal']) else 1200
    x = lp(x * env(len(x), 0.004, 0.12, 0.05), cut, 2)
    place(bass, x, t0, 0.33)

# Kick + hats: four on the floor from the reveal until everything's done.
def kick():
    t = tt(0.45)
    f = 45 + 110 * np.exp(-t / 0.03)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t / 0.16) + 0.25 * lp(rng.standard_normal(len(t)), 3000) * np.exp(-t / 0.008)


def hat(open_=False):
    n = int((0.18 if open_ else 0.05) * SR)
    return hp(rng.standard_normal(n), 7000) * env(n, 0.001, 0.06 if open_ else 0.015)


t = fr(CUE['reveal'])
while t < fr(CUE['allDone']) - 0.01:
    place(drums, kick(), t, 0.85)
    kicks.append(t)
    place(drums, hat(True), t + BEAT / 2, 0.10, 0.3)
    for q in (0.25, 0.75):
        place(drums, hat(), t + BEAT * q, 0.06, -0.3)
    t += BEAT

# Arp: 16ths from the first subagent, pluck through the chord tones, gets brighter per subagent.
t = fr(CUE['sub'][0])
i = 0
while t < fr(CUE['allDone']):
    ch = CHORDS[chord_at(t)]
    notes = [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[1] + 24]
    m = notes[i % 4]
    subs = sum(1 for s in CUE['sub'] if fr(s) <= t)
    d = BEAT / 4
    x = (saw(mtof(m), tt(d)) + saw(mtof(m) * 1.004, tt(d))) / 2
    x = lp(x * env(len(x), 0.002, 0.07), 900 + 500 * subs, 2)
    place(arp, x, t, 0.14, 0.45 if i % 2 else -0.45)
    t += d
    i += 1

# Key clicks while the prompt is typed.
n_chars = 70
for k in range(n_chars):
    tk = fr(CUE['typeStart']) + (fr(CUE['typeEnd']) - fr(CUE['typeStart'])) * k / n_chars + rng.uniform(-0.01, 0.01)
    n = int(0.03 * SR)
    x = bp(rng.standard_normal(n), 1800, 6000) * env(n, 0.0005, 0.006)
    place(fx, x, tk, 0.11 * rng.uniform(0.7, 1.1), rng.uniform(-0.2, 0.2))


def boom(d=2.5, f0=38):
    t = tt(d)
    f = f0 + 60 * np.exp(-t / 0.08)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.7)
    return x + 0.4 * lp(rng.standard_normal(len(t)), 900) * np.exp(-t / 0.25)


def riser(d):
    t = tt(d)
    x = rng.standard_normal(len(t))
    out = np.zeros_like(x)
    for j in range(8):  # sweep a band upward in chunks
        a, b = j * len(t) // 8, (j + 1) * len(t) // 8
        lo = 300 * 2 ** (j * 0.6)
        out[a:b] = bp(x[a:b], lo, lo * 3)
    return out * (t / d) ** 2


def bell(m, d=1.2):
    t = tt(d)
    mod = np.sin(2 * np.pi * mtof(m) * 3.5 * t) * 2.2 * np.exp(-t / 0.2)
    return np.sin(2 * np.pi * mtof(m) * t + mod) * np.exp(-t / 0.45)


# Enter: riser into a thock and a low boom.
place(fx, riser(1.0), fr(CUE['enter']) - 1.0, 0.18)
n = int(0.08 * SR)
place(fx, lp(rng.standard_normal(n), 1400) * env(n, 0.001, 0.02), fr(CUE['enter']), 0.5)
place(fx, boom(2.0, 42), fr(CUE['enter']), 0.5)
# Tool calls: soft blips.
for key, m in (('tool1', 84), ('tool2', 87), ('plan', 91)):
    place(fx, bell(m, 0.5), fr(CUE[key]), 0.08, 0.2)
# Reveal: riser + drop.
place(fx, riser(2.0), fr(CUE['reveal']) - 2.0, 0.3)
place(fx, boom(3.0, 36), fr(CUE['reveal']), 0.8)
n = int(1.6 * SR)
place(fx, hp(rng.standard_normal(n), 3000) * env(n, 0.002, 0.5), fr(CUE['reveal']), 0.16)
# Each subagent: an ascending ping up the F minor scale.
scale = [72, 75, 77, 79, 80, 84]
for s, m in zip(CUE['sub'], scale):
    place(fx, bell(m, 1.4), fr(s), 0.13, rng.uniform(-0.5, 0.5))
# Done: a bright resolved chord.
for m in (65, 68, 72, 77):
    place(fx, bell(m, 2.5), fr(CUE['allDone']) + (m - 65) * 0.012, 0.09)
# End card: resolve to A♭ major, boom, long pad.
place(fx, boom(4.0, 34), fr(CUE['end']), 0.7)
end_len = DUR - fr(CUE['end'])
x = sum(supersaw(mtof(m), end_len, 7, 0.2) for m in (44, 56, 60, 63, 68)) / 5
x = lp(x, 1600, 2) * env(len(x), 0.02, 1.8, 1.2)
place(fx, x, fr(CUE['end']), 0.3)
place(fx, bell(80, 3.0), fr(CUE['url']), 0.07)

# ---------------------------------------------------------------------------------------
# Sidechain pad/bass/arp to the kick.
duck = np.ones(N)
for k in kicks:
    i = int(k * SR)
    n = min(int(0.3 * SR), N - i)
    duck[i:i + n] = np.minimum(duck[i:i + n], 1 - 0.6 * np.exp(-np.arange(n) / SR / 0.09))
duck = duck[:, None]

music = pad * duck + bass * duck + arp * duck + drums

# Reverb: exponentially decaying stereo noise IR.
ir_t = tt(2.2)
ir = rng.standard_normal((len(ir_t), 2)) * np.exp(-ir_t / 0.55)[:, None]
ir = lp(ir, 5000)
send = (pad * 0.5 + arp + fx) * 0.2
wet = np.stack([signal.fftconvolve(send[:, c], ir[:, c])[:N] for c in range(2)], axis=1) * 0.06

mix = music + fx + wet
mix = hp(mix, 25)
# Fade the tail.
fade = int(1.2 * SR)
mix[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 2

# Master: loudness to -14 LUFS, soft clip to keep peaks under -1 dBFS.
meter = pyln.Meter(SR)
mix = pyln.normalize.loudness(mix, meter.integrated_loudness(mix), -14.0)
ceiling = 10 ** (-1.2 / 20)
mix = np.tanh(mix / ceiling) * ceiling

os.makedirs(os.path.join(ROOT, 'public', 'audio'), exist_ok=True)
out = os.path.join(ROOT, 'public', 'audio', 'soundtrack.wav')
sf.write(out, mix.astype(np.float32), SR, subtype='FLOAT')
print(f'wrote {out}  {DUR:.1f}s  {meter.integrated_loudness(mix):.1f} LUFS  peak {20 * np.log10(np.abs(mix).max()):.1f} dBFS')
