#!/usr/bin/env node
/**
 * Unified npm audit runner.
 * - Prints summary to stdout (for GitHub & Render logs)
 * - Writes full JSON report
 * - Fails if severity >= FAIL_LEVEL (default: high)
 *
 * Usage:
 *   node scripts/audit-ci.js [directory] [outputPath]
 *   FAIL_LEVEL=critical node scripts/audit-ci.js ASEI-Project/backend backend-audit.json
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || '.';
const out = process.argv[3] || 'npm-audit.json';
const failLevel = (process.env.FAIL_LEVEL || 'high').toLowerCase();
const levels = ['low', 'moderate', 'high', 'critical'];

if (!levels.includes(failLevel)) {
  console.error(`Invalid FAIL_LEVEL "${failLevel}". Use one of: ${levels.join(', ')}`);
  process.exit(2);
}

console.log(`→ Running npm audit in: ${dir} (fail on ${failLevel}+)\n`);

const run = spawnSync('npm', ['audit', '--production', '--json'], {
  cwd: dir,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
});

const jsonOut = run.stdout.trim();
if (!jsonOut) {
  console.error('No output from npm audit. stderr:\n', run.stderr);
  process.exit(run.status || 1);
}

let report;
try {
  report = JSON.parse(jsonOut);
} catch (e) {
  console.error('Failed to parse npm audit JSON:', e);
  process.exit(1);
}

const outPath = path.resolve(process.cwd(), out);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`Saved full report → ${outPath}\n`);

const vulns = report.vulnerabilities || {};
const counts = { low:0, moderate:0, high:0, critical:0 };
Object.values(vulns).forEach(v => {
  const sev = (v.severity || '').toLowerCase();
  if (counts[sev] !== undefined) counts[sev] += 1;
});

console.log('Vulnerabilities by severity:', counts);

const failIdx = levels.indexOf(failLevel);
const shouldFail =
  (counts.critical > 0 && failIdx <= levels.indexOf('critical')) ||
  (counts.high > 0 && failIdx <= levels.indexOf('high')) ||
  (counts.moderate > 0 && failIdx <= levels.indexOf('moderate')) ||
  (counts.low > 0 && failIdx <= levels.indexOf('low'));

if (shouldFail) {
  console.error(`\n❌ Failing: found ${failLevel}+ vulnerabilities.`);
  process.exit(1);
}

console.log('\n✅ Passed: no vulnerabilities at or above fail level.');
process.exit(0);
