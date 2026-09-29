import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { CUE, s } from './timeline';
import { E, prog, tw } from './lib/anim';
import { sans } from './fonts';

// Kinetic captions: words rise in one after another, the whole line leaves together.
const LINES = [
  { from: CUE.reveal + 18, to: s(10.5), text: 'Your agents work.', accent: 'The city wakes up.' },
  { from: s(11), to: s(15.2), text: 'More agents,', accent: 'more light.' },
  { from: CUE.closeUp + 20, to: s(19.6), text: 'Tokens per minute', accent: 'drive the traffic.', top: true },
  { from: CUE.cap3, to: CUE.end - 4, text: 'When they rest,', accent: 'it rests.' },
];

export const Captions: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 92 }}>
      {LINES.map((l) => {
        if (f < l.from || f > l.to + 20) return null;
        const words = [...l.text.split(' ').map((w) => ({ w, acc: false })), ...l.accent.split(' ').map((w) => ({ w, acc: true }))];
        const leave = prog(f, l.to, l.to + 16, E.in);
        return (
          <div key={l.from} style={{ position: 'absolute', display: 'flex', ...('top' in l ? { top: 90 } : {}), gap: 18, fontFamily: sans, fontWeight: 600, fontSize: 64,
            letterSpacing: -1.5, color: '#fff', textShadow: '0 4px 40px rgba(0,0,0,.8)', opacity: 1 - leave,
            transform: `translateY(${-24 * leave}px)`, filter: `blur(${8 * leave}px)` }}>
            {words.map(({ w, acc }, i) => {
              const t0 = l.from + i * 5 + (acc ? 10 : 0);
              return (
                <span key={i} style={{ display: 'inline-block', color: acc ? '#FFB27A' : '#fff', opacity: prog(f, t0, t0 + 10),
                  transform: `translateY(${tw(f, t0, t0 + 16, 34, 0)}px)`, filter: `blur(${tw(f, t0, t0 + 12, 10, 0)}px)` }}>{w}</span>
              );
            })}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
