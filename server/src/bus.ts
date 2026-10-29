// Tiny typed event emitter. A throwing listener never breaks the emitter (or the world tick).

export interface LogEvent { lv: string; msg: string; t: number }
export interface RippleEvent { x: number; y: number; z: number; color: unknown }
export interface MissionEvent { id: string; status: string; wpIdx?: number; total?: number }
export interface SnapEvent { snap: any; wallMs: number }

export interface BusEvents {
  log: LogEvent;
  ripple: RippleEvent;
  mission: MissionEvent;     // broadcast to WS clients as {type:'mission', ...}; emitted by the mission service (WP5)
  snap: SnapEvent;           // every SNAP_HZ, raw world snapshot
  worldMission: unknown;     // raw hooks.onMissionEvent payload from the core, for the mission service
}

export class Bus {
  private map = new Map<keyof BusEvents, Set<(p: any) => void>>();
  onError: (err: unknown, ev: string) => void = () => {};

  on<K extends keyof BusEvents>(ev: K, fn: (p: BusEvents[K]) => void): () => void {
    let set = this.map.get(ev);
    if (!set) this.map.set(ev, (set = new Set()));
    set.add(fn);
    return () => { set.delete(fn); };
  }

  emit<K extends keyof BusEvents>(ev: K, payload: BusEvents[K]): void {
    const set = this.map.get(ev);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (err) { this.onError(err, ev); }
    }
  }

  listenerCount(ev: keyof BusEvents): number { return this.map.get(ev)?.size ?? 0; }
}
