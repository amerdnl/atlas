// Single source of truth for timing. 60 fps, 120 BPM → 1 beat = 30 frames, 1 bar = 120 frames.
// Film time == footage time: the captured city (story.json) plays underneath, frame for frame.
// The soundtrack reads the exported cues (scripts/export-cues.ts → out/cues.json).
import story from '../story.json' with { type: 'json' };

export const FPS = 60;
export const BPM = 120;
export const W = 1920;
export const H = 1080;
export const TOTAL = story.seconds * FPS; // 30 s

/** Frame at 1-indexed bar, beat offset (beats may be fractional). */
export const b = (bar: number, beat = 0) => Math.round(((bar - 1) * 4 + beat) * 30);
export const s = (sec: number) => Math.round(sec * FPS);

/** Frame the fake collector reports each change (agent starts, each subagent...). */
export const statFrame = (i: number) => s(story.stats[i].t);

export const CUE = {
  termIn: b(1, 0.5), // terminal fades up over the dark city
  typeStart: b(1, 2),
  typeEnd: b(2, 3),
  enter: b(3), // 4.0s  prompt sent — drop 1
  agentOn: statFrame(1), // 4.4s  collector sees the agent
  tool1: b(3, 1.5),
  tool2: b(3, 3.5),
  plan: b(4, 2),
  reveal: b(5), // 8.0s  camera whips out to three displays — drop 2
  sub: [2, 3, 4, 5, 6, 7].map(statFrame), // 9.0 … 15.0s  one subagent each
  cap1: b(6),
  cap2: b(8, 2),
  closeUp: b(9), // 16.0s dolly the overlay
  sweep: b(10), // 18.0s sweep across the bezels
  subsDone: statFrame(8), // 20.2s
  allDone: statFrame(9), // 21.6s
  cap3: b(12),
  end: b(13), // 24.0s end card — resolve
  url: b(14),
  final: b(15, 2),
};
