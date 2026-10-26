#!/usr/bin/env python3
"""Build one swap input (a reel of source frame ranges) for hf_mult_replace_object.

Usage: python3 scripts/swap/build_input.py <source> <out.mp4> <first-last> [<first-last> ...] [--min4]

Ranges are 0-based inclusive frame numbers from shots.py, joined in the order given. Join only
shots of the target from the same camera; never put the other speakers' shots in a reel.
Timestamps are rebuilt from the frame index (YouTube VP9 sources have uneven timestamps), so
the reel has exactly the frames asked for. --min4: if the reel is under 4.25 s, retime it to
exactly 96 frames at 24 fps (4.000 s, the cheapest billable length: 12 credits at 480p; 4.004 s
is 15). Under 4 s it is slowed; 4.0-4.25 s is sped up a little (at most 6%). assemble.py puts
it back to real time either way.

Writes <out.mp4> plus <out.mp4>.json (source, ranges, retimed), which assemble.py reads.
Prints frames, seconds and the expected cost (3 x ceil(seconds) at 480p; confirm with get_cost).
"""
import argparse
import json
import math
import subprocess
import sys


def probe(video):
    out = subprocess.run(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0',
                          '-show_entries', 'stream=nb_read_frames,r_frame_rate', '-of', 'json', video],
                         check=True, capture_output=True, text=True).stdout
    s = json.loads(out)['streams'][0]
    num, den = (int(x) for x in s['r_frame_rate'].split('/'))
    return int(s['nb_read_frames']), num, den


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('source')
    ap.add_argument('out')
    ap.add_argument('ranges', nargs='+', help='first-last frame numbers, inclusive')
    ap.add_argument('--min4', action='store_true', help='retime a reel under 4.25 s to exactly 96 frames @24')
    a = ap.parse_args()

    total, num, den = probe(a.source)
    ranges = []
    for r in a.ranges:
        f, l = (int(x) for x in r.split('-'))
        if not 0 <= f <= l < total:
            sys.exit(f'bad range {r} (source has frames 0-{total - 1})')
        ranges.append([f, l])
    n = sum(l - f + 1 for f, l in ranges)
    real = n * den / num

    sel = '+'.join(f'between(n,{f},{l})' for f, l in ranges)
    vf = f"select='{sel}',setpts=N*{den}/{num}/TB"
    out_frames, rate, retimed = n, f'{num}/{den}', False
    if a.min4 and real <= 4.25:
        vf += (f',setpts=PTS*4/{real:.6f},minterpolate=fps=24:mi_mode=mci,'
               'tpad=stop_mode=clone:stop=8,setpts=N/24/TB')
        out_frames, rate, retimed = 96, '24', True
    elif a.min4:
        print(f'note: reel is {real:.3f} s, over 4.25 s; not retimed')

    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', a.source, '-vf', vf, '-fps_mode', 'cfr',
                    '-r', rate, '-frames:v', str(out_frames), '-c:v', 'libx264', '-crf', '14',
                    '-preset', 'slow', '-pix_fmt', 'yuv420p', '-an', a.out], check=True)
    got, onum, oden = probe(a.out)
    if got != out_frames:
        sys.exit(f'expected {out_frames} frames, got {got}')
    secs = round(got * oden / onum, 3)
    json.dump({'source': a.source, 'ranges': ranges, 'source_frames': n, 'source_seconds': round(real, 3),
               'retimed': retimed, 'frames': got, 'seconds': secs},
              open(a.out + '.json', 'w'), indent=1)
    print(f'{a.out}: {got} frames, {secs} s'
          f'{" (retimed from " + format(real, ".3f") + " s)" if retimed else ""}, '
          f'about {3 * math.ceil(secs)} credits at 480p')


if __name__ == '__main__':
    sys.exit(main())
