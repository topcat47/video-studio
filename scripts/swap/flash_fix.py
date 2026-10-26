#!/usr/bin/env python3
"""Rebuild the source's flash-transition frames over a swapped final.

Usage: python3 -I flash_fix.py <src30.mp4> <final_raw.mp4> <out_dir> <frame>[:leak] ...

Each flash frame F in the source is the next shot's frame F+1, overexposed and tinted.
Global flashes: fit out_c = a_c * in_c + b_c per channel from source F+1 -> source F
(mean and spread matched on a pixel grid), then apply that map to the final's (swapped) F+1.
':leak' flashes (a spatial light leak): add a heavily blurred (source F - source F+1)
on top of the final's F+1 instead.
Writes <out_dir>/flash_<F>.mp4, one frame at 30 fps, for assemble.py --patch F=<clip>.
"""
import os
import subprocess
import sys

W, H = 720, 1280


def frame_rgb(video, n):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', video, '-vf', f"select='eq(n,{n})'",
                          '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo',
                          '-pix_fmt', 'rgb24', '-'], check=True, capture_output=True).stdout
    if len(raw) != W * H * 3:
        sys.exit(f'{video} frame {n}: got {len(raw)} bytes')
    return raw


def fit(src_in, src_out, step=7):
    # match each channel's mean and spread (a least-squares fit shrinks the tint, because
    # the two frames don't line up pixel for pixel)
    maps = []
    for c in range(3):
        stats = []
        for buf in (src_in, src_out):
            v = buf[c::3 * step]
            m = sum(v) / len(v)
            stats.append((m, (sum((x - m) ** 2 for x in v) / len(v)) ** 0.5))
        (mi, si), (mo, so) = stats
        a = so / si if si else 1.0
        maps.append((a, mo - a * mi))
    return maps


def to_clip(png, out):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-loop', '1', '-i', png, '-frames:v', '1', '-r', '30',
                    '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', out], check=True)


def main():
    src, final, out_dir = sys.argv[1:4]
    os.makedirs(out_dir, exist_ok=True)
    for spec in sys.argv[4:]:
        f, _, kind = spec.partition(':')
        f = int(f)
        nxt = os.path.join(out_dir, f'next_{f}.png')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', final, '-vf', f"select='eq(n,{f + 1})'",
                        '-fps_mode', 'passthrough', '-frames:v', '1', nxt], check=True)
        png = os.path.join(out_dir, f'flash_{f}.png')
        if kind == 'leak':
            s_f = os.path.join(out_dir, f'src_{f}.png'); s_n = os.path.join(out_dir, f'src_{f + 1}.png')
            for n, p in ((f, s_f), (f + 1, s_n)):
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-vf', f"select='eq(n,{n})'",
                                '-fps_mode', 'passthrough', '-frames:v', '1', p], check=True)
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', s_f, '-i', s_n, '-i', nxt, '-filter_complex',
                            '[0][1]blend=all_mode=subtract,gblur=sigma=40[leak];[2][leak]blend=all_mode=addition',
                            '-frames:v', '1', png], check=True)
            print(f'frame {f}: leak added over swapped {f + 1}')
        else:
            maps = fit(frame_rgb(src, f + 1), frame_rgb(src, f))
            (ar, br), (ag, bg), (ab, bb) = maps
            lut = (f"lutrgb=r='clip({ar:.4f}*val+{br:.2f},0,255)':g='clip({ag:.4f}*val+{bg:.2f},0,255)'"
                   f":b='clip({ab:.4f}*val+{bb:.2f},0,255)'")
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', nxt, '-vf', lut, '-frames:v', '1', png], check=True)
            print(f'frame {f}: map r={ar:.2f}x+{br:.0f} g={ag:.2f}x+{bg:.0f} b={ab:.2f}x+{bb:.0f}')
        to_clip(png, os.path.join(out_dir, f'flash_{f}.mp4'))


if __name__ == '__main__':
    main()
