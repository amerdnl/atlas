import React from 'react';
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame } from 'remotion';
import { Terminal } from './Terminal';
import { Captions } from './Captions';
import { EndCard } from './EndCard';
import { activity } from './activity';
import { CUE, s } from './timeline';
import { E, hit, keys, mix, prog } from './lib/anim';

// World units are CSS px. y points down; the camera sits at +z looking toward -z.
const P = 1400; // perspective: an object `P` px from the camera renders 1:1
const SW = 1600, SH = 900, BZ = 12; // screen and bezel
const OW = SW + 2 * BZ, OH = SH + 2 * BZ;
const GAP = 22, ANGLE = 30; // side displays angle in toward you
const DESK = 740; // desk surface (y)
const rad = (d: number) => (d * Math.PI) / 180;

// Three displays side by side; each shows its own slice of the one panorama (as the app does).
const inner = OW / 2 + GAP / 2;
const side = (sign: -1 | 1) => ({
  x: sign * (inner + (OW / 2) * Math.cos(rad(ANGLE))),
  z: (OW / 2) * Math.sin(rad(ANGLE)),
  ry: sign * -ANGLE,
});
const DISPLAYS = [
  { name: 'left', ...side(-1) },
  { name: 'center', x: 0, z: 0, ry: 0 },
  { name: 'right', ...side(1) },
];
const TERM = { x: -470, y: 110, z: 560, w: 1040, h: 640 };

/** World point on the left display, from pixel coords in its 1920×1080 footage. */
const onLeft = (px: number, py: number) => {
  const d = DISPLAYS[0], lx = (px / 1920 - 0.5) * SW, ly = (py / 1080 - 0.5) * SH;
  return { tx: d.x + lx * Math.cos(rad(d.ry)), ty: ly, tz: d.z - lx * Math.sin(rad(d.ry)) };
};
const overlay = onLeft(330, 950);

// Orbit camera: target point, distance, yaw/pitch (deg).
type Cam = { tx: number; ty: number; tz: number; d: number; yaw: number; pitch: number };
const CAM = (f: number) => keys<Cam>(f, [
  { f: 0, v: { tx: TERM.x, ty: TERM.y, tz: TERM.z, d: 1120, yaw: 4, pitch: 0 } },
  { f: CUE.enter, v: { tx: TERM.x + 20, ty: TERM.y, tz: TERM.z, d: 1010, yaw: 1, pitch: 0 }, ease: E.smooth },
  { f: CUE.reveal - 12, v: { tx: -200, ty: 40, tz: 250, d: 2250, yaw: 10, pitch: 3 } },
  { f: CUE.reveal + 50, v: { tx: 0, ty: 170, tz: 200, d: 3900, yaw: -14, pitch: 2.5 }, ease: E.inOut },
  { f: CUE.closeUp - 20, v: { tx: 0, ty: 170, tz: 200, d: 3500, yaw: 14, pitch: 2 }, ease: E.smooth },
  { f: CUE.closeUp + 40, v: { ...overlay, d: 760, yaw: -ANGLE + 4, pitch: 0 }, ease: E.inOut },
  { f: CUE.sweep, v: { ...overlay, tx: overlay.tx + 80, d: 700, yaw: -ANGLE + 2, pitch: 1 }, ease: E.smooth },
  { f: CUE.sweep + 40, v: { tx: DISPLAYS[0].x, ty: -60, tz: DISPLAYS[0].z, d: 1500, yaw: -ANGLE, pitch: -3 }, ease: E.inOut },
  { f: CUE.subsDone, v: { tx: DISPLAYS[2].x, ty: -60, tz: DISPLAYS[2].z, d: 1500, yaw: ANGLE, pitch: -3 }, ease: E.smooth },
  { f: CUE.allDone + 60, v: { tx: 0, ty: 170, tz: 200, d: 3800, yaw: 0, pitch: 2.5 }, ease: E.inOut },
  { f: CUE.end, v: { tx: 0, ty: 170, tz: 200, d: 4000, yaw: 0, pitch: 3 }, ease: E.smooth },
  { f: s(30), v: { tx: 0, ty: 190, tz: 200, d: 4800, yaw: 0, pitch: 6 }, ease: E.smooth },
]);

const place = (x: number, y: number, z: number, w: number, h: number, extra = '') => ({
  position: 'absolute' as const, left: 0, top: 0, width: w, height: h, transformStyle: 'preserve-3d' as const,
  transform: `translate3d(${x - w / 2}px, ${y - h / 2}px, ${z}px) ${extra}`,
});

const Screen: React.FC<{ name: string; a: number }> = ({ name, a }) => (
  <div style={{ width: OW, height: OH, background: '#0B0C0F', borderRadius: 16, padding: BZ, boxSizing: 'border-box',
    boxShadow: `0 0 0 1.5px #24262C, 0 0 ${140 * a}px ${30 * a}px rgba(255,170,110,${0.1 * a})` }}>
    <div style={{ position: 'relative', width: SW, height: SH, borderRadius: 4, overflow: 'hidden', background: '#05070b' }}>
      <OffthreadVideo src={staticFile(`${name}.mp4`)} muted style={{ width: SW, height: SH, display: 'block' }} />
      {/* glass: a soft diagonal sheen */}
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(115deg, rgba(255,255,255,.07) 0%, rgba(255,255,255,0) 38%, rgba(255,255,255,0) 70%, rgba(255,255,255,.03) 100%)' }} />
    </div>
  </div>
);

const Display: React.FC<{ d: (typeof DISPLAYS)[number]; a: number; mirror?: boolean }> = ({ d, a, mirror }) => (
  <div style={place(d.x, 0, d.z, OW, OH, `rotateY(${d.ry}deg)`)}>
    {!mirror && (
      <>
        {/* neck + foot */}
        <div style={{ ...place(OW / 2, (OH / 2 + DESK) / 2 + OH / 2 - 60, -70, 110, DESK - OH / 2 + 80), background: 'linear-gradient(90deg,#15171b,#23262c 50%,#15171b)', borderRadius: 6 }} />
        <div style={{ ...place(OW / 2, DESK + OH / 2 - 1, -30, 460, 260, 'rotateX(90deg)'), background: 'radial-gradient(ellipse at center,#1d2025,#121418)', borderRadius: 22 }} />
      </>
    )}
    <Screen name={d.name} a={a} />
  </div>
);

export const Launch: React.FC = () => {
  const f = useCurrentFrame();
  const a = activity(f);
  const cam = CAM(f);
  const punch = hit(f - CUE.enter, 2, 8) * 0.012 + hit(f - CUE.reveal, 3, 10) * 0.02;
  const world = `translateZ(${P - cam.d}px) rotateX(${cam.pitch}deg) rotateY(${cam.yaw}deg) translate3d(${-cam.tx}px, ${-cam.ty}px, ${-cam.tz}px)`;
  const termOut = prog(f, CUE.closeUp - 40, CUE.closeUp + 10, E.in); // terminal steps aside for the close-up…
  const termBack = prog(f, CUE.allDone - 90, CUE.allDone - 30); // …and comes back for "done"
  const termVis = Math.max(1 - termOut, termBack) * (1 - prog(f, CUE.end - 10, CUE.end + 30, E.in));
  const endDim = prog(f, CUE.end, CUE.end + 60, E.smooth);

  // Warm room light that follows the city's brightness.
  const glow = `radial-gradient(ellipse 70% 55% at 50% 45%, rgba(255,150,90,${0.10 * a}) 0%, rgba(40,70,140,${0.05 + 0.05 * a}) 45%, rgba(0,0,0,0) 75%)`;

  return (
    <AbsoluteFill style={{ background: '#030406' }}>
      <AbsoluteFill style={{ background: glow }} />
      <AbsoluteFill style={{ perspective: P, perspectiveOrigin: '50% 50%', overflow: 'hidden', transform: `scale(${1 + punch})`,
        filter: `brightness(${1 - 0.55 * endDim}) blur(${endDim * 6}px)` }}>
        <div style={{ position: 'absolute', left: 960, top: 540, width: 0, height: 0, transformStyle: 'preserve-3d', transform: world }}>
          {/* reflections in the desk */}
          <div style={{ position: 'absolute', transformStyle: 'preserve-3d', transform: `translateY(${2 * DESK}px) scaleY(-1)`, opacity: 0.16 }}>
            {DISPLAYS.map((d) => <Display key={d.name} d={d} a={a} mirror />)}
          </div>
          {/* desk */}
          <div style={{ ...place(0, DESK, 300, 9000, 4000, 'rotateX(90deg)'),
            background: `radial-gradient(ellipse 30% 22% at 50% 50%, rgba(255,160,100,${0.05 * a}), rgba(8,9,12,.82) 60%, rgba(3,4,6,1) 100%)` }} />
          {DISPLAYS.map((d) => <Display key={d.name} d={d} a={a} />)}
          <div style={{ ...place(TERM.x, TERM.y + mix(0, 900, termOut * (1 - termBack)), TERM.z, TERM.w, TERM.h, 'rotateY(6deg)'), opacity: termVis }}>
            <Terminal width={TERM.w} height={TERM.h} />
          </div>
        </div>
      </AbsoluteFill>
      <Captions />
      <EndCard />
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,.55) 100%)', pointerEvents: 'none' }} />
      <AbsoluteFill style={{ background: '#000', opacity: 1 - prog(f, 0, 24, E.smooth) }} />
    </AbsoluteFill>
  );
};
