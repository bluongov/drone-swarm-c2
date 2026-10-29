<div align="center">

[Español](README.md) | **English**

# 🛰️ Drone Swarm Mission Control (SWARM C2)

An interactive 3D dashboard that simulates the **command center of an autonomous drone swarm**.<br>
The setting is Valencia's Ciutat de les Arts i les Ciències, reconstructed as voxels; open the app with a double-click, with no build or installation.

[![Live demo](https://img.shields.io/badge/▶_live_demo-bluongov.github.io%2Fdrone--swarm--c2-3ff0ff?style=for-the-badge)](https://bluongov.github.io/drone-swarm-c2/)

![stack](https://img.shields.io/badge/stack-Three.js%20r160-3ff0ff) ![deps](https://img.shields.io/badge/install-none-ffcc33) ![build](https://img.shields.io/badge/build-none-4dff9a)

![Demo](assets/demo.gif)

<sub>Higher-quality video: [`assets/demo.mp4`](assets/demo.mp4)</sub>

</div>

---

## 📌 Why this project exists

It started as an **ambient display for the desk**: something visual, technical and always moving for a secondary monitor. It also works as a demo and as a hands-on exercise in:

- **3D graphics in the browser** with Three.js (post-processing, multi-view rendering, instanced geometry).
- **Swarm algorithms** (Reynolds boids) with mission modes, obstacle avoidance and geofencing.
- **Mission-control HUD design**: telemetry, tactical map, artificial horizon and a system log.

Design goals:
- **Alive**: it never stands still. Drones take off, patrol, switch missions and fly back to recharge.
- **Believable**: the telemetry, logs and terminology (boids, EKF2, SLAM, geofence, MAVLink, RTK) come from the real UAV/robotics world, even though the data is simulated.
- **Interactive**: you can click, switch modes and type commands in a built-in terminal.
- **Zero friction**: no build or installation; just double-click `index.html`.

> ⚠️ **Everything is simulated.** It does not connect to any real drones, networks or systems. Log messages and telemetry values are generated procedurally.

---

## 🚀 Getting started

**Online:** 👉 **https://bluongov.github.io/drone-swarm-c2/**

**Locally:**
```bash
git clone git@github.com:bluongov/drone-swarm-c2.git
cd drone-swarm-c2

# Static server (required: the simulation is an ES module, sim-core.js, and file:// cannot load it)
python3 -m http.server 8080   # → http://localhost:8080
```

Then press **`F`** for fullscreen and leave it running.

**Requirements:** a modern browser with WebGL (Chrome, Edge or Firefox) and an **internet connection**, because Three.js is loaded from the jsDelivr CDN.

---

## 🖥️ Server mode (optional)

Without parameters everything runs in the browser as before. With `?server=ws://host:port` the page stops simulating and **renders what a server sends**: drones, missions and the map come from a Node backend with a database. It is the groundwork for injecting real telemetry later.

- **Database:** PostgreSQL 17 + PostGIS + TimescaleDB (Docker). Stores the site (OSM grid, heights, formulas, NFZ polygons) and telemetry (hypertable).
- **Server-side simulation:** uses the same `sim-core.js` as the browser, so the swarm behaves like the demo.
- **Missions:** waypoint route validated against the NFZs (PostGIS) and the buildings before launch.
- **External telemetry:** `POST /ingest` or `WS /ingest` with `{droneId, lat, lon, alt_m, …}`; those drones show up as `EXT-…`.

```bash
cp .env.example .env            # local credentials (never committed)
npm install
npm run db:up && npm run db:migrate
node tools/export-site.mjs      # heights + landmarks from the frontend (Playwright)
npm run db:load
npm run server                  # → open http://127.0.0.1:3000/ (the server also serves the page)
```

In the C2 console: `mission demo`, `mission start`, `mission status`, `mission abort`. Architecture and plan: [`docs/architecture.md`](docs/architecture.md), [`docs/implementation-plan.md`](docs/implementation-plan.md). Tests: `npm test`. All telemetry is still simulated except what is injected through `/ingest`.

---

## 🎮 Keyboard & mouse controls

| Key / action | What it does |
|---|---|
| **Click on the ground** | In `PATROL` it inserts a priority waypoint. In the other modes the swarm switches to **orbiting** that point. Near a building, `ORBIT` snaps to that landmark. |
| **Drag / wheel** | 3D: rotate and zoom the camera (OrbitControls). 2D: pan and zoom the map |
| `1` `2` `3` `4` | `PATROL` · `ORBIT` · `FORMATION` · `SCAN` mode |
| `C` | Toggle between the orbital overview and the **chase camera** on the selected drone |
| `V` | Toggle between the **3D** perspective view and the **2D** top-down view: orthographic camera from above, north up, same scene and same HUD. The minimap shows the visible area |
| `R` | **Lock the camera**: no auto-rotation (by default a back-and-forth sweep of ±45° around the view, see `sweep`) and no swarm following (press `R` again to re-enable). In 2D, with following on, the map pans towards the swarm by itself; `C` centres it on the selected drone |
| `Tab` | With a second swarm, switch the selected swarm (A/B) |
| `A` | Turn automatic mode rotation (every 50 s) on or off |
| `H` | Hide or show the HUD (leaves only the 3D scene) |
| `F` | Fullscreen |
| `Enter` or `/` | Open the built-in terminal to type commands |
| `Esc` | Leave the terminal |
| Click a *Fleet Matrix* cell | Select that drone (FPV camera, horizon and telemetry) |
| **On-screen buttons** (touch/mobile) | `PATROL` `ORBIT` `FORM` `SCAN` · `A`/`B` (selected swarm, only with BRAVO) · `CAM` (chase) · `2D` (top-down view) · `LOCK` (camera lock) · `HUD` (hides panels, leaving just the scene and top bar) |

---

## 💻 Built-in terminal commands

The bottom strip has two separate panels:

- **SYSTEM LOG**: simulation events and fleet chatter. Filters `ALL` / `EVENTS` (no chatter) / `ALERTS` (warnings and errors only). Hovering it **pauses** it (`❚❚ PAUSED`) so you can scroll; leaving it goes back to `● LIVE`. Clicking a `UAV-xx` puts it in FOCUS UNIT and the FPV feed.
- **C2 CONSOLE** (`c2@halcyon:~$`): the terminal. Press `Enter` (or `/`), type, and press `Enter` again. Replies show up here instead of getting lost in the chatter; changes with an effect (mission, fleet, camera…) are also recorded in the SYSTEM LOG. `Tab` completes commands and arguments (a second `Tab` lists options), `↑`/`↓` browse the history and the buttons below run common commands (handy on touch screens).

| Command | Example | Description |
|---|---|---|
| `help` | `help` | List the commands |
| `drones=N` | `drones=40` · `drones 5` | Change the swarm size **live** (1–150). New drones take off in a staggered sequence and extra ones are removed. |
| `mode=...` | `mode=orbit` · `mode scan` | `patrol`, `orbit`, `formation` or `scan` |
| `orbit=CODE` (`target=`) | `orbit=ago` · `orbit assut` | Run `orbit` alone to list landmarks; target by code, id or part of the name (accents are ignored). Codes: `pal`, `mus`, `umb`, `ago`, `ast`, `oce`. `orbit=hmf` is denied because of NFZ-A. |
| `quality=low\|high` | `quality=low` | `low` uses 1x resolution and turns off bloom (**more FPS**) |
| `name=TEXT` | `name=Skynet` | Change the project name in the header (24 characters max) |
| `auto=on\|off` | `auto=off` | Automatic mode rotation |
| `view=2d\|3d` | `view=2d` | 2D top-down view or 3D perspective (same as `V`) |
| `still=on\|off` | `still=on` | Locked camera: no rotation or following (same as `R`) |
| `rotate=on\|off` · `follow=on\|off` | `rotate=off` | 3D camera auto-rotation and swarm following, separately |
| `sweep=DEGREES` | `sweep=30` · `sweep=0` | Auto-rotation sweep amplitude (±N°); `0` = full 360° rotation |
| `swarm2=N\|off` | `swarm2=30` | Second swarm BRAVO (1–80 drones) or recall it |
| `role=friendly\|hostile` | `role=hostile` | BRAVO as a friendly fleet or as intruders (ALPHA intercepts) |
| `sel=a\|b` | `sel=b` | Swarm that receives `mode=`, `orbit=`, `1-4` and clicks (same as `Tab`) |
| `site=cac\|levante` | `site=levante` | Switch site (reloads the page; in server mode the server decides: `SITE_ID=levante npm run server`) |
| `status` | `status` | Summary: active, RTB and charging drones, mode, quality and FPS |
| `clear` | `clear` · `clear=log` · `clear=all` | Clear the console, the SYSTEM LOG or both |

Both `drones=40` and `drones 40` work. When the browser allows it, changes to `drones`, `name` and `quality` are saved in the URL, so they survive a refresh. Some browsers block this over `file://`; in that case use a local server.

---

## 🔗 URL parameters

Use these to start with a preset configuration:

```
index.html?name=SKYNET&drones=40&quality=low
```

| Parameter | Default | Description |
|---|---|---|
| `name` | `HALCYON` | Project name |
| `drones` | `60` (`30` on mobile/touch) | Number of drones (1–150) |
| `quality` | `high` (`low` on mobile/touch) | `low` for less powerful machines |
| `view` | `3d` | `2d` starts in the top-down view |
| `still` | — | `1` starts with the camera locked (same as `rotate=0&follow=0`) |
| `rotate`, `follow` | `1` | `0` turns off auto-rotation or swarm following |
| `sweep` | `45` | Auto-rotation sweep in degrees (`0` = 360°) |
| `swarm2` | `0` | Drones in the second swarm BRAVO (0 = off) |
| `role2` | `friendly` | `hostile` starts BRAVO as intruders |
| `site` | `cac` | `levante` loads the second site (Estadi Ciutat de València · Orriols) |
| `seed` | — | Integer: reproducible simulation (seeded random numbers) |
| `embed` | — | `1` disables wheel zoom (for embedding in an `<iframe>` without hijacking page scroll) |

---

## ⚡ Performance

If it runs slowly:
1. `quality=low` in the terminal (bloom is the most expensive part).
2. `drones=30` or fewer.
3. `H` hides the HUD, which also stops rendering the FPV camera (one fewer render per frame).

The voxel city uses instancing and is lightweight on a GPU: about 38,000 landmark cubes and 9,000 city boxes. Software/headless WebGL rendering without a GPU is much slower. The FPS counter is at the top right and is also shown by `status`.

---

## 📱 Responsive

The HUD rearranges itself to the screen size and orientation:

| Screen | Layout |
|---|---|
| **Landscape** (desktop, laptop) | Side columns (status/fleet · map/FPV/focus), scene in the middle, log + telemetry at the bottom. Columns narrow on smaller screens and panels compact at heights ≤ 860 px. |
| **Portrait monitor / tablet** | Full-width scene on top with the panels in a 3-column band below (status/fleet · map/telemetry · FPV/focus), and a full-width log + console at the very bottom. |
| **Phone portrait** | Compact bar, 6 stats in one row, scene with a corner minimap, touch buttons, a short log and a one-line console. |
| **Phone landscape** | Scene, side map and touch buttons. |

The 3D camera **re-frames itself** to the free area: it centers the projection with `camera.setViewOffset`, fits the FOV to the available width and, when the area is tall and narrow, pulls back and tilts more top-down. That way the panels never cover the city.

## 🧩 What's on screen

```
┌──────────────────────────── PROJECT X // AUTONOMOUS SWARM C2 ── MODE ── UTC ── T+ ── FPS ─┐
│ SWARM STATUS  │                                              │ TACTICAL MAP (radar,       │
│ (active, RTB, │                                              │ coverage, NFZ, routes)     │
│ charging, bat,│            3D SCENE (Three.js)               ├────────────────────────────┤
│ link, cover.) │   Valencia voxels · drones · NFZ · base      │ FPV FEED (drone camera)    │
├───────────────┤                                              ├────────────────────────────┤
│ FLEET MATRIX  │                                              │ FOCUS UNIT (artificial     │
│ (bat/state    │                                              │ horizon + telemetry)       │
│ per drone)    │                                              │                            │
├───────────────┴─────────────────┬────────────────────────────┼────────────────────────────┤
│ SYSTEM LOG (filters, pause)     │ C2 CONSOLE (commands)      │ TELEMETRY (THRPT/ALT/LAT)  │
└─────────────────────────────────┴────────────────────────────┴────────────────────────────┘
```

- **3D scene**: the Ciutat de les Arts i les Ciències buildings and Valencia city are represented with voxels and a glowing lattice. Red warning beacons mark the top of every landmark and the 14 tallest city towers (≥ 60 m); two NFZs, a charging base with landing pads, and drones with status LEDs, strobes and trails complete the scene.
- **Selected drone**: ring, scan cone down to the ground and a floating label. It changes every 10 s.
- **“RETASKING SWARM” banner** whenever the mission changes.

## 🛸 Second swarm (BRAVO)

Optional and off by default: `swarm2=N` in the terminal or the URL (1–80 drones).

- **Friendly BRAVO** (orange, `BRV-xx`): its own base NE of the Oceanogràfic (≈ 39.45458, −0.34602), missions independent from ALPHA (auto-tasking avoids both flying the same mode) and orange diamonds on the map. `Tab`, the `A/B` button or `sel=a|b` choose which swarm receives `1-4`, `mode=`, `orbit=` and ground clicks; the header marks the selected one with `▸`.
- **Hostile BRAVO** (`role=hostile`, red, `TRK-xx`): intruders that ignore the geofence (each `GEOFENCE BREACH` is logged) and fly in three groups towards landmarks or the ALPHA base. Up to 40 % of ALPHA breaks off to intercept them (red dashed lines); an interceptor that stays within 20 m for 3 s forces the intruder back to its base (`NEUTRALIZED`), where it recharges and takes off again. Intruders cannot be commanded and are left out of the fleet stats.
- Separation between both swarms is always on; alignment and cohesion only within each swarm.

## 🏛️ The setting: City of Arts and Sciences

The simulation is set at the complex in Valencia and its real urban surroundings. The Calatrava and Candela silhouettes are generated from implicit shape-in-space formulas, `f(u, v, z, T) → material`, defined in `cac-shapes.js`. That file is generated from the author's companion project `calatrava-voxels`. At startup, the formulas are sampled on a shared grid of 2 m cubes (3 m on phones/touch); only cubes with an empty neighbour are drawn. This produces about 38,000 surface cubes, one `InstancedMesh` per building, with a sampling cost of about 60 ms. First the city rises, then each landmark is printed layer by layer; the log records `SITE MODEL: … voxels @ 2 m`.

| Code | Building | Architect / year |
|---|---|---|
| `PAL` (`pal`) | Palau de les Arts Reina Sofía | Santiago Calatrava, 2005 |
| `HMF` (`hmf`) | L'Hemisfèric (NFZ-A) | Santiago Calatrava, 1998 |
| `MUS` (`mus`) | Museu de les Ciències | Santiago Calatrava, 2000 |
| `UMB` (`umb`) | L'Umbracle | Santiago Calatrava, 2001 |
| `AGO` (`ago`) | L'Àgora | Santiago Calatrava, 2009 |
| `AST` (`ast`) | Pont de l'Assut de l'Or | Santiago Calatrava, 2008 |
| `OCE` (`oce`) | L'Oceanogràfic: Restaurant Submarí, Edifici d'Accés, Aiguamolls aviary and Àrtic | Félix Candela, 2003 (shells and domes) |

The surroundings are based on **OpenStreetMap**. `tools/osm-city.py` downloads data from Overpass (Python standard library only) and rasterizes it into two 550×550 grids of 4 m cells (2.2 km square): about 19,000 buildings, with height from `height` or `building:levels` × 3.1 m, and land cover (parks, trees, water/pools, roads, rail and sand). Buildings already modelled with formulas are excluded. The data is gzip + base64 encoded in `assets/valencia-city.js` (~60 KB); the browser decodes it with `DecompressionStream('gzip')`. Equal-height cells are merged into about 9,000 stretched boxes, and land cover is drawn as a pixel texture on the ground. The grid is rotated −40.5° to align with the complex.

- **Base**: the launch pads are in Jardí del Túria park, northeast of the Museu (≈ 39.45688, −0.35040).
- **RTK-GNSS station**: a green mast and beacon, shown as a diamond on the map, stands on the pin at 39.457442, −0.355547 (the pool in front of Palau de les Arts).
- **Geofence**: NFZ-A is a cylinder 92 m in radius and 220 m high over L'Hemisfèric; its voxels are tinted red and it cannot be orbited. NFZ-B is a random temporary flight restriction (TFR).
- **Scale and coordinate frames**: the site frame uses metres, X east and Y north; its origin is 39.45472, −0.3525, with an equirectangular projection. The OSM grid rotates −40.5° around the base. In the scene, X points east and Z south; 1 scene unit = 2 m. The operating area is ±280 units (±560 m). ALT, SPD, telemetry, log and cursor E/N are shown in metres; LAT/LON are the drone's real coordinates.
- **Map**: OSM background with buildings by height and land cover, highlighted CAC footprints, codes `PAL`, `MUS`, `UMB`, `AGO`, `AST`, `OCE`, NFZ circles, the RTK diamond and a 100 m grid; it shows `R 560m` and `© OpenStreetMap`.

**Data:** © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.

To regenerate the derived data, run `python3 tools/sync-cac.py` and `python3 tools/osm-city.py`. To download fresh OSM data, delete `tools/.cache/osm-city.json` before running the second command.

### Second site: Estadi Ciutat de València · Orriols (`?site=levante`)

Same engine, another place about 4.5 km north: Levante UD's stadium and its neighbourhood. The formulas come from the companion project `arena-levante-voxels` (`python3 tools/sync-lev.py` → `lev-shapes.js`) and the surroundings from OSM (`python3 tools/osm-city.py --site levante` → `assets/levante-city.js`, grid rotated −15° to follow the stadium). Sites are declared in `sites.js` (codes, NFZ, bases, camera); the default stays the City of Arts and Sciences.

| Code | Building |
|---|---|
| `EST` | Estadi Ciutat de València (NFZ-A, 112 m radius) |
| `ARE` | Centre Comercial Arena (not an automatic orbit target: it wraps the stadium NFZ) |
| `OFI` · `TOR` | Edifici Arena (offices) · Torre Orriols |
| `MET` | Tallers Machado (Metrovalència depot) |
| `PAR` · `CMP` · `PRC` | Parròquia del Sagrat Cor · Camp de Futbol Orriols · Parc d'Orriols |

- **Bases**: ALPHA on open ground north of the Ronda Nord, NE of the stadium; BRAVO in the Horta fields north of the depot (both found by scanning the OSM raster for an empty square).
- **RTK station**: on the roof of the Edifici Arena.

---

## 🛠️ How it was built (technical reference)

### Stack
- **No build step**: `index.html` plus two plain data scripts (`cac-shapes.js` and `assets/valencia-city.js`); no bundler or `npm install`. It opens with a double-click (`file://`).
- **Three.js r160** through an `importmap` from jsDelivr.
- Three.js addons: `OrbitControls`, `EffectComposer` + `UnrealBloomPass` + `OutputPass` (bloom) and `BufferGeometryUtils.mergeGeometries` (drone geometry).
- HUD in **HTML/CSS** with `backdrop-filter` panels, decorative corners and scanlines, plus **Canvas 2D** for the map, horizon and charts.

### 1. Swarm algorithm (Reynolds boids)
Each drone computes its acceleration as a weighted sum of *steering* forces (`desired − velocity`, capped at `MAXF`):

| Force | What it does |
|---|---|
| **Separation** | Moves away from neighbours closer than `R_SEP = 7`, weighted by `1/d²` |
| **Alignment** | Matches the average velocity of neighbours within `R_NEI = 16` |
| **Cohesion** | Steers toward the neighbours' center of mass |
| **Goal** | Seeks its goal with *arrival* (slows down when close) |
| **Avoidance** | Radial push from NFZs and obstacles; checks a height map and climbs or slides to avoid collisions |
| **Limits** | Altitude of 14–100 units (28–200 m) and an operating area of ±280 units (±560 m) |

The height map stores the top of whatever occupies each 4 m cell (city + CAC voxels). Each drone looks ahead along its velocity (0.4/0.8/1.3 s), climbs if something is in the way, and probes 8 directions at 14 m to slide around walls. Mission goals are lifted above obstacles.

The weights depend on the mode (`MODE_W`):

| Mode | Behaviour | How the goal is computed |
|---|---|---|
| `PATROL` | Classic flocking (high alignment and cohesion) | Current waypoint plus a per-drone offset. When the centroid gets within 30 m it moves to the next one, and a new route is generated at the end. |
| `ORBIT` | Rings around a landmark, with radius and altitude fitted to the building; the bridge is orbited above its cable fan | `center + (cos a·R, alt, sin a·R)` with the phase spread by *slot*. Clicking near a landmark selects it. |
| `FORMATION` | V (chevron) formation behind a virtual leader | The leader follows a Lissajous curve and slots are computed from its *forward* and *right* vectors |
| `SCAN` | A curtain sweeping across the city | Lanes along X (alternating altitudes to avoid collisions) and an oscillating Z |

*Slots* are reassigned every 2 s, or when the number of active drones changes, sorting by position (X in SCAN, angle in ORBIT, distance to the leader in FORMATION) so drones don't cross paths.

It is O(n²) per frame, which is enough for up to 150 drones.

### 2. Per-drone state machine
```
IDLE ──(staggered delay)──► LAUNCH ──(alt>24m)──► ACTIVE ──(bat<15%)──► RTB
  ▲                                                                      │
  └──────────── CHARGING ◄──(touchdown)── LANDING ◄──(over its pad)──────┘
                    │ (bat=100%)
                    └──────────► LAUNCH
```
- Battery drains at 0.32–0.6 %/s (varies per drone) and charges at 8 %/s. This keeps drones constantly flying to and from the base, which adds movement and log events.
- LED colour: cyan (ACTIVE), yellow (RTB/LANDING), blinking green (CHARGING) and white (LAUNCH).
- Orientation comes from velocity (yaw) and acceleration (forward pitch and roll in turns), the same way a real quadcopter tilts.

### 3. Rendering
- **Voxels**: a Lambert material patched with `onBeforeCompile`; the glowing lattice lines follow each mesh's own grid (including stretched city boxes: one 4 m cell and one floor line every 3.1 m). `uReveal` controls a reveal height for the boot effect. Without bloom at `quality=low`, the lattice is brighter.
- **Instancing**: one `InstancedMesh` per CAC building, plus city boxes merged by height.
- **Bloom** (`UnrealBloomPass`) for the neon look. Turned off with `quality=low`.
- **FPV camera**: the same scene is rendered a second time from another camera, using `setViewport` and `setScissor` on the FPV panel's rectangle. That panel has no background or blur so the render underneath shows through. The drone and its markers are hidden during that render.
- **Trails**: `THREE.Line` with a 40-point ring buffer, gradient vertex colours and `AdditiveBlending`.
- Charging pads use an `InstancedMesh`, rebuilt when the drone count changes.

### 4. HUD & data
- **Tactical map**: OSM base, buildings by height, CAC footprints, land cover, landmark codes, NFZs, RTK beacon, 100 m grid and `R 560m` label; it also shows the radar sweep, route and waypoints, drones coloured by state, and a **coverage map**. The grid is 24×24 cells; a cell counts as covered if an active drone passed through it in the last 90 s. That is the COVERAGE %, and it is actually computed. Includes `© OpenStreetMap`.
- **Selected-drone telemetry**:
  - ALT, SPD, HDG, BAT and LINK are computed by the simulation and displayed in real units; RPM and ESC temperature are derived values.
  - LAT/LON are the real position coordinates, from the site origin (39.45472, −0.3525) using an equirectangular projection. The cursor shows E/N in metres.
- **Log**: boot messages and simulation events (RTB, landings, waypoints, geofence, mode changes), plus procedural fleet chatter and SURVEY/LIDAR lines about the nearest landmark. Chatter lines get the `chat` class so the `EVENTS` filter can hide them with CSS.
- The text HUD updates every 250 ms. The map and horizon are drawn every frame.
- The layout adapts to screen height: the map and FPV panel scale with `vh`.

### 5. Interactive terminal
It is an `<input>` in the C2 CONSOLE panel. `runCmd()` sets `toConsole` so `log()` writes to the console (and copies `ok`/`sys`/`warn` lines to the SYSTEM LOG), and `execCmd()` parses `command[=| ]argument`. Autocomplete uses the `CMD_ARGS` table. `setDroneCount()` does the following:
- Frees the extra drones (`dispose()` on materials and geometries).
- Rebuilds the pads and reassigns each drone's pad.
- Creates the new drones with a staggered takeoff.
- Regenerates the *Fleet Matrix* panel.

The terminal also resolves orbit targets by code, id or partial name; `orbit` lists landmarks and rejects targets inside NFZ-A. Keyboard shortcuts are ignored while you type in the terminal.

### 6. How it was verified
- `node --check` on the extracted script (syntax).
- **Playwright + Chromium with SwiftShader**: screenshots at 1920×1080, 1440×810 embedded (`?embed=1&quality=low&drones=45`), 1080×1920 and 390×844; no console errors.
- Stress test with 150 drones and 60 s of simulated time per mode: 0 NFZ incursions and approximately 0 contacts with structures (a few samples brushed the bridge cables).
- The loop separates `simStep(dt)` from rendering. `window.__swarm` exposes drones, landmarks, obstacles, `topAt`, `setMode`, `runCmd` and `warp(seconds)` to advance the simulation without rendering.

### 7. How the GIF was made
Software rendering in a headless browser only reaches ~4 FPS, so the recording uses **Playwright's `page.clock`** (virtual time). The script advances the clock by 1/12 s, takes a screenshot and repeats, so the animation is smooth regardless of actual performance. Script: [`tools/record-gif.mjs`](tools/record-gif.mjs).

```bash
npm i --no-save playwright gifsicle && npx playwright install chromium
node tools/record-gif.mjs                                   # → frames/*.png (1280x720, 12 fps)

# GIF (optimized palette + lossy compression → ~6 MB)
ffmpeg -framerate 12 -i frames/f%04d.png -vf "fps=8,scale=720:-1:flags=lanczos,palettegen=max_colors=64:stats_mode=diff" pal.png
ffmpeg -framerate 12 -i frames/f%04d.png -i pal.png -lavfi "fps=8,scale=720:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle" tmp.gif
npx gifsicle -O3 --lossy=160 --colors 48 tmp.gif -o assets/demo.gif

# Higher-quality MP4
ffmpeg -framerate 12 -i frames/f%04d.png -vf scale=1280:-2 -c:v libx264 -pix_fmt yuv420p -crf 28 -movflags +faststart assets/demo.mp4
```

The scanlines (`#fx`) are hidden during recording, because the line pattern makes the GIF several times larger.

---

## 🔧 Where to customize

The logic lives in `index.html`, inside the `<script type="module">` (the setting data in `cac-shapes.js` and `assets/valencia-city.js`):

| What | Where |
|---|---|
| Speed, force and neighbour radii | `const MAXS, MAXF, R_NEI, R_SEP` in `CONFIG` |
| Flocking weights per mode | `const MODE_W` |
| Colours per state | `STATE_COLOR` and the `:root` CSS variables (`--c`, `--g`, `--y`, `--r`) |
| How often the mode changes | `modeTimer > 50` in the main loop |
| How often the selected drone changes | `focusTimer > 10` |
| Battery drain and charge | `this.drain = rand(...)` · `dt * 8` · `battery < 15` |
| Site, scale and area | `SC`, `AREA`, `VOX`, `PIN` in `CONFIG` / `SITE: VALENCIA` |
| NFZ | `addNfz` in the `SITE` block |
| Voxel colours | `VCOL` and `voxMaterial` |
| OSM city data | `tools/osm-city.py`: `BASE`, `THETA`, `CELL`, `N` |
| Log messages | `gen` array in `chatter()` and the `boot` array |
| New terminal commands | `switch (cmd)` in `runCmd()` |

---

## 💡 Ideas for later
- Real relief of the Túria riverbed (the garden is about 6 m below street level).
- **Augmented reality** mode with the webcam and MediaPipe (hand/face tracking) in a panel.
- Live air traffic (ADS-B) on the map.
- Bundle Three.js locally (`vendor/`) so it works offline.
- A spatial grid for boid neighbour lookups to support 500+ drones.
- Configurable colour theme (`theme=amber`, `theme=green`).

---

## 📁 Structure

```
drone-swarm-c2/
├── .gitignore             # ignores tools/.cache/
├── index.html            # app (HTML + CSS + JS)
├── sim-core.js           # shared browser/server simulation (boids, missions)
├── net-client.js         # WebSocket/REST client for server mode
├── sites.js              # site registry (cac, levante)
├── cac-shapes.js         # CAC voxel building formulas (generated)
├── lev-shapes.js         # Estadi / Orriols voxel formulas (generated)
├── server/               # Node backend (Fastify, WebSocket, PostGIS/TimescaleDB, tests)
├── docker-compose.yml    # local database
├── docs/                 # architecture and implementation plan
├── assets/
│   ├── valencia-city.js  # rasterized OSM data (generated)
│   ├── levante-city.js   # OSM data around the Estadi / Orriols (generated)
│   ├── demo.gif          # README GIF
│   ├── demo.mp4          # higher-quality video
│   └── screenshot.png
├── tools/
│   ├── osm-city.py       # downloads and rasterizes OSM data
│   ├── sync-cac.py       # syncs formulas from the companion project
│   └── record-gif.mjs    # demo recording with Playwright (virtual clock)
├── README.md             # documentation (Spanish)
└── README.en.md          # documentation (English)
```
