# Drone Swarm C2: server backend overview

What was built on branch `feat/server-backend` (2026-10-29), how the demo mission works, what runs, how it was verified, and what is still open.
Companion documents: [`architecture.md`](architecture.md) (design, diagram), [`implementation-plan.md`](implementation-plan.md) (contracts, gates).

## 1. The demo mission

**What it is:** one swarm-level task. All 60 ALPHA drones fly together, as a flock, over 5 fixed points in the City of Arts and Sciences.

| # | Waypoint | Altitude | Scene position (x, z) |
|---|---|---|---|
| 1 | L'Oceanogràfic | 85 m | (120, 202) |
| 2 | L'Àgora | 120 m | (29, 164) |
| 3 | Pont de l'Assut de l'Or | 130 m | (-21, 162) |
| 4 | L'Umbracle | 130 m | (-144, 86) |
| 5 | Museu de les Ciències | 60 m | (-52, 59) |

- **Skipped:** the Palau de les Arts and the Hemisfèric (a no-fly zone).
- **Route length:** about 780 m.
- **Time:** the two runs recorded in the DB took 35 s and 53 s.
- **Where the coordinates come from:** the waypoints are those landmarks' coordinates, taken from the data stored in the DB, stored as latitude, longitude and altitude. Example: waypoint 1 is `39.453239, -0.347606, 85 m`.
- **What you see:** the yellow dashed lines and vertical markers in the dashboard are this route.

**Why it exists:** it proves the architecture end to end, with a real task. Four things happen that did not exist before:
1. The server owns a long-running task as a state machine.
2. It is saved in the database and checked with spatial queries.
3. It is controlled over REST from the console.
4. Progress is pushed live to the browser.

Later, a planner, a UI or a real drone could supply waypoints instead of `mission demo`.

## 2. What happens when you type the commands

**`mission demo`** (creates the mission):
1. The server builds the 5-point loop from the landmarks.
2. It chooses the order of the loop. Every leg must stay at least `radius + 25` units (50 m) clear of the no-fly-zone circles.
3. It raises altitudes until the terrain check passes.
4. It validates the route, then saves it as `PLANNED`.

**Validation, which any mission goes through:**

| Check | How | If it fails |
|---|---|---|
| No-fly zones | PostGIS `ST_Intersects` of the route line with the NFZ polygons, plus altitude below the zone's ceiling (NFZ-A: 220 m) | 422 `NFZ` |
| Terrain | The route is sampled every 4 m. It needs at least 8 m clearance above the nearest structure. | 422 `TERRAIN` |

**`mission start`:**
1. The server re-validates, because the second no-fly zone, NFZ-B, is random each run.
2. It converts latitude and longitude into scene coordinates.
3. It switches ALPHA into a new `MISSION` mode and sets the status to `RUNNING`.

**While it runs:**
- **Flocking:** the same flocking code as the demo: separation, alignment, cohesion, building avoidance, and no-fly-zone deflection. Each drone aims at the waypoint plus a small personal offset.
- **Battery:** the battery logic keeps working. A low-battery drone returns to base to recharge while the rest carry on.
- **Waypoint reached:** when the centroid (average position) of the drones comes within 30 units (60 m) of the target, the swarm advances to the next one. The log shows `RUNNING 1/5 … 4/5`.
- **Last waypoint:** the status becomes `DONE` and the swarm returns to PATROL.

**Cancel and exceptions:**
- **Abort:** `mission abort`, or any manual mode change, aborts it (`ABORTED`).
- **Second mission:** a second `start` while one is running returns 409.
- **Server restart:** a restart marks any running mission as aborted.

**Other console commands:** `mission status` shows the current state. `mission start <id>` accepts an id or an id prefix.

## 3. What was built, by layer

```text
 Browser (Three.js)  <--WebSocket 10 Hz + REST-->  Node server :3000  <-->  PostgreSQL 17 + PostGIS + TimescaleDB
 only draws + sends commands                       runs the sim at 30 Hz        (Docker, 127.0.0.1:5432)
```

| Layer | What it does | Main files |
|---|---|---|
| **Shared sim** | The flocking logic was extracted out of `index.html`. The browser (offline mode) and the server both run it. | `sim-core.js` |
| **Server** | Fastify + WebSocket. Runs the sim, serves the page, stores telemetry, validates and runs missions, and accepts external telemetry on `/ingest`. | `server/src/*.ts` |
| **Database** | The site (OSM grid, height map, landmarks, building formulas, no-fly-zone polygons) and a telemetry hypertable. | `docker-compose.yml`, `server/db/` |
| **Browser client** | `?server=...` mode: interpolates the server's snapshots and shows a SERVER ONLINE badge. The `mission` console command lives here. | `net-client.js`, `index.html` |
| **Tools** | Baseline statistics, comparison, site export, mock server. | `tools/` |

- **Offline mode:** nothing changes for the offline demo (no `?server=`), except that it needs a static server instead of a double-click.
- **Wheel zoom:** one notch is now a fixed ~5% step with eased motion, independent of the mouse and the frame rate (the fix for the wheel jumping to the nearest or farthest distance).

## 4. What is running when you use it

1. **Docker container** `drone-swarm-db-1` (the database), on `127.0.0.1:5432`.
2. **Node server** on `127.0.0.1:3000`: the 30 Hz sim, the WebSocket stream (10 Hz), the REST API, the telemetry writer (once per second) and the page itself.
3. **Browser tabs.** `:3000` is server mode. A separate static server (for example `python3 -m http.server 8080`) opens offline mode, which does not use the server.

**Stored when this was written:**
- 58,320 telemetry rows from 60 drones (10 MB).
- 2 completed missions with 5 waypoints each.
- 1 no-fly zone polygon (NFZ-A, Hemisfèric).

## 5. How to run it

```bash
cd ~/wsl_code/personal/drone-swarm
docker compose up -d db     # only if the database container isn't running
npm run server              # then open http://127.0.0.1:3000/
```

In the C2 console: `mission demo`, `mission start`, `mission status`, `mission abort`.
First-time setup (migrate, export the site, load it) is in the README section "Server mode".

## 6. How we know it works

- **49/49 automated tests passed** (before the last two small changes: serving the page from the server and the wheel fix). They cover the DB, the server, the sim, the network client and missions. Run them with `npm test` (needs the DB up).
- **Same flocking as the demo:**
  - The server-side sim passed every band of statistics recorded from the original code (6 scenarios x 5 runs).
  - The refactored page produced exactly the same positions as the original, given the same random seed.
- **Browser end to end:** a headless browser loaded the page and ran `mission demo`, `mission start` and `mission status`. The drones moved, and 0 JS errors were logged.
- **Caveat on matching:** the browser and Node sims only stay identical for about 20 seconds. Tiny floating-point differences, amplified by the flocking, make longer runs differ. So matching is proven with statistics, not exact paths.

## 7. Limits and open items

1. **All drones are simulated.** Real telemetry can already be injected (`POST /ingest`), and those drones show as `EXT-...`. No real drone has been connected, and the fake drone script (WP7) was not written.
2. **The demo mission is fixed.** Custom routes work through the API (`POST /api/missions`), but there is no UI to draw one yet.
3. **No authentication.** The server listens on localhost only. It needs auth before it is exposed anywhere.
4. **Not committed or pushed.** Everything is on branch `feat/server-backend`, uncommitted. Pushing `main` deploys GitHub Pages.
5. **Not deployed.** The Hetzner server is untouched.
6. **BRAVO / hostile swarms in server mode** are not wired. The shared sim code supports them.
7. **`index.html` needs a static server.** It no longer opens from `file://`, because the simulation is an ES module.
