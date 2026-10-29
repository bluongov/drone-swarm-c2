// tools/compare.mjs · compare a candidate baseline against the golden one (plan §5 bands).
// Usage: node tools/compare.mjs server/test/golden.json docs/reports/new.json   → exit 1 if any check fails
import { readFileSync } from 'node:fs';
import { compareScenario } from './metrics.mjs';
const [g, c] = process.argv.slice(2).map(f => JSON.parse(readFileSync(f, 'utf8')));
let fail = 0;
for (const [n, cs] of Object.entries(c.scenarios)) {
  if (!g.scenarios[n]) { console.log(`${n}: not in golden, skipped`); continue; }
  for (const r of compareScenario(n, g.scenarios[n], cs)) {
    if (!r.ok) fail++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${n} ${r.key.padEnd(15)} value=${r.value} band=${JSON.stringify(r.golden)} (${r.rule})`);
  }
}
console.log(fail ? `${fail} check(s) FAILED` : 'ALL PASS');
process.exit(fail ? 1 : 0);
