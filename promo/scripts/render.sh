#!/bin/sh
# Full render: cues → soundtrack → picture (muted) → mux + X-friendly encode.
set -e
cd "$(dirname "$0")/.."
node scripts/export-cues.ts
.venv/bin/python scripts/soundtrack.py
npx remotion render src/index.ts Launch out/picture.mp4 --muted --codec h264 --crf 10 --x264-preset slow
# The soundtrack is muxed here (not by Remotion) so there is no AAC priming offset vs. the picture.
ffmpeg -y -loglevel error -i out/picture.mp4 -i public/audio/soundtrack.wav \
  -map 0:v -map 1:a -c:v libx264 -preset slow -crf 17 -maxrate 20M -bufsize 40M -pix_fmt yuv420p \
  -profile:v high -c:a aac -b:a 320k -ar 48000 -movflags +faststart -shortest out/agent-city-x.mp4
echo "wrote out/agent-city-x.mp4"
