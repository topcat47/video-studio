#!/usr/bin/env python3
"""Put swap results back into the source at their exact frames, under the original audio.

Usage: python3 scripts/swap/assemble.py <source> <final.mp4> <reel.mp4>=<result.mp4> [...]
           [--shift <reel.mp4>=<k>] [--patch <frame>=<clip.mp4>] [--work DIR]

Each pair is a reel made by build_input.py (its .json sidecar lists the source frames it holds)
and the Higgsfield result for that reel. Each result is:
  1. stretched back to the reel's real length (the model returns 24 fps and 2-6% time-
     compressed, not cut short; a slowed --min4 reel is squeezed back to real time the same way),
  2. converted to the source frame rate and size and trimmed to the reel's frame count,
  3. sliced into its ranges in order.
--shift <reel>=k drops the first k frames of that result (one channel's runs came back exactly
1 frame late at every seam). --patch <frame>=<clip> puts a clip that is already at the source's
frame rate (e.g. a capfix.py output) in from that source frame on, over the reels. Frames no
reel or patch covers come straight from the source.

Prints the seams, then any swapped frame that is much darker than the source frame (runs
sometimes end on black frames). The final has exactly the source's frame count and rate.
"""
import argparse
import json
import os
import re
import subprocess
import sys


def run(cmd):
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def probe(video):
    out = subprocess.run(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0',
                          '-show_entries', 'stream=nb_read_frames,r_frame_rate,width,height',
                          '-of', 'json', video], check=True, capture_output=True, text=True).stdout
    s = json.loads(out)['streams'][0]
    num, den = (int(x) for x in s['r_frame_rate'].split('/'))
    return int(s['nb_read_frames']), num, den, int(s['width']), int(s['height'])


def encode(src, vf, frames, rate, out, crf='10', preset='veryfast'):
    run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-vf', vf, '-fps_mode', 'cfr', '-r', rate,
         '-frames:v', str(frames), '-c:v', 'libx264', '-crf', crf, '-preset', preset,
         '-pix_fmt', 'yuv420p', '-an', out])
    got = probe(out)[0]
    if got != frames:
        sys.exit(f'{out}: expected {frames} frames, got {got}')


def yavg(video, work):
    txt = os.path.join(work, os.path.basename(video) + '.yavg.txt')
    run(['ffmpeg', '-v', 'error', '-i', video, '-vf',
         f'scale=180:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file={txt}', '-f', 'null', '-'])
    return [float(m.group(1)) for m in re.finditer(r'YAVG=([\d.]+)', open(txt).read())]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('source')
    ap.add_argument('final')
    ap.add_argument('pairs', nargs='*', help='<reel.mp4>=<result.mp4> (none: only --patch over the source)')
    ap.add_argument('--shift', action='append', default=[], help='<reel.mp4>=<frames to drop>')
    ap.add_argument('--patch', action='append', default=[], help='<source frame>=<clip at source fps>')
    ap.add_argument('--work', help='folder for intermediates (default: <final>.work)')
    a = ap.parse_args()

    total, num, den, W, H = probe(a.source)
    rate = f'{num}/{den}'
    work = a.work or a.final + '.work'
    os.makedirs(work, exist_ok=True)
    shifts = {os.path.abspath(k): int(v) for k, v in (s.split('=', 1) for s in a.shift)}

    owner = [None] * total            # per source frame: (job index, frame in converted result)
    convs = []
    for j, pair in enumerate(a.pairs):
        reel, result = pair.split('=', 1)
        side = json.load(open(reel + '.json'))
        n = side['source_frames']
        real = n * den / num
        rf, rnum, rden, _, _ = probe(result)
        rdur = rf * rden / rnum
        k = shifts.get(os.path.abspath(reel), 0)
        conv = os.path.join(work, f'conv{j}.mp4')
        encode(result, f'setpts=N*{rden}/{rnum}/TB,setpts=PTS*{real / rdur:.8f},fps={rate},'
                       f'tpad=stop_mode=clone:stop={30 + k},trim=start_frame={k}:end_frame={n + k},'
                       f'setpts=N*{den}/{num}/TB,scale={W}:{H}:flags=lanczos,setsar=1,format=yuv420p',
               n, rate, conv, crf='12', preset='medium')
        convs.append(conv)
        print(f'{os.path.basename(result)}: {rf} frames @{rnum}/{rden} ({rdur:.3f} s) -> {n} frames '
              f'({real:.3f} s, stretch x{real / rdur:.4f}{f", shift {k}" if k else ""})')
        c = 0
        for f, l in side['ranges']:
            for s in range(f, l + 1):
                if owner[s] is not None:
                    sys.exit(f'source frame {s} is in two reels')
                owner[s] = (j, c)
                c += 1

    labels = [os.path.basename(p.split('=', 1)[1]) for p in a.pairs]
    for spec in a.patch:
        start, clip = spec.split('=', 1)
        start, n = int(start), probe(clip)[0]
        if start + n > total:
            sys.exit(f'patch {clip} ({n} frames from {start}) runs past the source end')
        convs.append(clip)
        labels.append(os.path.basename(clip) + ' (patch)')
        for k in range(n):
            owner[start + k] = (len(convs) - 1, k)
        print(f'{os.path.basename(clip)}: patch over frames {start}-{start + n - 1}')

    runs = []                         # [first source frame, last, job or None, first result frame]
    for s in range(total):
        o = owner[s]
        prev = runs[-1] if runs else None
        if prev and ((o is None and prev[2] is None) or
                     (o is not None and prev[2] == o[0] and o[1] == prev[3] + s - prev[0])):
            prev[1] = s
        else:
            runs.append([s, s, None if o is None else o[0], None if o is None else o[1]])

    listfile = os.path.join(work, 'segments.txt')
    with open(listfile, 'w') as lst:
        for i, (f, l, j, c) in enumerate(runs):
            seg = os.path.join(work, f'seg{i:03d}.mp4')
            src, a0 = (a.source, f) if j is None else (convs[j], c)
            encode(src, f"select='between(n,{a0},{a0 + l - f})',setpts=N*{den}/{num}/TB,"
                        f"scale={W}:{H}:flags=lanczos,setsar=1,format=yuv420p", l - f + 1, rate, seg)
            lst.write(f"file '{os.path.abspath(seg)}'\n")

    # -reinit_filter 0: segments with different colour tags (source bt709 vs untagged swaps) make
    # ffmpeg 9 rebuild the filter graph at each join, which resets setpts' N and drops frames
    run(['ffmpeg', '-v', 'error', '-y', '-reinit_filter', '0', '-f', 'concat', '-safe', '0', '-i', listfile, '-i', a.source,
         '-map', '0:v', '-map', '1:a?', '-vf', f'setpts=N*{den}/{num}/TB', '-fps_mode', 'cfr',
         '-r', rate, '-c:v', 'libx264', '-crf', '16', '-preset', 'slow', '-pix_fmt', 'yuv420p',
         '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', a.final])
    got = probe(a.final)[0]
    if got != total:
        sys.exit(f'final has {got} frames, source has {total}')

    print(f'\n{a.final}: {got} frames @{rate}, same as the source; original audio')
    fps = num / den
    for f, l, j, _ in runs:
        who = 'source' if j is None else labels[j]
        print(f'  frames {f:>5}-{l:<5} {f / fps:7.2f}-{(l + 1) / fps:<7.2f} {who}')

    ys, yf = yavg(a.source, work), yavg(a.final, work)
    dark = [s for s in range(min(len(ys), len(yf)))
            if owner[s] is not None and yf[s] < 40 and yf[s] < 0.5 * ys[s]]
    if dark:
        print(f'\nWARNING: {len(dark)} swapped frames are much darker than the source: '
              f'{dark[:12]}{" ..." if len(dark) > 12 else ""} (black tail? patch them before delivering)')
    else:
        print('\nno swapped frame is much darker than its source frame')


if __name__ == '__main__':
    sys.exit(main())
