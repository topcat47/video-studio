#!/usr/bin/env python3
"""Side-by-side check sheets of the source and a swapped final (same frame count and rate).

Usage: python3 scripts/swap/compare.py <source> <final> <out_prefix> [--fps 2] [--from S] [--to S]
           [--band Y0 Y1] [--cols 6]

Full frames (default): each tile is source | final, for looking for human parts left on the
cat (hands, sleeves, collar, hair or a head behind the cat). --band 0.40 0.62 crops just that
horizontal band (fractions of the height) and stacks source over final, for comparing burned-in
captions word by word; use --fps 6 or more there (short captions hide between 2 fps samples).
Writes <out_prefix>_01.png, _02.png, ...
"""
import argparse
import glob
import json
import os
import subprocess
import sys


def size(video):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                          'stream=width,height', '-of', 'json', video],
                         check=True, capture_output=True, text=True).stdout
    s = json.loads(out)['streams'][0]
    return int(s['width']), int(s['height'])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('source')
    ap.add_argument('final')
    ap.add_argument('out_prefix')
    ap.add_argument('--fps', type=float, default=2)
    ap.add_argument('--from', dest='t0', type=float, default=0)
    ap.add_argument('--to', dest='t1', type=float)
    ap.add_argument('--band', type=float, nargs=2, metavar=('Y0', 'Y1'))
    ap.add_argument('--cols', type=int, default=6)
    a = ap.parse_args()

    w, h = size(a.source)               # both inputs are scaled to exactly the same tile size
    trim = f'trim=start={a.t0}' + (f':end={a.t1}' if a.t1 else '') + ',setpts=PTS-STARTPTS'
    if a.band:
        y0, y1 = a.band
        bh = 2 * round(540 * h * (y1 - y0) / w / 2)
        prep = f'{trim},fps={a.fps},crop=iw:ih*{y1 - y0:.4f}:0:ih*{y0:.4f},scale=540:{bh}'
        stack, rows = 'vstack', 4
    else:
        prep = f'{trim},fps={a.fps},scale=240:{2 * round(240 * h / w / 2)}'
        stack, rows = 'hstack', 3
    cols = a.cols if not a.band else max(1, a.cols // 2)
    graph = (f'[0:v]{prep}[s];[1:v]{prep}[f];[s][f]{stack},pad=iw+6:ih+6:3:3:white,'
             f'tile={cols}x{rows}:color=white[out]')
    for old in glob.glob(a.out_prefix + '_*.png'):
        os.remove(old)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', a.source, '-i', a.final, '-filter_complex', graph,
                    '-map', '[out]', '-fps_mode', 'passthrough', a.out_prefix + '_%02d.png'], check=True)
    sheets = sorted(glob.glob(a.out_prefix + '_*.png'))
    per = cols * rows
    print(f'{len(sheets)} sheets, {per} samples each at {a.fps} fps from {a.t0} s '
          f'(sample k is at {a.t0} + k/{a.fps} s, left to right):')
    for s in sheets:
        print(' ', s)


if __name__ == '__main__':
    sys.exit(main())
