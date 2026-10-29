# Implementation plan: server backend + shared flocking core

Status: EXECUTED 2026-10-29 (WP0-WP6, WP8). WP7 (fake external drone) not done. Deviation: browser-vs-Node bit parity holds only ~20 s (libm 1-ulp differences); parity is proven statistically instead (golden bands, Node SimWorld ALL PASS).
Read first: [`architecture.md`](architecture.md) (decisions, diagram, API sketch) and `AGENTS.md` (code map of `index.html`, local file, not committed).

## 0. Goal and scope

Goal: drones are driven by a server instead of the browser, using the SAME flocking code as the current demo, with maps and telemetry in a database and one simple server-run mission.

In scope (v1):
1. `sim-core.js`: the simulation logic extracted from `index.html` (no DOM, no meshes), used by the browser (offline mode) AND the server.
2. Server (Node 26 + TypeScript): runs `SimWorld` at a fixed tick, ingest, live WebSocket, REST (sites, missions), DB persistence.
3. DB: PostgreSQL 17 + PostGIS + TimescaleDB in docker-compose. Site data (OSM raster, formulas, height map, landmarks, NFZ polygons) and telemetry.
4. Frontend `?server=ws://host:port` mode that renders what the server sends. No param = today's behaviour, unchanged.
5. Mission: waypoint route validated against NFZ polygons and terrain, state machine PLANNED -> RUNNING -> DONE | ABORTED, flown by ALPHA in a new `MISSION` swarm mode.
6. Proof that real telemetry can be injected: `POST/WS /ingest` plus a fake external drone script (WP7, optional).

Out of scope (v1): BRAVO / hostile / intercept wiring in server mode (the core contains it, only the frontend/command wiring is deferred), auth, MQTT broker, MAVLink bridge, deploy to `hetznerserver`, Rust.

## 1. Findings from the code review that shape the plan

| # | Finding | Consequence |
|---|---|---|
| 1 | `Drone` (index.html:722) and `Swarm` (:955) mix logic with Three.js meshes, `log()`, DOM (`$('#bannerTxt')`, `syncCtrl`, `updateModeLabels`) and `ripple()`. About 52 vector calls and 13 `Math.random` calls. | Extract by inheritance: `Drone extends SimDrone`, `Swarm extends SimSwarm`. Meshes and DOM stay in `index.html` and plug in through hooks. Smallest diff, offline mode keeps working. |
| 2 | The height map `HM` (:429) is computed in the browser: OSM building heights (:528) plus voxelised Calatrava cubes (:573). `landmarks` come from the same voxelisation (:607). | The server must not re-implement voxelisation. A one-off Playwright export (`tools/export-site.mjs`) samples the final `topAt` over all cell centres and dumps `landmarks`; both go into the DB as derived layers. |
| 3 | NFZ-B is random (:660) and `Math.random` is used everywhere. | The core takes an injected seeded RNG. Server generates obstacles once per world and sends them in `hello`; the frontend uses them instead of its own random NFZ. |
| 4 | `cac-shapes.js` is JavaScript source (formulas as functions), not data. | Stored in DB as source text, served at `GET /api/sites/:id/cac.js`. Frontend falls back to the local file if the server is unreachable. Only load it from the configured server origin. |
| 5 | Simulation order in `simStep` (:2010): `SA.step, SB.step, intercept, drone.update`. Behaviour depends on `dt`. | `SimWorld.step(dt)` reproduces the exact order. Server uses a fixed dt (1/30 s). Parity test uses the same fixed dt on both sides. |
| 6 | `__swarm.warp(sec)` (:2144) runs `simStep` without rendering. | Baseline and parity tests use it. No long real-time waits (headless WebGL is about 1 FPS). |
| 7 | `three` is pinned to r160 by the importmap (:299). | Server pins `three@0.160.0`, only `Vector3` is used. |

## 2. Target repo layout

```text
drone-swarm/
  index.html              edited: Drone/Swarm extend core classes, server mode seam
  sim-core.js             NEW  shared logic, ES module, imports only `three` (Vector3)
  net-client.js           NEW  browser WS + REST client, interpolation buffer, command sender
  docker-compose.yml      NEW  timescale/timescaledb-ha (PG17 + PostGIS + Timescale), 127.0.0.1:5432
  .env.example            NEW  real .env is git-ignored
  server/
    package.json  tsconfig.json   (erasableSyntaxOnly, Node 26 runs .ts natively, `tsc --noEmit` for types)
    src/index.ts config.ts db.ts geo.ts world.ts ingest.ts live.ts missions.ts routes.ts
    db/schema.sql  db/load-site.ts
    test/ (vitest or node:test)
  tools/baseline.mjs  export-site.mjs  parity.mjs  metrics.mjs  fake-drone.mjs
  docs/architecture.* implementation-plan.md
```

Branch: `feat/server-backend`. Do NOT push `main` (GitHub Pages auto-deploys from it). Public repo: no secrets in any file.

## 3. Contracts (frozen before workers start)

### 3.1 `sim-core.js` API

```js
export const CONST = { AREA, MAXS, MAXF, R_NEI, R_SEP, MODES, MODE_W };      // same values as index.html:330-340
export function mulberry32(seed) {}                                           // returns () => [0,1)

export class SimDrone {            // fields: sw, i, pad, pos, vel, lastAcc, goal, state, launchDelay, battery, drain,
  constructor(sw, i, delay) {}     //   link, phase, yaw, slot, nfzT, temp, target, hit
  setState(s) {}                   // calls world.hooks.onDroneState?.(this, s)
  update(dt, flying) {}            // state machine only (no orient, no trail)
  flock(dt, flying) {}             // verbatim logic of index.html:820-904, uses world.env
}
export class SimSwarm {            // key, name, prefix, base, hostile, drones, pads, mode, modeTimer, waypoints, wpIdx,
  constructor(world, key, name, prefix, base) {}   // orbitCenter, orbitR0, orbitAlt0, leader, leaderVel, sweepZ, ph, objectives
  computePads(n) {}  setCount(n, delay0) {}  genRoute() {}  orbitLandmark(l) {}  orbitPoint(p) {}
  setMode(m, why) {}  assignSlots(active) {}  computeGoals(active) {}  intrudeGoals(active) {}  step(dt) {}
  setMission(waypoints /* scene-unit V3[] */) {}   clearMission() {}   // NEW mode 'MISSION'
}
export class SimWorld {
  constructor({ topAt, topNear, landmarks, obstacles, rand, hooks }) {}
  // hooks (all optional): log(level,msg) onRipple(pos,color) onModeChange(sw,mode,why) onRouteChange(sw)
  //                       onDroneState(d,s) onMissionEvent(ev)
  T; auto; lastInteraction; swarms; neiSum; neiCnt;
  step(dt) {}                      // SA.step, SB.step, intercept, drone.update (exact order of simStep)
  intercept(dt) {}                 // moved from index.html:1239
  snapshot() {}                    // see 3.3
  applyCommand(cmd) {}             // 'mode' | 'orbit' | 'drones' | 'auto' | 'mission'
}
export function makeObstacles(rand, landmarks) {}   // NFZ-A on the Hemisfèric landmark + seeded NFZ-B (index.html:645-669, no meshes)
```

Rules: no `document`, `window`, `THREE.Mesh`, `Math.random` or `console` inside `sim-core.js`. Randomness only through the injected `rand`. The browser's cosmetic randomness (chatter, focus pick) keeps using `Math.random`.

`MISSION` mode: goals = current waypoint (same offset pattern as PATROL), centroid within 30 units advances `wpIdx`, last waypoint reached emits `onMissionEvent({type:'DONE'})`, then the swarm returns to `PATROL`. Mission waypoints are NOT lifted by `safeAlt` (they are validated before launch instead).

### 3.2 Database (draft, workers verify syntax against the pulled Timescale version)

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE sites (
  id text PRIMARY KEY, name text NOT NULL,
  origin_lat double precision NOT NULL, origin_lon double precision NOT NULL,
  theta_deg double precision NOT NULL, cell_m double precision NOT NULL, grid_n integer NOT NULL,
  sc double precision NOT NULL DEFAULT 0.5,            -- scene units per metre
  meta jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE site_layers (                              -- kind: city (CITY JSON), cac_js (source text), height_map (float32 gz),
  site_id text NOT NULL REFERENCES sites ON DELETE CASCADE,   --   landmarks (json), buildings (optional)
  kind text NOT NULL, content_type text NOT NULL, data bytea, json jsonb, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, kind)
);
CREATE TABLE no_fly_zones (
  id serial PRIMARY KEY, site_id text NOT NULL REFERENCES sites ON DELETE CASCADE,
  name text NOT NULL, label text, floor_m real NOT NULL DEFAULT 0, ceiling_m real NOT NULL,
  geom geometry(Polygon, 4326) NOT NULL                -- circle approximated with 64 points
);
CREATE INDEX ON no_fly_zones USING gist (geom);
CREATE TABLE drones (id text PRIMARY KEY, site_id text NOT NULL, swarm text, kind text NOT NULL CHECK (kind IN ('sim','real')));
CREATE TABLE missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id text NOT NULL, swarm text NOT NULL DEFAULT 'A',
  name text NOT NULL, status text NOT NULL CHECK (status IN ('PLANNED','RUNNING','DONE','ABORTED','FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, ended_at timestamptz
);
CREATE TABLE mission_waypoints (
  mission_id uuid NOT NULL REFERENCES missions ON DELETE CASCADE, seq int NOT NULL,
  lat double precision NOT NULL, lon double precision NOT NULL, alt_m real NOT NULL, PRIMARY KEY (mission_id, seq)
);
CREATE TABLE telemetry (
  ts timestamptz NOT NULL, site_id text NOT NULL, drone_id text NOT NULL,
  lat double precision, lon double precision, alt_m real, vx real, vy real, vz real,
  heading real, battery real, link real, temp real, state text
);
-- hypertable on ts (1 day chunks), index (drone_id, ts DESC), compression after 7 days, retention 90 days
```

Persist rate: sim drones 1 Hz per drone (`TELEMETRY_PERSIST_HZ`, default 1). External drones: every message. Batch writer flushes about every second with `COPY`.

### 3.3 WebSocket protocol (`ws://host:3000/live`, JSON text frames)

Server to client:

```text
{type:'hello', serverT, tickHz, snapHz, site:{id,...}, obstacles:[{x,z,r,h,type,name,label}], landmarks:[...], seed}
{type:'snap', t, seq, drones:[[id, swarm, x,y,z, vx,vy,vz, ax,az, state, battery, link, temp], ...],
  swarms:{A:{mode, wpIdx, waypoints:[[x,y,z]], orbitCenter:[x,z], orbitR0, orbitAlt0, leader:[x,y,z], sweepZ, hostile}},
  mission:{id, status, wpIdx, total}|null, ext:[[id,x,y,z,heading,battery,state], ...]}   // 10 Hz
{type:'log', lv, msg, t}        {type:'ripple', x,y,z, color}        {type:'mission', id, status, wpIdx}
```

Units: scene units (1 unit = 2 m) so the frontend can render directly. `ext` = externally injected drones (render-only, never flocked).
Client to server: `{type:'cmd', name:'mode'|'orbit'|'drones'|'auto', args:[...]}`. Missions go through REST.

### 3.4 REST

| Endpoint | Behaviour |
|---|---|
| `GET /api/health` | `{ok, db, tick, drones}` |
| `GET /api/sites/:id` | CITY-compatible JSON (`origin, base, theta, cell, n, h, c, cover`) |
| `GET /api/sites/:id/cac.js` | formulas source, `application/javascript` |
| `GET /api/sites/:id/world` | `{landmarks, obstacles, nfz (GeoJSON)}` |
| `POST /api/missions` | body `{siteId, swarm, name, waypoints:[{lat,lon,alt_m}]}`. 201 `{id,status:'PLANNED',warnings}` or 422 `{conflicts:[{type:'NFZ'|'TERRAIN', leg, detail}]}` |
| `GET /api/missions` / `:id` | list / detail with waypoints |
| `POST /api/missions/:id/start` | PLANNED to RUNNING, 409 if the swarm already has a RUNNING mission |
| `POST /api/missions/:id/abort` | RUNNING to ABORTED, swarm back to PATROL |
| `POST /api/missions/demo` | creates a 5-waypoint loop around the Ciutat (validated) |
| `POST /ingest` and `WS /ingest` | external telemetry `{droneId, ts, lat, lon, alt_m, vx?, vy?, vz?, heading?, battery?, state?}` |

Route validation: PostGIS `ST_Intersects(route_linestring, nfz_polygon)` with floor/ceiling check, plus terrain: sample every leg each 4 m, require `alt >= topNear + 8` in scene units converted to metres. Coordinates: API in WGS84, server converts with `geo.ts` (port of `geoToSite` / `siteToScene`, index.html:419-424). Gate: round trip matches `__swarm.sceneToGeo` within 0.01 m.

## 4. Work packages

Owners: **O** = orchestrator (Opus 5.5), **W** = worker (Sonnet 5.5). One writer per file at any time.

| WP | Owner | Does | Files it owns | Depends on | Estimate |
|---|---|---|---|---|---|
| 0 | O | Create branch. Write `tools/metrics.mjs`, `tools/baseline.mjs`. Run 5 unseeded baselines per scenario on the ORIGINAL `index.html`, save `server/test/golden.json`. | `tools/baseline.mjs`, `tools/metrics.mjs`, `server/test/golden.json` | none | 15 min |
| 1 | W-A | `docker-compose.yml`, `.env.example`, `.gitignore` entries, `server/db/schema.sql`, `tools/export-site.mjs` (Playwright: sample `topAt` on all 550x550 cell centres, dump landmarks), `server/db/load-site.ts` (CITY, cac.js text, height map, landmarks, NFZ-A polygon). | those files | none | 20 min |
| 2 | W-B | Create `sim-core.js` per 3.1, move logic out of `index.html`, make `Drone extends SimDrone` and `Swarm extends SimSwarm`, add `?seed=N` (offline mode only), add `MISSION` mode. | `sim-core.js`, `index.html` | WP0 | 60 min |
| 3 | W-C | Server skeleton: config, Fastify, `ws`, `db.ts`, `geo.ts`, `world.ts` (stub world until WP2 lands, then real `SimWorld`), `live.ts`, `ingest.ts`, batch writer, `routes.ts` for sites. | `server/src/*` except `missions.ts` | contracts | 40 min |
| 4a | W-D | `net-client.js` against the protocol, with `tools/mock-server.mjs` that replays recorded `snap` frames for testing without the real server. | `net-client.js`, `tools/mock-server.mjs` | contracts | 30 min |
| 5 | W-E | `server/src/missions.ts`: validation (PostGIS + terrain), FSM, REST, demo mission, DB rows, `world.applyCommand` wiring. | `server/src/missions.ts` | WP1 schema, WP3 skeleton, WP2 `MISSION` mode | 25 min |
| 4b | W-D | Frontend seam in `index.html`: `?server=` bootstrap (override `window.CITY`/`CAC`, obstacles), `Drone.update` takes snapshot data, swarm markers from `swarms`, `log`/`ripple` from events, console commands forwarded (`mode`, `orbit`, `drones`, `auto`, `mission demo|start|abort|status`). | `index.html` (after WP2 is merged) | WP2, WP4a | 20 min |
| 6 | O (+W) | Integration and verification (section 5). Fix loop. | tests, small fixes | all | 35 min |
| 7 | W | OPTIONAL: `tools/fake-drone.mjs` (circular GPS track into `/ingest`), `EXT-xx` render in frontend. | `tools/fake-drone.mjs`, small `index.html` patch | WP4b | 15 min |
| 8 | W | README.md + README.en.md (user-facing: server mode, docker, env vars), update local `AGENTS.md` code map, link docs. Keep ES and EN in sync. | READMEs, `AGENTS.md` | WP6 | 10 min |

Schedule:

```text
T+0    WP0 (O)
T+15   WP1 | WP2 | WP3 | WP4a        (4 workers in parallel, disjoint files)
T+45   WP5 starts (needs WP3 skeleton)
T+75   WP2 merged -> WP3 swaps stub for real SimWorld, WP4b starts
T+95   WP6 integration and verification
T+130  WP7 optional, WP8 docs
```

Critical path: WP0 -> WP2 -> WP4b -> WP6, about 130 min. Estimates carry about +/-50 % error. Biggest risk to the schedule is WP2.
Solo (no subagents), same scope: about 3.5 to 4 h.

Model notes: orchestrator needs the session switched to `github-copilot/claude-opus-5.5` first. Workers: pass `model: "github-copilot/claude-sonnet-5.5"` explicitly. Three or more subagents automatically triggers the Luna watchdog review (extra cost). If WP2 fails parity twice, the orchestrator does WP2 itself.

## 5. Verification matrix (gates)

| Gate | After | Check | Pass |
|---|---|---|---|
| G0 | WP0 | `golden.json` has mean/min/max over 5 runs for S1-S6 | file exists, runs finished |
| G1 | WP1 | `docker compose up -d`, migrate, `export-site`, `load-site` | `SELECT count(*)` on layers = expected; `ST_IsValid(geom)` all true; `telemetry` is a hypertable; height map in DB equals dump byte for byte |
| G2 | WP2 | syntax check (AGENTS.md step 1); offline mode runs the S1-S6 scenarios with `warp`; Node runs the same scenarios headless via `tools/parity.mjs` with the same seed | (a) offline metrics inside golden bands; (b) browser vs Node, same seed, same fixed dt: final drone positions within 1e-3 units; if bit-exact fails, fall back to statistical bands (below); (c) structure contacts 0; (d) friendly inside NFZ 0 |
| G3 | WP3 | server starts, `GET /api/health`, WebSocket client receives `hello` then `snap` at 10 Hz, `ws` frame size sane | 150 drones: snap under 20 KB, tick under 5 ms p95 |
| G4 | WP5 | `POST /api/missions/demo`, `start`, wait with accelerated clock (`WORLD_TIME_SCALE` env for tests) | status goes RUNNING then DONE; a route through NFZ-A returns 422; a route under a building returns 422 |
| G5 | WP4b+6 | Playwright (SwiftShader flags from AGENTS.md) loads `index.html?server=ws://localhost:3000`, screenshots at 1920x1080 and 1440x810 | drones visible and moving, HUD shows server data, `mission demo` then `mission start` works from the console, 0 page errors, offline mode (no param) still identical |
| G6 | WP6 | DB checks | telemetry rows for 60 drones at 1 Hz after 30 s about 1,800; `geo.ts` round trip 0.01 m |

Statistical bands (fallback for G2b and for regression vs the original): mean speed of active drones +/-3 %, mean neighbour count +/-5 %, minimum separation not below baseline min by more than 10 %, contacts 0, friendly NFZ intrusions 0, active count +/-2.

Scenarios: S1 PATROL 60 drones 120 s. S2 ORBIT (OCE) 120 s. S3 FORMATION 120 s. S4 SCAN 120 s. S5 PATROL 150 drones 180 s (stress). S6 `swarm2=16` hostile 180 s (at least 1 intercept event, hostile NFZ breaches allowed, friendly 0). All run with `warp(0.05)` steps; metrics sampled every 5 s from `__swarm.drones()`.

## 6. Rules for every worker

1. Read `docs/architecture.md`, this plan and `AGENTS.md` first. Touch only the files listed for your WP.
2. Node 26.13 (`nvm use 26.13.0`). Server code: erasable TypeScript syntax only (no enums, no parameter properties), imports with `.ts` extension. `sim-core.js` and `net-client.js` are plain browser-compatible ES modules.
3. No secrets in files. `.env` is git-ignored. DB and server bind `127.0.0.1`.
4. Do not push. Commit on `feat/server-backend` only when the orchestrator asks.
5. Headless WebGL is slow: use `warp`, never wait real time for sim results. Clean up temp dirs.
6. Report: files changed, commands run, actual output of the acceptance check. Never claim a check passed without running it.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Refactor changes drone behaviour | Golden baseline from the ORIGINAL code (G0), determinism test browser vs Node (G2), single writer on `index.html` |
| Timescale syntax differs per version (`compress` vs columnstore, `create_hypertable` vs `WITH (tsdb.hypertable)`) | WP1 checks the pulled image version and uses what it supports; `timescale/timescaledb-ha` tag verified at pull time |
| Node type stripping rejects some TypeScript | `erasableSyntaxOnly`, `tsc --noEmit` in CI step |
| Frontend executes JS from the server (`cac.js`) | Only from the origin given in `?server=`; never from user input at runtime; no auth in v1, so server stays on localhost |
| `dt` differences (variable in browser, fixed on server) | Fixed 1/30 s on server, snapshots at 10 Hz, frontend interpolates 100 to 150 ms behind; parity uses the same dt on both sides |
| Public repo exposes `server/` and `docs/` through Pages | Acceptable (no secrets); `.env` ignored; nothing deployed until reviewed |
| Slow headless tests | `warp`, `WORLD_TIME_SCALE`, limit screenshots to G5 |

## 8. Defaults chosen (owner can veto before "go")

1. Server drones run the real flocking code (option 1), mission = new `MISSION` swarm mode.
2. Server tick 30 Hz, snapshot 10 Hz, persisted telemetry 1 Hz per sim drone.
3. Server in TypeScript run natively by Node 26, no build step.
4. Formulas stored as source text; height map and landmarks derived once by `export-site.mjs` and stored.
5. One RUNNING mission per swarm; waypoints in WGS84 + altitude in metres.
6. No auth in v1, localhost only.
7. BRAVO / hostile wiring in server mode deferred (core supports it).

## 9. Orchestrator kickoff checklist (after "go")

1. Switch session model to `github-copilot/claude-opus-5.5`. Confirm `node -v` is 26.13.0 and `docker ps` works.
2. `git switch -c feat/server-backend`. Confirm the working tree only has `docs/` untracked.
3. Run WP0, check G0.
4. Launch WP1, WP2, WP3, WP4a as one async workflow, disjoint files, Sonnet 5.5 workers, bind outputs to files under `docs/reports/` (not committed).
5. Run gates in order, steer failures, then WP5, WP4b, WP6, WP7, WP8.
6. Final report to the owner: what works (commands to try), gate results, residual risks. No push.
