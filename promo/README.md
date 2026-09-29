# agent-city — launch film

A 30-second film of agent-city, plus the README GIF. The city in it is the real scene
(`../scene`), not a mock-up: it's captured frame by frame, then edited in
[Remotion](https://www.remotion.dev) onto three virtual displays with a synthesized soundtrack.
Inspired by [Leonxlnx/claude-launchvideo](https://github.com/Leonxlnx/claude-launchvideo).

| Time | What happens |
| --- | --- |
| 0:00 | A Claude Code session over the dark, idle city. The prompt is typed and sent. |
| 0:04 | One agent starts working; the windows light up. |
| 0:08 | The camera whips out to three displays: one panorama across all of them. |
| 0:09 | The agent fans out to six subagents, one per beat; the traffic speeds up. |
| 0:16 | Close-up on the stats overlay, then a sweep across the bezels. |
| 0:20 | The subagents finish, the agent reports back, and the city goes quiet. |
| 0:24 | End card. |

## How it's made

1. **Capture** (`capture/`). Puppeteer opens the unmodified scene at 5760×1080 (three 1080p
   displays). An injected script replaces the page clock (`performance.now`, `requestAnimationFrame`,
   timers) with a virtual one that steps exactly 1/60 s per frame, and swaps `EventSource` for a
   fake collector that serves the stats in `story.json`. Frames are piped into ffmpeg.
2. **Split** (`scripts/split.sh`). One file per display, the same slices the app renders.
3. **Film** (`src/`). `timeline.ts` is the single source of truth (60 fps, 120 BPM). Film time
   equals footage time, so the terminal's subagents land on the same frames the city reacts to.
   The displays, desk and reflections are CSS 3D under an orbit camera.
4. **Sound** (`scripts/soundtrack.py`). Pad, bass, drums, arps, key clicks and pings synthesized
   with numpy/scipy from the exported cues, normalized to −14 LUFS, muxed with ffmpeg.

## Run it

Needs Node 22+, ffmpeg, Google Chrome, and Python 3 for the soundtrack.

```bash
npm install
python3 -m venv .venv && .venv/bin/pip install numpy scipy soundfile pyloudnorm
npm run capture && sh scripts/split.sh   # ~5 min: footage/panorama.mp4 → public/{left,center,right}.mp4
npm run studio                          # preview
npm run render                          # out/agent-city-x.mp4 (1080p60, AAC)
npm run gif                             # ../docs/media/agent-city.gif
```

`node capture/capture.mjs --still 14` writes a single frame at 14 s to `out/` for quick checks.
