import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { CUE } from './timeline';
import { E, hit, prog, tw } from './lib/anim';
import { mono, sans } from './fonts';

/** The mark: three towers, windows lighting up one by one, a light stream along the street. */
const Mark: React.FC<{ f: number; size: number }> = ({ f, size }) => {
  const towers = [{ x: 4, w: 18, h: 40 }, { x: 26, w: 22, h: 60 }, { x: 52, w: 16, h: 30 }];
  let n = 0;
  return (
    <svg width={size} height={size} viewBox="0 0 72 72">
      {towers.map((t, i) => {
        const rise = prog(f, CUE.end + i * 6, CUE.end + 24 + i * 6);
        const h = t.h * rise, y = 64 - h;
        const wins = [];
        for (let r = 0; r < Math.floor(t.h / 8); r++)
          for (let c = 0; c < Math.floor(t.w / 7); c++) {
            const k = n++, on = f > CUE.end + 26 + ((k * 7) % 23) * 2;
            const wy = 64 - t.h + 5 + r * 8;
            if (wy >= y) wins.push(<rect key={`${r}-${c}`} x={t.x + 3 + c * 7} y={wy} width={3} height={4} fill={on ? '#FFC98F' : '#20242C'} />);
          }
        return <g key={i}><rect x={t.x} y={y} width={t.w} height={h} rx={1.5} fill="#11141A" stroke="#2A2F38" strokeWidth={0.8} />{wins}</g>;
      })}
      <rect x={2} y={66} width={68 * prog(f, CUE.end + 30, CUE.end + 56, E.inOut)} height={2.2} rx={1.1} fill="#FF6A3D" />
    </svg>
  );
};

export const EndCard: React.FC = () => {
  const f = useCurrentFrame();
  if (f < CUE.end) return null;
  const word = prog(f, CUE.end + 20, CUE.end + 50);
  const tag = prog(f, CUE.end + 50, CUE.end + 76);
  const url = prog(f, CUE.url, CUE.url + 26);
  const pulse = hit(f - CUE.end, 2, 14);
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', fontFamily: sans, color: '#fff' }}>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 40% 30% at 50% 50%, rgba(255,120,60,${0.12 * pulse}), rgba(0,0,0,0) 70%)` }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 34 }}>
        <Mark f={f} size={150} />
        <div style={{ fontSize: 124, fontWeight: 600, letterSpacing: -4, opacity: word, transform: `translateX(${tw(f, CUE.end + 20, CUE.end + 56, -30, 0)}px)`,
          filter: `blur(${(1 - word) * 10}px)` }}>
          agent<span style={{ color: '#FF8A50' }}>-</span>city
        </div>
      </div>
      <div style={{ marginTop: 26, fontSize: 38, fontWeight: 500, color: 'rgba(255,255,255,.78)', letterSpacing: -0.5, opacity: tag,
        transform: `translateY(${(1 - tag) * 16}px)` }}>
        A live wallpaper that comes alive while your AI agents work.
      </div>
      <div style={{ marginTop: 54, display: 'flex', gap: 22, alignItems: 'center', fontFamily: mono, fontSize: 28, opacity: url,
        transform: `translateY(${(1 - url) * 12}px)` }}>
        <span style={{ color: '#fff' }}>github.com/dorukanc/agent-city</span>
        <span style={{ color: 'rgba(255,255,255,.4)' }}>·</span>
        <span style={{ color: 'rgba(255,255,255,.6)' }}>macOS · open source</span>
      </div>
    </AbsoluteFill>
  );
};
