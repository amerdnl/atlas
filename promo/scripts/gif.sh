#!/bin/sh
# README GIF: the left display (downtown + stats overlay) going from idle → busy → idle.
# Plays the capture at 2.5× so the whole arc fits in ~9 s and loops on the dark city.
# The city's fine window detail is hard on GIF: 640 px, 12 fps and ordered dither keep it under 10 MB.
set -e
cd "$(dirname "$0")/.."
SRC=public/left.mp4 OUT=../docs/media/agent-city.gif
mkdir -p "$(dirname $OUT)"
FILTER="trim=start=2.5:end=25,setpts=(PTS-STARTPTS)/2.5,fps=12,scale=640:-1:flags=lanczos"
ffmpeg -y -loglevel error -i $SRC -vf "$FILTER,palettegen=max_colors=96:stats_mode=diff" out/palette.png
ffmpeg -y -loglevel error -i $SRC -i out/palette.png -lavfi "$FILTER [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 $OUT
ls -lh $OUT
