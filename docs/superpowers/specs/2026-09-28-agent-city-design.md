# agent-city — Design

A macOS live wallpaper: a procedural night city that stays dark and quiet while
no AI coding agents are running, and comes alive — windows lighting up, Tron-style
light streams flowing through the streets — as agents work. A stats overlay shows
Projects, Agents (with subagents), Tokens today and tokens/min.

Inspiration: https://x.com/internetphysics/status/2104305710079119649

## Goals

- Looks like the reference: high three-quarter aerial view of a dense night city,
  warm/cool window lights, glowing street light-trails, bloom.
- Reacts to real agent activity (herdr + Claude Code logs), smoothly.
- One continuous panorama across the user's three side-by-side 1080p displays.
- Cheap to run all day: throttled, pauses on sleep/lock.
- Publishable: works without herdr (falls back to Claude Code logs only).

## Non-goals

- Interaction with the wallpaper (it is click-through).
- Support for agents other than Claude Code for token counts (agent counts from
  herdr cover any herdr-detected agent).
- Windows/Linux.

## Repo layout

```
agent-city/
  app/          Swift Package (menu-bar app), built with `swift build`
  scene/        Three.js scene, plain ES modules, no build step (three vendored)
  collector/    Node (>=20) stats collector, zero dependencies
  Makefile      build / install (copies .app to ~/Applications, login item) / dev
  README.md, LICENSE (MIT)
```

## 1. Scene (`scene/`)

- **City generation**: seeded PRNG → fixed layout every launch. Street grid with
  blocks subdivided into lots. Density/height field peaks at a downtown cluster
  placed in the left third of the panorama, falling off toward the right into
  mid-rises, low blocks, a few dark park blocks, and one diagonal highway crossing
  the frame (as in the reference).
- **Buildings**: one `InstancedMesh` of boxes (plus a few setback/podium variants
  and rooftop details on the tallest towers). Window lights are procedural in the
  fragment shader: per-face grid from UVs × building size, per-window hash decides
  lit/unlit, warm (amber) vs cool (white-blue) tint, and a per-window "on threshold"
  so global activity `a` turns windows on progressively. District activity boosts
  thresholds locally.
- **Light streams (Tron)**: the core visual. Traffic is not cars but glowing
  ribbons: each stream is a head moving along the street graph (turning at
  intersections), with a long trail rendered as a tapered, additive-blended line
  strip whose brightness fades toward the tail. Colors: white/ice-blue on the
  highway and one direction, red/orange on the other, occasional cyan accents.
  Implementation: a fixed pool of N streams (N scales with activity, max ~600);
  trail history stored in a ring buffer texture/attribute, drawn as one batched
  geometry. Street surfaces get a faint glow along busy segments.
- **Post**: `UnrealBloomPass` (strength scales with activity), slight fog/haze,
  vignette. Ground is near-black with faint street lines.
- **States**:
  - Idle (`a = 0`): dim blue-grey, ~3% windows lit, a handful of slow streams.
  - Active: windows cluster-on, streams multiply and speed up, bloom rises.
  - All visual parameters ease toward targets over ~3s (no flicker).
- **Camera / multi-display**: one `PerspectiveCamera` at a fixed high three-quarter
  angle framing a 5760×1080 virtual canvas. Each display window loads
  `index.html?slice=<i>&of=<n>&fullW=5760&fullH=1080` and calls
  `camera.setViewOffset(fullW, fullH, i*1920, 0, 1920, 1080)`. Display geometry is
  passed by the app, so any arrangement of side-by-side displays works.
- **Overlay**: HTML/CSS in the slice that contains the showcase (left-most display
  by default): Projects · Agents (sub-label "N subagents · working") · Tokens today
  (large, thousands-separated, animated count-up) · "42k / min". SF Pro, white,
  subtle shadow, bottom-left, matching the reference.
- **Frame rate**: slice receives a target fps from the app (`?fps=`), and further
  drops to ~10 fps while `a == 0` and nothing is transitioning.
- **Standalone**: works in any browser; `?demo=1` cycles fake activity. With no
  collector reachable it stays idle and retries.

## 2. Activity mapping

Collector provides `working` (agents in working state), `subagents` (active
subagents), `projects`, `tokensToday`, `tokensPerMin`, and per-agent `cwd`s.

- `effective = working + 0.5 * subagents`
- `a = 0` if effective = 0, else `min(1, 0.45 + 0.2 * log2(effective))`
  (1 → 0.45, 2 → 0.65, 4 → 0.85, 6+ → ~1)
- `pulse = clamp(tokensPerMin / 100k, 0, 1)` → stream speed and window flicker rate.
- **Districts**: each working agent's cwd is hashed to one of ~8 city districts;
  that district gets an extra local boost so you can see *where* work happens.

## 3. Collector (`collector/`)

Node, no deps, polls every 2s, serves on `127.0.0.1:47823`:
`GET /stats` (JSON), `GET /events` (SSE, pushes on change), and static files
from `scene/` at `/`. Exits with code 3 if the port is already in use.

- **Agents (herdr)**: `herdr agent list` → JSON. `working` = agents whose
  `agent_status` is `working` (herdr statuses: idle | working | blocked | done | unknown;
  `blocked` = waiting on the user, not counted); `projects` = distinct project (cwd, worktrees folded into their repo)
  among working agents. If herdr is missing or errors → fallback.
- **Claude logs (always merged)**: main session `.jsonl` files under
  `~/.claude/projects/*/` modified in the last 30s count as working agents,
  unless herdr tracks that session id (`agent_session.value` = log filename),
  in which case herdr's status wins. Project keys use Claude's dir-name
  encoding (`cwd` with non-alphanumerics → `-`) for both sources.
- **Subagents**: `~/.claude/projects/*/*/subagents/agent-*.jsonl` modified in the
  last 30s. Overlay "Agents" = working agents + active subagents.
- **Tokens**: incremental tail of all `~/.claude/projects/**/*.jsonl` (per-file
  byte offset remembered; only files modified today are scanned). For each
  assistant message with `message.usage` and a timestamp in local today: add
  `input_tokens + output_tokens + cache_creation_input_tokens`
  (+ `cache_read_input_tokens` when `includeCacheRead` is true, default true to
  match the reference's magnitude). Dedupe by `message.id` (streaming writes can
  repeat a message). Resets at local midnight. `tokensPerMin` = sum over the last
  60s.
- Config: `~/.config/agent-city/config.json` (port, includeCacheRead,
  herdr path, showcase display). All optional.

## 4. App (`app/`, Swift, AppKit + WebKit)

- Menu-bar only (`LSUIElement`). On launch and on
  `NSApplication.didChangeScreenParametersNotification`: compute the union of all
  screens, sort by x, create one borderless `NSWindow` per screen with
  level `kCGDesktopWindowLevel`, `ignoresMouseEvents = true`,
  `collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]`,
  hosting a `WKWebView` loading the slice URL from the collector, which also
  serves the bundled `scene/` over HTTP (WebKit blocks ES modules from `file://`). Screen x-offsets/sizes are passed, not
  hard-coded 1920.
- Starts and supervises the collector (`node collector/index.js`), restart with
  backoff; locates node via `PATH` from a login shell.
- Throttling: fps 60 on showcase slice / 30 others; pause all (via JS
  `window.agentCity.pause()`) on `NSWorkspace.screensDidSleep`,
  `willSleep`, session resign-active (lock); resume on wake.
- Menu: Pause/Resume · Reload scene · Demo mode · Launch at login
  (`SMAppService.mainApp`) · Quit.
- Packaging: `make app` produces `AgentCity.app` (SwiftPM binary + Info.plist +
  bundled `scene/` and `collector/`), ad-hoc signed.

## 5. Error handling

- Collector unreachable → scene idle, overlay shows "—", retries every 5s.
- herdr failure → fallback path; logged once, not spammed.
- Malformed JSONL lines → skipped.
- Display change → windows rebuilt.

## 6. Testing

- Collector: `node --test` unit tests with fixture JSONL (usage summing, dedupe,
  midnight reset, cache-read toggle, subagent recency) and a mocked herdr output.
- Scene: open in a browser with `?demo=1` (and `?slice=`); verify visually with
  screenshots against the reference.
- App: manual smoke test on the 3-display setup (alignment across seams,
  click-through, spaces, sleep/wake).
