#!/bin/zsh
# restore_captions.sh <cat_720_779f.mp4> <source_720_779f.mp4> <out.mp4>
# Erase the model's redrawn caption letters (near-white pixels in the caption band),
# then lay the source's caption letters and their dark shadow back on, frame for frame.
# Band coordinates (BAND, delogo box) are for a 720x720 frame with captions at y~349-367
# (kazxw4124196076 clip, 2026-10-18); measure and adjust them for other clips.
# Both inputs must be the same size and frame count (stretch the model output first).
CAT=$1; SRC=$2; OUT=$3
BAND="between(Y,340,378)*between(X,120,600)"
ffmpeg -v error -y -i "$CAT" -i "$SRC" -filter_complex "
[0:v]format=gbrp,split=3[base][tofill][forcm];
[tofill]delogo=x=120:y=342:w=480:h=34[filled];
[forcm]extractplanes=g+b+r[cg][cb][cr];[cg][cb]blend=all_mode=darken[cgb];[cgb][cr]blend=all_mode=darken[cmin];
[cmin]geq=lum='if(${BAND}*gt(p(X,Y),205),255,0)',dilation,dilation,dilation,gblur=sigma=1.2,format=gbrp[cmask];
[base][filled][cmask]maskedmerge[erased];
[1:v]format=gbrp,split=2[srgb][forsm];
[forsm]extractplanes=g+b+r[sg][sb][sr];[sg][sb]blend=all_mode=darken[sgb];[sgb][sr]blend=all_mode=darken[smin];
[smin]geq=lum='if(${BAND},clip((p(X,Y)-170)*255/58,0,255),0)',split=2[lmask0][shad0];
[shad0]dilation,dilation,gblur=sigma=1.5,lut=y='val*0.75',format=gbrp[smask];
[lmask0]format=gbrp[lmask];
color=c=black:s=720x720:r=30,format=gbrp[blk];
[erased][blk][smask]maskedmerge[shadowed];
[shadowed][srgb][lmask]maskedmerge,format=yuv420p[v]" -map "[v]" -frames:v 779 -c:v libx264 -crf 16 "$OUT"
