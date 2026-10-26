#!/bin/zsh
# capswap.sh <cat.mp4> <src.mp4> <out.mp4>
# When the swap model REDRAWS the captions somewhere else (big bold uncensored words over the background),
# erase its caption box with delogo, then lay the source's own caption letters back on at their own place,
# with a dark shadow so white letters read over white fur. ffmpeg only, a few seconds per clip.
# (zsh: keep ${VAR} braces, "$EW:h" would be read as the :h modifier.)
# Both inputs: same size, fps and frame count (cut both at the source fps by source frame first).
# Box and band (pixels) via env vars; defaults are IMG_8217 / silenceduniversity, 720x1280 (2026-10-21):
#   ERASE="x:y:w:h"   model caption box to fill (must sit on a plain background, no cat inside)
#   BAND="y0:y1:x0:x1" source caption letters
#   THR=175           source letters are min(R,G,B) above this (white captions)
CAT=$1; SRC=$2; OUT=$3
ERASE=${ERASE:-90:198:540:100}; BAND=${BAND:-616:666:140:580}; THR=${THR:-175}
IFS=: read EX EY EW EH <<< "$ERASE"; IFS=: read BY0 BY1 BX0 BX1 <<< "$BAND"
IFS=, read W H FPS N <<< $(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=width,height,r_frame_rate,nb_read_frames -of csv=p=0 "$SRC")
B="between(Y,${BY0},${BY1})*between(X,${BX0},${BX1})"
ffmpeg -v error -y -i "$CAT" -i "$SRC" -filter_complex "
[0:v]delogo=x=${EX}:y=${EY}:w=${EW}:h=${EH},format=gbrp[erased];
[1:v]format=gbrp,split=2[srgb][forsm];
[forsm]extractplanes=g+b+r[sg][sb][sr];[sg][sb]blend=all_mode=darken[sgb];[sgb][sr]blend=all_mode=darken[smin];
[smin]geq=lum='if(${B},clip((p(X,Y)-${THR})*255/45,0,255),0)',split=2[lmask0][shad0];
[shad0]dilation,dilation,dilation,gblur=sigma=2,lut=y='val*0.8',format=gbrp[smask];
[lmask0]format=gbrp[lmask];
color=c=black:s=${W}x${H}:r=${FPS},format=gbrp[blk];
[erased][blk][smask]maskedmerge[shadowed];
[shadowed][srgb][lmask]maskedmerge,format=yuv420p[v]" -map "[v]" -frames:v $N -r $FPS -c:v libx264 -crf 14 "$OUT"
