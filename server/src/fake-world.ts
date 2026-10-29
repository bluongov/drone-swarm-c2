// FakeWorld: same public surface as sim-core's SimWorld, a few drones flying circles. Used until/unless the real core
// is available, and by tests. Scene units (1 unit = 2 m), X east, Z south.
import type { Landmark } from './site.ts';

export interface WorldHooks {
  log?: (level: string, msg: string) => void;
  onRipple?: (pos: { x: number; y: number; z: number }, color: unknown) => void;
  onModeChange?: (sw: unknown, mode: string, why?: string) => void;
  onRouteChange?: (sw: unknown) => void;
  onDroneState?: (d: unknown, s: string) => void;
  onMissionEvent?: (ev: any) => void;
}
export interface WorldOpts {
  topAt?: (x: number, z: number) => number;
  topNear?: (x: number, z: number, r?: number) => number;
  landmarks?: Landmark[];
  seed?: number;
  n?: number;
  sceneToGeo?: (x: number, z: number) => number[];
  hooks?: WorldHooks;
}
type P3 = { x: number; y: number; z: number };
const MODES = ['PATROL', 'ORBIT', 'FORMATION', 'SCAN'];

export class FakeWorld {
  T = 0;
  auto = true;
  obstacles = [{ x: 60, z: -40, r: 25, h: 80, type: 'NFZ', name: 'NFZ-A', label: 'fake' }];
  landmarks: Landmark[];
  hooks: WorldHooks;
  n = 0;
  swarms: { A: FakeSwarm };

  constructor(opts: WorldOpts = {}) {
    this.hooks = opts.hooks ?? {};
    this.landmarks = opts.landmarks ?? [];
    this.swarms = { A: new FakeSwarm(this) };
    this.setCount(opts.n ?? 6);
  }

  setCount(n: number) { this.n = Math.max(0, Math.min(150, Math.round(n))); }

  step(dt: number) {
    this.T += dt;
    this.swarms.A.step(dt);
  }

  snapshot() {
    const A = this.swarms.A, L = A.leader, V = A.leaderVel;
    const drones: any[] = [];
    for (let i = 0; i < this.n; i++) {
      const a = i / Math.max(1, this.n) * Math.PI * 2 + this.T * 0.6, R = 20 + (i % 5) * 6, w = 0.6;
      const x = L.x + Math.cos(a) * R, z = L.z + Math.sin(a) * R, y = 40 + (i % 7) * 4;
      drones.push([
        `UAV-${String(i + 1).padStart(2, '0')}`, 'A', x, y, z,
        V.x - Math.sin(a) * R * w, 0, V.z + Math.cos(a) * R * w, 0, 0,
        'ACTIVE', Math.max(0, 100 - this.T * 0.05 - i * 0.3), 99, 40 + (i % 9),
      ]);
    }
    return {
      t: this.T, drones,
      swarms: { A: { mode: A.mode, wpIdx: A.wpIdx, waypoints: A.waypoints.map(p => [p.x, p.y, p.z]), orbitCenter: [0, 0], orbitR0: 80, orbitAlt0: 60, leader: [L.x, L.y, L.z], sweepZ: 0, hostile: false } },
    };
  }

  applyCommand(cmd: { name: string; args?: unknown[] }): { ok: boolean; msg: string } {
    const args = cmd.args ?? [];
    switch (cmd.name) {
      case 'mode': {
        const m = String(args[0] ?? '').toUpperCase();
        if (!MODES.includes(m)) return { ok: false, msg: `unknown mode ${m}` };
        this.swarms.A.setMode(m, 'command');
        return { ok: true, msg: `mode ${m}` };
      }
      case 'orbit': {
        const t = String(args[0] ?? '');
        if (!t) return { ok: false, msg: 'orbit needs a target' };
        this.swarms.A.setMode('ORBIT', `orbit ${t}`);
        return { ok: true, msg: `orbit ${t}` };
      }
      case 'drones': {
        const n = Number(args[0]);
        if (!Number.isFinite(n) || n < 0 || n > 150) return { ok: false, msg: 'drones must be 0..150' };
        this.setCount(n);
        this.hooks.log?.('info', `fleet size ${this.n}`);
        return { ok: true, msg: `drones ${this.n}` };
      }
      case 'auto': {
        const v = String(args[0] ?? '').toLowerCase();
        if (v !== 'on' && v !== 'off') return { ok: false, msg: 'auto on|off' };
        this.auto = v === 'on';
        return { ok: true, msg: `auto ${v}` };
      }
      default:
        return { ok: false, msg: `unknown command ${cmd.name}` };
    }
  }
}

class FakeSwarm {
  mode = 'PATROL';
  wpIdx = 0;
  waypoints: P3[] = [];
  missionId: string | null = null;
  leader: P3 = { x: 150, y: 60, z: 0 };
  leaderVel: P3 = { x: 0, y: 0, z: 0 };
  private w: FakeWorld;
  constructor(w: FakeWorld) { this.w = w; }

  setMode(m: string, why?: string) {
    this.mode = m;
    this.w.hooks.log?.('info', `ALPHA mode ${m}${why ? ` (${why})` : ''}`);
    this.w.hooks.onModeChange?.(this, m, why);
    this.w.hooks.onRipple?.(this.leader, 0x00ffcc);
  }

  setMission(wps: P3[], id?: string) {
    this.waypoints = wps.map(p => ({ x: p.x, y: p.y, z: p.z }));
    this.wpIdx = 0;
    this.missionId = id ?? null;
    this.setMode('MISSION', 'mission');
    this.w.hooks.onMissionEvent?.({ type: 'START', id, wpIdx: 0 });
  }

  clearMission(reason?: string) {
    this.waypoints = []; this.wpIdx = 0;
    const id = this.missionId; this.missionId = null;
    this.mode = 'PATROL';
    this.w.hooks.onMissionEvent?.({ type: 'CLEARED', id, reason });
  }

  step(dt: number) {
    const L = this.leader, T = this.w.T;
    if (this.mode === 'MISSION' && this.waypoints.length) {
      const wp = this.waypoints[this.wpIdx], dx = wp.x - L.x, dz = wp.z - L.z, d = Math.hypot(dx, dz) || 1;
      const sp = Math.min(30, d / dt);
      this.leaderVel = { x: dx / d * sp, y: 0, z: dz / d * sp };
      L.x += this.leaderVel.x * dt; L.z += this.leaderVel.z * dt; L.y = wp.y;
      if (d < 30) {
        this.wpIdx++;
        if (this.wpIdx >= this.waypoints.length) {
          const id = this.missionId;
          this.w.hooks.onMissionEvent?.({ type: 'DONE', id, wpIdx: this.wpIdx });
          this.waypoints = []; this.wpIdx = 0; this.missionId = null;
          this.setMode('PATROL', 'mission done');
        } else this.w.hooks.onMissionEvent?.({ type: 'WAYPOINT', id: this.missionId, wpIdx: this.wpIdx });
      }
    } else {
      const R = this.mode === 'ORBIT' ? 80 : 150, om = this.mode === 'ORBIT' ? 0.12 : 0.05;
      const nx = Math.cos(om * T) * R, nz = Math.sin(om * T) * R;
      this.leaderVel = { x: (nx - L.x) / dt, y: 0, z: (nz - L.z) / dt };
      if (Math.hypot(this.leaderVel.x, this.leaderVel.z) > 60) this.leaderVel = { x: -Math.sin(om * T) * R * om, y: 0, z: Math.cos(om * T) * R * om };
      L.x = nx; L.z = nz; L.y = 60;
    }
  }
}
