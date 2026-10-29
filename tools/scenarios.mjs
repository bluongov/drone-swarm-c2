// Shared scenario list (plan §5) for tools/baseline.mjs (browser) and tools/node-baseline.mjs (Node SimWorld).
export const SCENARIOS_DEF = {
  S1: { drones: 60, sec: 120, cmds: ['auto=off', 'mode=patrol'] },
  S2: { drones: 60, sec: 120, cmds: ['auto=off', 'orbit=oce'] },
  S3: { drones: 60, sec: 120, cmds: ['auto=off', 'mode=formation'] },
  S4: { drones: 60, sec: 120, cmds: ['auto=off', 'mode=scan'] },
  S5: { drones: 150, sec: 180, cmds: ['auto=off', 'mode=patrol'] },
  S6: { drones: 60, sec: 180, cmds: ['auto=off', 'mode=patrol', 'swarm2=16', 'role=hostile'] },
};
