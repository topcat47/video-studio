#!/usr/bin/env python3
"""Map a clip's shots for a character swap: cut list, what is said in each shot, and contact sheets.

Usage: python3 scripts/swap/shots.py <video> <outdir> [--threshold 8] [--every 2.5]

Writes <outdir>/shots.json and <outdir>/sheet_NN.png. Tiles are in shot order: the middle frame
of every shot, plus one tile every --every seconds inside long shots (so a cut that scdet misses,
or a person change inside a "shot", still shows up). The table printed at the end gives each
shot's frame range (0-based, inclusive, in decode order: use these numbers everywhere, never
seconds), its times, and the words whisper heard in it (who asks and who answers).

Stdlib + ffmpeg/ffprobe/whisper-cli only (no numpy on this Mac).
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys

WHISPER_MODEL = os.path.expanduser('~/.cache/whisper-models/ggml-base.en.bin')
TILES_PER_SHEET = 32
COLS = 8


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def probe(video):
    out = run(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0',
               '-show_entries', 'stream=nb_read_frames,r_frame_rate,width,height',
               '-of', 'json', video]).stdout
    s = json.loads(out)['streams'][0]
    num, den = (int(x) for x in s['r_frame_rate'].split('/'))
    return {'frames': int(s['nb_read_frames']), 'num': num, 'den': den,
            'width': int(s['width']), 'height': int(s['height'])}


def find_cuts(video, threshold, outdir):
    meta = os.path.join(outdir, 'scdet.txt')
    subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', video, '-vf',
                    f'scdet=threshold={threshold},metadata=print:file={meta}', '-f', 'null', '-'],
                   check=True, capture_output=True)
    cuts, frame = [], None
    for line in open(meta):
        m = re.match(r'frame:(\d+)', line)
        if m:
            frame = int(m.group(1))
        elif 'lavfi.scd.time=' in line and frame:
            cuts.append(frame)
    return cuts


def transcribe(video, outdir):
    """Word timings from whisper.cpp; [] if the model or the audio is missing."""
    if not os.path.exists(WHISPER_MODEL):
        return []
    wav, base = os.path.join(outdir, 'audio16k.wav'), os.path.join(outdir, 'words')
    try:
        run(['ffmpeg', '-v', 'error', '-y', '-i', video, '-ar', '16000', '-ac', '1',
             '-c:a', 'pcm_s16le', wav])
        run(['whisper-cli', '-m', WHISPER_MODEL, '-f', wav, '-ml', '1', '-sow', '-oj', '-np',
             '-of', base])
    except subprocess.CalledProcessError:
        return []
    words = []
    for w in json.load(open(base + '.json'))['transcription']:
        text = w['text'].strip()
        if text and not re.fullmatch(r'[\[(].*[\])]', text):
            words.append((w['offsets']['from'] / 1000, text))
    return words


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('video')
    ap.add_argument('outdir')
    ap.add_argument('--threshold', type=float, default=8, help='scdet threshold (default 8)')
    ap.add_argument('--every', type=float, default=2.5, help='extra tile spacing in long shots (s)')
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)

    info = probe(a.video)
    fps = info['num'] / info['den']
    bounds = [0] + find_cuts(a.video, a.threshold, a.outdir) + [info['frames']]
    words = transcribe(a.video, a.outdir)

    shots, tiles = [], []
    step = max(1, round(a.every * fps))
    for i in range(len(bounds) - 1):
        s, e = bounds[i], bounds[i + 1] - 1
        n = e - s + 1
        picks = [s + step // 2 + k * step for k in range(n // step)] if n > 1.5 * step else [s + n // 2]
        text = ' '.join(t for (t0, t) in words if s <= round(t0 * fps) <= e)
        shot = {'shot': i + 1, 'start': s, 'end': e, 'frames': n,
                't0': round(s / fps, 3), 't1': round((e + 1) / fps, 3), 'dur': round(n / fps, 3),
                'tiles': [], 'said': text}
        for f in picks:
            tiles.append(f)
            shot['tiles'].append(len(tiles))
        shots.append(shot)

    tile_dir = os.path.join(a.outdir, 'tiles')
    os.makedirs(tile_dir, exist_ok=True)
    for f in os.listdir(tile_dir):
        os.remove(os.path.join(tile_dir, f))
    # In batches: one select over 100+ frames is too long for ffmpeg (exit 244 on a 102 s clip).
    for k in range(0, len(tiles), 40):
        sel = '+'.join(f'eq(n\\,{f})' for f in tiles[k:k + 40])
        run(['ffmpeg', '-v', 'error', '-y', '-i', a.video, '-vf',
             f"select='{sel}',scale='if(gt(iw,ih),480,270)':-2", '-fps_mode', 'passthrough',
             '-start_number', str(k + 1), os.path.join(tile_dir, '%03d.png')])
    sheets = []
    for k in range(math.ceil(len(tiles) / TILES_PER_SHEET)):
        first, count = k * TILES_PER_SHEET + 1, min(TILES_PER_SHEET, len(tiles) - k * TILES_PER_SHEET)
        rows = math.ceil(count / COLS)
        out = os.path.join(a.outdir, f'sheet_{k + 1:02d}.png')
        run(['ffmpeg', '-v', 'error', '-y', '-framerate', '1', '-start_number', str(first),
             '-i', os.path.join(tile_dir, '%03d.png'), '-frames:v', '1', '-vf',
             f'tile={COLS}x{rows}:padding=4:color=white', out])
        sheets.append(out)

    json.dump({'video': os.path.abspath(a.video), **info, 'shots': shots, 'tile_frames': tiles,
               'sheets': sheets}, open(os.path.join(a.outdir, 'shots.json'), 'w'), indent=1)

    print(f"{info['frames']} frames, {info['num']}/{info['den']} fps, {info['width']}x{info['height']}, "
          f"{len(shots)} shots; sheets (tiles numbered left to right, {COLS} per row, "
          f"{TILES_PER_SHEET} per sheet): {', '.join(sheets)}")
    print(f"{'shot':>4} {'frames':>11} {'time':>13} {'dur':>6}  tiles   said")
    for s in shots:
        t = f"{s['tiles'][0]}" + (f"-{s['tiles'][-1]}" if len(s['tiles']) > 1 else '')
        print(f"{s['shot']:>4} {s['start']:>5}-{s['end']:<5} {s['t0']:>6.2f}-{s['t1']:<6.2f} "
              f"{s['dur']:>5.2f}  {t:<7} {s['said'][:110]}")


if __name__ == '__main__':
    sys.exit(main())
