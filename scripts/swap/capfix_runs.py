#!/usr/bin/env python3
"""Put the source's burned-in captions back on every swapped stretch of an assembled final, in one go.

Usage: python3 -I scripts/swap/capfix_runs.py <source> <final_raw> <out.mp4> <A-B> [<A-B> ...]
           (--preset NAME | --channel NAME | --band Y0 Y1) [--python <venv>/bin/python]
           [--chunk 150] [--work DIR] [-- <extra capfix flags>]

<A-B> are the swapped source frame ranges (assemble.py prints them). Each range is cut from
final_raw in chunks of at most --chunk frames (capfix holds every frame in memory), scaled to
1080 px wide if the source is smaller (capfix's size limits are in 1080x1920 pixels), run
through scripts/capfix.py with the preset's flags, and laid back with assemble.py --patch.
Then compare.py writes caption sheets at 6 fps (<out>_cap_NN.png): read every one, and patch
only the stretches where the model's own words were wrong if capfix damaged good captions.

Presets live in scripts/swap/caption_presets.json (--channel matches the uploader or show).
capfix needs numpy + OpenCV: --python, or $CAPFIX_PY, pointing at a venv made with
  python3 -m venv <scratch>/venv && <scratch>/venv/bin/pip install numpy opencv-python-headless
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CAPFIX = os.path.join(os.path.dirname(HERE), 'capfix.py')


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, **kw)


def probe(video):
    out = subprocess.run(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0',
                          '-show_entries', 'stream=nb_read_frames,r_frame_rate,width,height',
                          '-of', 'json', video], check=True, capture_output=True, text=True).stdout
    s = json.loads(out)['streams'][0]
    num, den = (int(x) for x in s['r_frame_rate'].split('/'))
    return int(s['nb_read_frames']), num, den, int(s['width']), int(s['height'])


def cut(src, a, b, num, den, scale, out):
    vf = f"select='between(n,{a},{b})',setpts=N*{den}/{num}/TB" + (f',scale={scale}:flags=lanczos' if scale else '')
    run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-vf', vf, '-fps_mode', 'cfr', '-r', f'{num}/{den}',
         '-frames:v', str(b - a + 1), '-an', '-c:v', 'libx264', '-crf', '10', '-preset', 'veryfast', out])
    got = probe(out)[0]
    if got != b - a + 1:
        sys.exit(f'{out}: expected {b - a + 1} frames, got {got}')


def main():
    argv = sys.argv[1:]
    extra = []
    if '--' in argv:
        i = argv.index('--'); argv, extra = argv[:i], argv[i + 1:]
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('source'); ap.add_argument('final_raw'); ap.add_argument('out')
    ap.add_argument('ranges', nargs='+')
    ap.add_argument('--preset'); ap.add_argument('--channel')
    ap.add_argument('--band', type=float, nargs=2, metavar=('Y0', 'Y1'), help='caption band, overrides the preset')
    ap.add_argument('--python', default=os.environ.get('CAPFIX_PY'))
    ap.add_argument('--chunk', type=int, default=150)
    ap.add_argument('--work')
    a = ap.parse_args(argv)

    presets = json.load(open(os.path.join(HERE, 'caption_presets.json')))['presets']
    name = a.preset
    if not name and a.channel:
        hits = [k for k, p in presets.items() if any(m.lower() in a.channel.lower() for m in p['match'])]
        if not hits:
            sys.exit(f'no preset matches {a.channel!r}: pass --band and flags after --, then add a preset')
        name = hits[0]
    p = presets[name] if name else {'band': None, 'flags': []}
    if name and name not in presets:
        sys.exit(f'unknown preset {name}; have {", ".join(presets)}')
    band = a.band or p['band']
    if not band:
        sys.exit('need --preset, --channel or --band')
    flags = ['--y0', str(band[0]), '--y1', str(band[1])] + p['flags'] + extra
    if not a.python or not os.path.exists(a.python):
        sys.exit('capfix needs numpy + OpenCV: pass --python <venv>/bin/python or set CAPFIX_PY (setup line in --help)')
    print(f'preset: {name or "(none)"}  capfix flags: {" ".join(flags)}')

    total, num, den, W, H = probe(a.source)
    tf = probe(a.final_raw)
    if (tf[0], tf[1], tf[2]) != (total, num, den):
        sys.exit(f'final_raw has {tf[0]} frames @{tf[1]}/{tf[2]}, source {total} @{num}/{den}: assemble it first')
    work = a.work or a.out + '.capfix'
    os.makedirs(work, exist_ok=True)
    scale = None
    if W < 1080:
        scale = f'1080:{round(H * 1080 / W / 2) * 2}'
    src_cf = a.source
    if scale:
        src_cf = os.path.join(work, 'src1080.mp4')
        if not os.path.exists(src_cf):
            cut(a.source, 0, total - 1, num, den, scale, src_cf)

    chunks = []
    for r in a.ranges:
        lo, hi = (int(x) for x in r.split('-'))
        if not 0 <= lo <= hi < total:
            sys.exit(f'range {r} is outside 0-{total - 1}')
        n = -(-(hi - lo + 1) // a.chunk)       # equal chunks of at most --chunk frames
        size = -(-(hi - lo + 1) // n)
        chunks += [(s, min(hi, s + size - 1)) for s in range(lo, hi + 1, size)]

    patches = []
    for s, e in chunks:
        run_f = os.path.join(work, f'run_{s}.mp4'); fix_f = os.path.join(work, f'fix_{s}.mp4')
        cut(a.final_raw, s, e, num, den, scale, run_f)
        res = subprocess.run([a.python, '-I', CAPFIX, run_f, src_cf, str(s), fix_f] + flags,
                             capture_output=True, text=True)
        if res.returncode:
            sys.exit(f'capfix failed on {s}-{e}:\n{res.stderr[-2000:]}')
        print(f'{s}-{e}: ' + (res.stdout.strip().splitlines() or [''])[-1])
        patches += ['--patch', f'{s}={fix_f}']

    run([sys.executable, '-I', os.path.join(HERE, 'assemble.py'), a.final_raw, a.out] + patches,
        stdout=subprocess.DEVNULL)
    if probe(a.out)[0] != total:
        sys.exit(f'{a.out} does not have {total} frames')
    y0, y1 = max(0, band[0] - 0.01), min(1, band[1] + 0.01)
    prefix = os.path.splitext(a.out)[0] + '_cap'
    out = run([sys.executable, '-I', os.path.join(HERE, 'compare.py'), a.source, a.out, prefix,
               '--fps', '6', '--band', str(y0), str(y1)], capture_output=True, text=True).stdout
    print(f'\n{a.out}: {total} frames, captions restored on {len(chunks)} chunk(s)')
    print('caption sheets (source over final, read every one):')
    print('\n'.join(l for l in out.splitlines() if l.strip().endswith('.png')))


if __name__ == '__main__':
    main()
