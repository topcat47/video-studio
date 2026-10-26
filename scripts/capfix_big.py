#!/usr/bin/env python3
"""Replace the swap model's redrawn captions with the source's captions.

capfix.py <swap_rt.mp4> <src30.mp4> <src_start_frame> <out.mp4> [--y0 F --y1 F] [--debug DIR --dbg-frames 10,50]

swap_rt.mp4 is the swap output already stretched to real time, 30 fps, 1080x1920,
frame-aligned with src30.mp4 starting at src_start_frame.

Erases the model's caption text (clone-stamp from the fur below, Poisson-blended) and
lays the source's letters back on with a soft shadow and their own neon glow.
--deglow strips the model's neon tint from white fur (white cats only, not tabby fur).
--erase-only removes captions without restoring (for reusing swap footage).

Setup (needs numpy + OpenCV):  python3 -m venv <scratch>/venv && <scratch>/venv/bin/pip install numpy opencv-python-headless
Real-time input:  ffmpeg -i out.mp4 -vf "setpts=PTS*(real_s/out_s),fps=30,scale=1080:1920,tpad=stop_mode=clone:stop=15,trim=end_frame=N" ...
First used 2026-10-18 on the OwenBusicknr2d Hello Kitty cereal swap.
"""
import argparse, os, subprocess
from collections import defaultdict
import numpy as np, cv2

ap = argparse.ArgumentParser()
ap.add_argument('swap'); ap.add_argument('src'); ap.add_argument('start', type=int); ap.add_argument('out')
ap.add_argument('--y0', type=float, default=0.40); ap.add_argument('--y1', type=float, default=0.58)
ap.add_argument('--th', type=int, default=40, help='top-hat threshold')
ap.add_argument('--white', type=int, default=205, help='min channel for white text')
ap.add_argument('--erase-grow', type=int, default=16)
ap.add_argument('--shadow', type=float, default=0.55)
ap.add_argument('--erase-only', action='store_true', help='only remove the model captions')
ap.add_argument('--deglow', action='store_true', help='remove neon caption tint from white fur')
ap.add_argument('--debug'); ap.add_argument('--dbg-frames', default='')
args = ap.parse_args()

TOPHAT_K = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (51, 51))


def text_mask(img, y0, y1):
    """Mask of caption glyphs (white or vivid-coloured, thin, chained in rows) inside rows y0..y1."""
    band = img[y0:y1]
    V = band.max(axis=2); mn = band.min(axis=2)
    Y = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
    # contrast on several channels: over a red shirt the max channel is as bright as the text,
    # but luma and the min channel still separate white/yellow letters from it
    th = np.maximum.reduce([cv2.morphologyEx(c, cv2.MORPH_TOPHAT, TOPHAT_K) for c in (V, Y, mn)])
    white = mn > args.white
    vivid = (V > 180) & ((V.astype(np.int16) - mn) > 80)
    cand = ((th > args.th) & (white | vivid)).astype(np.uint8)
    cand = cv2.morphologyEx(cand, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(cand, 8)
    comps = [(i, *st[i][:4]) for i in range(1, n)
             if st[i][4] >= 15 and 8 <= st[i][3] <= 120 and st[i][2] <= 670]
    parent = list(range(len(comps)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for a in range(len(comps)):
        _, xa, ya, wa, ha = comps[a]
        for b in range(a + 1, len(comps)):
            _, xb, yb, wb, hb = comps[b]
            if abs((ya + ha / 2) - (yb + hb / 2)) > 38:
                continue
            if max(xb - (xa + wa), xa - (xb + wb)) > 67:
                continue
            parent[find(a)] = find(b)
    clusters = defaultdict(list)
    for k, c in enumerate(comps):
        clusters[find(k)].append(c[0])
    keep = np.zeros(n, np.uint8)
    W = img.shape[1]
    for ids in clusters.values():
        # whole words can fuse into one blob through their glow (e.g. over a red shirt):
        # also accept 1-2 caption-height, word-sized, text-dense blobs near the centre
        hs = st[ids, 3]; ws = st[ids, 2]
        x0c = st[ids, 0].min(); x1c = (st[ids, 0] + ws).max()
        fill = st[ids, 4].sum() / max(1, (ws * hs).sum())
        wordlike = (hs.min() >= 45 and hs.max() <= 100 and ws.sum() >= 176 and 0.25 <= fill <= 0.8
                    and abs((x0c + x1c) / 2 - W / 2) < 416)
        if len(ids) >= 3 or wordlike:
            keep[ids] = 1
    full = np.zeros(img.shape[:2], np.uint8)
    full[y0:y1] = keep[lab]
    return full


def read_all(path):
    cap = cv2.VideoCapture(path); fr = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        fr.append(f)
    return fr


swap = read_all(args.swap)
cap = cv2.VideoCapture(args.src); cap.set(cv2.CAP_PROP_POS_FRAMES, args.start)
src = []
for _ in range(len(swap)):
    ok, f = cap.read()
    if not ok:
        break
    src.append(f)
assert len(src) == len(swap), (len(src), len(swap))
H, W = swap[0].shape[:2]
y0, y1 = int(args.y0 * H), int(args.y1 * H)

mo = [text_mask(f, y0, y1) for f in swap]      # model's captions
ms = [text_mask(f, y0, y1) for f in src]       # source captions


def strict_colour(img):
    """Only pure caption colours (white / yellow / bright red), so skin and nail polish
    in the source never get pasted onto the cat."""
    b, g, r = [img[..., k].astype(np.int16) for k in range(3)]
    mn = np.minimum(np.minimum(b, g), r); mx = np.maximum(np.maximum(b, g), r)
    white = (mn > 185) & (mx - mn < 50)
    yellow = (r > 185) & (g > 165) & (b < 120) & (r - b > 90)
    red = (r > 175) & (g < 70) & (b < 80)
    k5 = np.ones((5, 5), np.uint8)
    return cv2.dilate((white | yellow | red).astype(np.uint8), k5)


def outlined(m, img):
    """Keep only blobs with the caption's black outline around them (skin/nail specks
    sit on skin, so their surrounding ring is bright)."""
    Y = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    keep = np.zeros(n, np.uint8)
    for i in range(1, n):
        x, y, w, h, _a = st[i]
        x0, y0_, x1, y1_ = max(0, x - 8), max(0, y - 8), min(m.shape[1], x + w + 8), min(m.shape[0], y + h + 8)
        c = (lab[y0_:y1_, x0:x1] == i).astype(np.uint8)
        ring = cv2.dilate(c, np.ones((7, 7), np.uint8)) & ~cv2.dilate(c, np.ones((3, 3), np.uint8)) & 1
        if ring.any() and np.median(Y[y0_:y1_, x0:x1][ring > 0]) < 110:
            keep[i] = 1
    # letters sit in a row: each needs a level neighbour within a word-space (35 px)
    ids = [i for i in range(1, n) if keep[i]]
    medh = np.median([st[i][3] for i in ids]) if ids else 0
    for i in ids:
        xi, yi, wi, hi = st[i][:4]
        small = hi < 0.5 * medh
        ok = False
        for j in ids:
            if j == i:
                continue
            xj, yj, wj, hj = st[j][:4]
            gap = max(xj - (xi + wi), xi - (xj + wj))
            if small:
                # a full stop sits on a letter's baseline, an apostrophe at its top
                if hj >= 0.5 * medh and gap <= 35 and (abs((yi + hi) - (yj + hj)) <= 10 or abs(yi - yj) <= 10):
                    ok = True; break
                continue
            vov = min(yi + hi, yj + hj) - max(yi, yj)
            if gap <= 35 and vov >= 0.5 * min(hi, hj):
                ok = True; break
        if not ok:
            keep[i] = 0
    return keep[lab]


ms_raw = ms
ms_f = [outlined(m & strict_colour(f), f) for m, f in zip(ms, src)]
# frames where a caption slides in are motion-blurred and fail the strict tests: there,
# accept the raw detection but only where nearby frames have clean letters
k31 = np.ones((9, 9), np.uint8)
ms = []
for i in range(len(ms_f)):
    zone = np.zeros_like(ms_f[i])
    for j in range(max(0, i - 4), min(len(ms_f), i + 5)):
        zone |= ms_f[j]
    m = ms_f[i].copy()
    # a caption doesn't move while shown: take clean letters from nearby frames where
    # the source pixels under them are unchanged (white text over a bright mirror is
    # missed by detection in some frames)
    for j in range(max(0, i - 8), min(len(ms_f), i + 9)):
        sel = ms_f[j] > 0
        if j != i and sel.any() and np.abs(src[i][sel].astype(np.int16) - src[j][sel]).mean() < 20:
            m |= ms_f[j]
    ms.append(m)
# Captions are static between changes: where detection is weak (text over a bright
# highlight), borrow the nearest good mask if its pixels are still bright text here.
sums = np.array([m.sum() for m in ms])
borrowed = []
for i in range(len(ms)):
    lo, hi = max(0, i - 6), min(len(ms), i + 7)
    best = sums[lo:hi].max()
    if best == 0 or sums[i] >= 0.6 * best:
        continue
    for d in sorted(range(lo - i, hi - i), key=abs):
        j = i + d
        if sums[j] < 0.6 * best:
            continue
        sel = ms[j] > 0                              # same caption still there? (any colour)
        if np.abs(src[i][sel].astype(np.int16) - src[j][sel]).mean() < 30:
            ms[i] = ms[i] | ms[j]; borrowed.append(i); break
# Second pass: merge each frame's mask with nearby frames that show the same caption
# (mask overlap), so letters that are faint in some frames (red text on a red shirt)
# are filled in from frames where they were detected clearly.
k3 = np.ones((3, 3), np.uint8)
small = [cv2.dilate(m[y0:y1], k3).astype(bool) for m in ms]   # full-res band, tolerate 1px jitter
merged = []
for i in range(len(ms)):
    if not small[i].any():
        merged.append(ms[i]); continue
    acc = ms[i].copy()
    for j in range(max(0, i - 10), min(len(ms), i + 11)):
        if j == i or not small[j].any():
            continue
        # same caption only: strokes of different words barely coincide, so a real
        # overlap of >=50% means a partial detection of the same text
        if (small[i] & small[j]).sum() / (small[i] | small[j]).sum() >= 0.5:
            acc |= ms[j]
    merged.append(acc)
ms = merged
grow = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * args.erase_grow + 1,) * 2)
glow_grow = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (115, 115))
deglow_grow = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (181, 181))
k9 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
dbg = set(int(x) for x in args.dbg_frames.split(',') if x)
if args.debug:
    os.makedirs(args.debug, exist_ok=True)

enc = subprocess.Popen(['ffmpeg', '-hide_banner', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24',
                        '-s', f'{W}x{H}', '-r', '30', '-i', '-', '-c:v', 'libx264', '-crf', '14',
                        '-pix_fmt', 'yuv420p', args.out], stdin=subprocess.PIPE)
pad = args.erase_grow + 10
by0, by1 = max(0, y0 - pad), min(H, y1 + pad)
stats = []
for i, (O, S) in enumerate(zip(swap, src)):
    # erase: union of model masks over neighbouring frames, grown to cover glow/shadow
    m = mo[i].copy()
    if i > 0: m |= mo[i - 1]
    if i + 1 < len(mo): m |= mo[i + 1]
    E = cv2.dilate(m, grow)
    Vo = O.max(axis=2).astype(np.int16); vivid = ((Vo - O.min(axis=2)) > 80).astype(np.uint8)
    if (m & vivid).any():                            # coloured words have a wide neon glow
        E |= cv2.dilate(m & vivid, glow_grow)
    R = O.copy()
    ys = np.where(E.any(axis=1))[0]
    if len(ys):
        # clone stamp: fill the text rows with the fur just below them (keeps texture;
        # body edges are near-vertical so a vertical shift lines up), Poisson-blended
        # so the fill takes on the surrounding brightness without seams
        dy = int(ys.max() - ys.min()) + 14
        if ys.max() + dy >= H - 2:
            dy = -dy
        shifted = np.roll(O, -dy, axis=0)            # shifted[y] = O[y + dy]
        x, y, w, h = cv2.boundingRect(E)
        try:
            R = cv2.seamlessClone(shifted, O, E * 255, (x + w // 2, y + h // 2), cv2.NORMAL_CLONE)
        except cv2.error:
            a = np.clip(cv2.GaussianBlur(E.astype(np.float32), (0, 0), 5) * 1.6, 0, 1)[..., None]
            R = (O.astype(np.float32) * (1 - a) + shifted.astype(np.float32) * a).astype(np.uint8)
        gl = m & vivid
        if args.deglow and gl.sum() > 1500:
            # white fur only: remove the neon tint along the glow's own chroma direction
            Y = cv2.cvtColor(R, cv2.COLOR_BGR2YCrCb).astype(np.float32)
            c = cv2.cvtColor(O, cv2.COLOR_BGR2YCrCb).astype(np.float32)[gl > 0][:, 1:].mean(axis=0) - 128
            d = c / max(np.linalg.norm(c), 1e-3)
            reg = cv2.GaussianBlur(cv2.dilate(gl, deglow_grow).astype(np.float32), (0, 0), 25)
            ch = Y[..., 1:] - 128
            proj = np.clip(ch @ d, 0, None)
            Y[..., 1:] = ch - (0.85 * reg * proj)[..., None] * d + 128
            R = cv2.cvtColor(np.clip(Y, 0, 255).astype(np.uint8), cv2.COLOR_YCrCb2BGR)
    # restore source captions: soft dark shadow, coloured glow, then the letters
    L = ms[i].astype(np.float32)
    if L.any() and not args.erase_only:
        alpha = np.clip(cv2.GaussianBlur(L, (0, 0), 1.0) * 1.4, 0, 1)[..., None]
        shadow = (cv2.GaussianBlur(cv2.dilate(ms[i], k9).astype(np.float32), (0, 0), 7) * args.shadow)[..., None]
        gm = cv2.GaussianBlur(L, (0, 0), 9)
        gcol = cv2.GaussianBlur(S.astype(np.float32) * L[..., None], (0, 0), 9) / np.maximum(gm, 1e-4)[..., None]
        ga = np.clip(gm * 1.6, 0, 1)[..., None] * 0.45
        Rf = R.astype(np.float32) * (1 - shadow)
        Rf = Rf * (1 - ga) + gcol * ga
        Rf = Rf * (1 - alpha) + S.astype(np.float32) * alpha
        R = np.clip(Rf, 0, 255).astype(np.uint8)
    stats.append((int(mo[i].sum()), int(ms[i].sum())))
    if i in dbg and args.debug:
        vis = lambda img: img[by0:by1]
        mov = O.copy(); mov[E > 0] = (0, 0, 255)
        sv = S.copy(); sv[ms[i] > 0] = (0, 255, 0)
        cv2.imwrite(f'{args.debug}/f{i:03d}.jpg', np.vstack([vis(sv), vis(O), vis(mov), vis(R)]))
    enc.stdin.write(R.tobytes())
enc.stdin.close(); enc.wait()
z = [i for i, (a, b) in enumerate(stats) if b == 0]
print(f'frames={len(stats)} band=({y0},{y1}) model_px_mean={np.mean([a for a,_ in stats]):.0f} '
      f'src_px_mean={np.mean([b for _,b in stats]):.0f} frames_without_src_caption={len(z)} {z[:20]} '
      f'borrowed={len(borrowed)} {borrowed[:30]}')
