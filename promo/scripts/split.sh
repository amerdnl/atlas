#!/bin/sh
# Split the 3×1080p panorama into one file per display (what each monitor shows in the app).
set -e
cd "$(dirname "$0")/.."
for i in 0 1 2; do
  name=$(echo "left center right" | cut -d' ' -f$((i + 1)))
  ffmpeg -y -loglevel error -i footage/panorama.mp4 -vf "crop=1920:1080:$((i * 1920)):0" \
    -c:v libx264 -preset slow -crf 12 -pix_fmt yuv420p -g 30 public/$name.mp4
done
echo split
