// tools/metrics.mjs · swarm behaviour statistics, computed INSIDE the page (window.__swarm) or in Node (SimWorld).
// Shared by tools/baseline.mjs (golden statistics from the original code) and regression / parity checks.
// All distances in scene units (1 unit = 2 m).

export const R_NEI = 16;

// Returns one sample: { active, meanSpeed, meanNei, minSep, contacts, nfzFriendly, intercepting }
// drones: [{ pos:{x,y,z}, vel:{x,y,z}, state, hostile (bool), swarm (key), target (bool), top? (terrain under it) }]
// topAt(x,z) → top of terrain (scene units); obstacles: [{x,z,r,h,type}]
export function sampleMetrics(drones, topAt, obstacles) {
  const flying = drones.filter(d => d.state === 'ACTIVE' || d.state === 'RTB');
  const act = drones.filter(d => d.state === 'ACTIVE' && !d.hostile);
  let spd = 0, nei = 0;
  for (const d of act) {
    spd += Math.hypot(d.vel.x, d.vel.y, d.vel.z);
    for (const o of act) if (o !== d && o.swarm === d.swarm && Math.hypot(d.pos.x - o.pos.x, d.pos.y - o.pos.y, d.pos.z - o.pos.z) < R_NEI) nei++;
  }
  let minSep = Infinity;
  for (let i = 0; i < flying.length; i++) for (let j = i + 1; j < flying.length; j++) {
    const a = flying[i].pos, b = flying[j].pos;
    minSep = Math.min(minSep, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
  }
  let contacts = 0, nfzFriendly = 0;
  for (const d of flying) {
    if (d.pos.y < (d.top ?? topAt(d.pos.x, d.pos.z))) contacts++;
    if (!d.hostile) for (const o of obstacles) if (o.type === 'NFZ' && Math.hypot(d.pos.x - o.x, d.pos.z - o.z) < o.r && d.pos.y < o.h) nfzFriendly++;
  }
  return {
    active: act.length,
    meanSpeed: act.length ? spd / act.length : 0,
    meanNei: act.length ? nei / act.length : 0,
    minSep: Number.isFinite(minSep) ? minSep : null,
    contacts, nfzFriendly,
    intercepting: drones.filter(d => d.target).length,
  };
}

// Aggregate samples of ONE run → scalar stats
export function aggregate(samples) {
  const avg = k => samples.reduce((s, x) => s + x[k], 0) / Math.max(1, samples.length);
  const seps = samples.map(s => s.minSep).filter(v => v != null);
  return {
    samples: samples.length,
    active: avg('active'),
    meanSpeed: avg('meanSpeed'),
    meanNei: avg('meanNei'),
    minSep: seps.length ? Math.min(...seps) : null,
    contacts: samples.reduce((s, x) => s + x.contacts, 0),
    nfzFriendly: samples.reduce((s, x) => s + x.nfzFriendly, 0),
    maxIntercepting: Math.max(0, ...samples.map(s => s.intercepting)),
  };
}

// Several runs of one scenario → { runs:[...], mean, min, max } per numeric key
export function summarize(runs) {
  const keys = Object.keys(runs[0]).filter(k => typeof runs[0][k] === 'number');
  const out = { runs };
  for (const stat of ['mean', 'min', 'max']) out[stat] = {};
  for (const k of keys) {
    const v = runs.map(r => r[k]).filter(x => x != null);
    out.mean[k] = v.reduce((a, b) => a + b, 0) / v.length;
    out.min[k] = Math.min(...v);
    out.max[k] = Math.max(...v);
  }
  return out;
}

// Plan §5 statistical bands. golden/candidate = summarize() outputs for one scenario.
// Returns [{ key, ok, golden:[min,max], value, rule }]
export function compareScenario(name, golden, cand) {
  const res = [];
  const c = cand.mean, gmin = golden.min, gmax = golden.max;
  const band = (k, pct) => {
    const lo = gmin[k] * (1 - pct), hi = gmax[k] * (1 + pct);
    res.push({ key: k, ok: c[k] >= lo && c[k] <= hi, golden: [+lo.toFixed(3), +hi.toFixed(3)], value: +c[k].toFixed(3), rule: `golden run range ±${pct * 100}%` });
  };
  band('meanSpeed', 0.03);
  band('meanNei', 0.05);
  res.push({ key: 'active', ok: c.active >= gmin.active - 2 && c.active <= gmax.active + 2, golden: [gmin.active - 2, gmax.active + 2], value: +c.active.toFixed(2), rule: 'golden range ±2' });
  // minSep is a tail statistic (min over a run): compare the MEAN of per-run minima against the golden worst run.
  // Reruns of the unchanged original code reach ~75 % of the golden worst run (docs/reports, WP2 control run).
  if (gmin.minSep != null && c.minSep != null) res.push({ key: 'minSep', ok: c.minSep >= gmin.minSep * 0.85, golden: [+(gmin.minSep * 0.85).toFixed(3), null], value: +c.minSep.toFixed(3), rule: 'mean of run minima >= 85% of golden worst run' });
  res.push({ key: 'contacts', ok: cand.max.contacts <= gmax.contacts, golden: [0, gmax.contacts], value: cand.max.contacts, rule: '<= golden max (expect 0)' });
  res.push({ key: 'nfzFriendly', ok: c.nfzFriendly <= gmax.nfzFriendly + 0.5, golden: [0, gmax.nfzFriendly + 0.5], value: +c.nfzFriendly.toFixed(2), rule: 'mean <= golden max + 0.5 (rare grazes exist in the original)' });
  if (gmax.maxIntercepting > 0) res.push({ key: 'maxIntercepting', ok: cand.max.maxIntercepting > 0, golden: [1, null], value: cand.max.maxIntercepting, rule: 'at least one intercept' });
  return res.map(r => ({ scenario: name, ...r }));
}
