// Guards the CI/merge policy documented in docs/ci.md: a refactor of the
// workflow must not silently drop the properties that stop a PR showing green
// while its merge result fails. Runs without dependencies (plain text checks).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wf = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const checks = [
  ['runs on pull_request', /^\s*pull_request:/m],
  ['runs on merge_group', /^\s*merge_group:/m],
  ['runs on push to main', /^\s*push:\s*\n\s*branches:\s*\n\s*- main/m],
  ['has merge-freshness job', /^\s{2}merge-freshness:/m],
  ['freshness compares against the base tip', /merge-base --is-ancestor "\$base_tip" HEAD/],
  ['freshness rejects a bare PR head checkout', /bare PR head/],
  ['has ci-gate job', /^\s{2}ci-gate:/m],
  ['ci-gate always runs', /ci-gate:[\s\S]*?if: always\(\)/],
  ['ci-gate needs every job', /needs: \[merge-freshness, test, security, image\]/],
  ['does not use pull_request_target', /^(?![\s\S]*pull_request_target)[\s\S]*$/],
  ['does not pin checkout to the PR head sha', /^(?![\s\S]*ref:\s*\$\{\{\s*github\.event\.pull_request\.head)[\s\S]*$/],
];
const failures = checks.filter(([, re]) => !re.test(wf)).map(([name]) => name);
assert.deepEqual(failures, [], `CI policy violated: ${failures.join('; ')}`);

// Every job other than the gate must be listed in the gate's needs.
const jobsSection = wf.slice(wf.indexOf('\njobs:'));
const jobs = [...jobsSection.matchAll(/^ {2}([a-z][a-z-]*):\s*$/gm)].map((m) => m[1]).filter((j) => j !== 'services');
const others = jobs.filter((j) => j !== 'ci-gate');
assert.ok(others.length > 0, 'no jobs found');
assert.ok(wf.includes(`needs: [${others.join(', ')}]`), `ci-gate.needs must list exactly: ${others.join(', ')}`);
console.log('verify:ci-policy ok');
