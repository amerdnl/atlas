import React from 'react';
import { useCurrentFrame } from 'remotion';
import { CUE, FPS } from './timeline';
import { E, hit, prog, tw } from './lib/anim';
import { mono } from './fonts';

// A Claude Code session, drawn as a terminal. It drives the story: the prompt is sent, one agent
// works, it fans out to six subagents (on the same frames the fake collector reports them).

const C = {
  bg: '#141413', fg: '#E8E6DF', dim: '#8B887F', faint: '#5A5850',
  claude: '#D97757', green: '#7FB77E', red: '#E0605A', blue: '#7AA7D9', border: '#3A3935',
};

const PROMPT = 'refactor payments into a service, add tests, and fix the flaky CI job';
const TASKS = [
  'Write checkout unit tests', 'Extract PaymentService', 'Fix flaky CI job',
  'Update Stripe webhooks', 'Migrate refund flow', 'Review error handling',
];
const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

type Line = { at: number; node: React.ReactNode; key: string };

const Dot = ({ color }: { color: string }) => <span style={{ color }}>⏺ </span>;
const Sub = ({ children }: { children: React.ReactNode }) => (
  <span style={{ color: C.dim }}>{'  ⎿  '}{children}</span>
);

function lines(f: number): Line[] {
  const L: Line[] = [];
  const add = (at: number, key: string, node: React.ReactNode) => L.push({ at, key, node });
  add(CUE.enter, 'p', <span style={{ color: C.dim }}>{'> '}{PROMPT}</span>);
  add(CUE.enter + 2, 'sp0', <span> </span>);
  add(CUE.tool1, 't1', <><Dot color={C.green} /><b>Read</b>(src/payments/checkout.ts)</>);
  add(CUE.tool1 + 8, 't1r', <Sub>Read 214 lines</Sub>);
  add(CUE.tool2, 't2', <><Dot color={C.green} /><b>Update</b>(src/payments/checkout.ts)</>);
  add(CUE.tool2 + 8, 't2r', <Sub>Updated with <span style={{ color: C.green }}>38 additions</span> and <span style={{ color: C.red }}>12 removals</span></Sub>);
  add(CUE.plan, 'plan', <><Dot color={C.fg} />This splits cleanly. Launching 6 agents in parallel.</>);
  TASKS.forEach((t, i) => {
    const on = CUE.sub[i];
    const done = CUE.subsDone - (5 - i) * 14;
    add(on, `task${i}`, <><Dot color={f >= done ? C.green : C.claude} /><b>Task</b>({t})</>);
    add(on + 6, `task${i}r`, f >= done
      ? <Sub><span style={{ color: C.green }}>Done</span> · {12 + i * 7} tool uses · {(31 + i * 9.3).toFixed(1)}k tokens</Sub>
      : <Sub>Running… {Math.max(1, Math.floor((f - on) / 22))} tool uses</Sub>);
  });
  add(CUE.allDone, 'done', <><Dot color={C.fg} />All 6 agents finished. <span style={{ color: C.green }}>23 files changed</span>, 142 tests passing.</>);
  return L.filter((l) => f >= l.at);
}

export const Terminal: React.FC<{ width: number; height: number }> = ({ width, height }) => {
  const f = useCurrentFrame();
  const typed = Math.floor(tw(f, CUE.typeStart, CUE.typeEnd, 0, PROMPT.length, E.linear));
  const sent = f >= CUE.enter;
  const working = sent && f < CUE.allDone;
  const secs = Math.max(0, (f - CUE.enter) / FPS);
  const tokens = secs < 5 ? secs * 1.3 : 6.5 + (secs - 5) * 8.4;
  const shown = lines(f);
  const lh = 30;
  const enterFlash = hit(f - CUE.enter, 2, 10);
  // Scroll like a terminal: content height ≈ header + lines + spinner + input box.
  const contentH = (n: number) => 92 + n * lh + (sent ? 38 : 0) + 64;
  const room = height - 40 - 36;
  const eased = shown.reduce((acc, l) => acc + prog(f - l.at, 0, 10), 0);
  const scroll = Math.max(0, contentH(eased) - room);

  return (
    <div style={{
      width, height, background: C.bg, borderRadius: 14, border: `1px solid ${C.border}`, overflow: 'hidden',
      boxShadow: `0 40px 120px rgba(0,0,0,.65), 0 0 0 1px rgba(255,255,255,.04), 0 0 ${60 * enterFlash}px rgba(217,119,87,${0.5 * enterFlash})`,
      fontFamily: mono, fontSize: 19, color: C.fg, display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ height: 40, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', background: '#1C1C1A', borderBottom: `1px solid ${C.border}` }}>
        {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => <div key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />)}
        <div style={{ flex: 1, textAlign: 'center', color: C.dim, fontSize: 14, marginRight: 52 }}>claude — ~/dev/shop-api</div>
      </div>
      <div style={{ flex: 1, padding: '18px 24px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', overflow: 'hidden', lineHeight: `${lh}px` }}>
       <div style={{ transform: `translateY(${-scroll}px)` }}>
        <div style={{ border: `1px solid ${C.claude}`, borderRadius: 8, padding: '10px 16px', marginBottom: 14, alignSelf: 'flex-start', lineHeight: '26px' }}>
          <span style={{ color: C.claude }}>✻</span> Welcome to <b>Claude Code</b>
          <div style={{ color: C.dim, fontSize: 16 }}>cwd: ~/dev/shop-api</div>
        </div>
        {shown.map((l) => {
          const age = f - l.at;
          return (
            <div key={l.key} style={{ whiteSpace: 'pre', opacity: prog(age, 0, 6), transform: `translateY(${tw(age, 0, 10, 8, 0)}px)` }}>{l.node}</div>
          );
        })}
        {working && (
          <div style={{ color: C.claude, marginTop: 8 }}>
            {SPIN[Math.floor(f / 5) % SPIN.length]}{' '}
            {f < CUE.plan ? 'Refactoring…' : f < CUE.subsDone ? 'Orchestrating…' : 'Wrapping up…'}
            <span style={{ color: C.dim }}>{`  (${Math.floor(secs)}s · ↓ ${tokens.toFixed(1)}k tokens · esc to interrupt)`}</span>
          </div>
        )}
        <div style={{ marginTop: 12, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 14px', whiteSpace: 'pre' }}>
          <span style={{ color: C.dim }}>{'> '}</span>
          {!sent && PROMPT.slice(0, typed)}
          <span style={{ background: C.fg, opacity: (Math.floor(f / 30) % 2 === 0 || (f > CUE.typeStart && f < CUE.typeEnd)) ? 0.9 : 0 }}>{' '}</span>
        </div>
       </div>
      </div>
    </div>
  );
};
