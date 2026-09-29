// Exports every sync point from the picture's timeline for the soundtrack generator.
import fs from 'node:fs';
import { BPM, CUE, FPS, TOTAL } from '../src/timeline.ts';

fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/cues.json', JSON.stringify({ fps: FPS, bpm: BPM, total: TOTAL, cues: CUE }, null, 2));
console.log('wrote out/cues.json');
