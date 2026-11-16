/**
 * Offline self-test: exercises config loading, git worktrees, guardrails and
 * evidence capture against a scratch copy of the demo app. No API key needed.
 * Usage: node src/selftest.js [path-to-demo-app]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { globToRegExp } from './glob.js';
import { loadConfig } from './config.js';
import { RunState } from './state.js';
import { ensureWorktree, getChanges } from './workspace.js';
import { runGuardrailChecks } from './stages/guardrails.js';
import { evidence } from './stages/evidence.js';
import { mustRun } from './shell.js';
import { log } from './log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.resolve(process.argv[2] ?? path.join(here, '..', '..', 'demo-app'));

assert.ok(globToRegExp('**/tests/**').test('api/tests/a.test.js'));
assert.ok(globToRegExp('.env*').test('.env.local'));
assert.ok(!globToRegExp('api/db.json').test('api/src/db.json'));
log.ok('glob matcher');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-selftest-'));
const repo = path.join(tmp, 'demo-app');
fs.cpSync(demo, repo, { recursive: true, filter: (src) => !/node_modules|\.agent\/(runs|worktrees)|testing-evidence|reports|dist|\.git$/.test(src) });
await mustRun('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=test commit -qm init', { cwd: repo });

const config = loadConfig(repo);
assert.deepEqual(config.workspaces.map((w) => w.name), ['api', 'web']);
assert.equal(config.workspaces[1].checks.build, 'npm run build');
log.ok('config + presets');

const state = new RunState(repo, 'DEMO-1');
const wt = await ensureWorktree(repo, 'DEMO-1', state);
for (const ws of ['api', 'web']) {
  const src = path.join(demo, ws, 'node_modules');
  if (!fs.existsSync(src)) throw new Error(`Run npm install in ${demo}/${ws} first`);
  fs.symlinkSync(src, path.join(wt, ws, 'node_modules'), 'junction'); // junction: no admin needed on Windows
}
log.ok('worktree');

// Simulate what the coding agent would produce for DEMO-1.
const validate = path.join(wt, 'api/src/validate.js');
fs.writeFileSync(validate, fs.readFileSync(validate, 'utf8').replace(
  /errors\.push\('stock must be an integer'\);(\r?\n)    \}/, // tolerate CRLF checkouts on Windows
  "errors.push('stock must be an integer');$1    } else if (body.stock < 0) {$1      errors.push('stock cannot be negative');$1    }"
));
fs.writeFileSync(path.join(wt, 'api/tests/negative-stock.test.js'), `import { it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
it('rejects negative stock', async () => {
  const res = await request(createApp({ products: [] })).post('/products').send({ name: 'x', price: 1, stock: -5 });
  expect(res.status).toBe(400);
  expect(res.body.errors).toContain('stock cannot be negative');
});
it('allows zero stock', async () => {
  const res = await request(createApp({ products: [] })).post('/products').send({ name: 'x', price: 1, stock: 0 });
  expect(res.status).toBe(201);
});
`);

const plan = {
  summary: 'Reject negative stock',
  files_to_change: [{ path: 'api/src/validate.js', change: 'add check' }],
  new_files: [],
  test_plan: ['regression test'],
  risks: [],
  api_samples: [{ name: 'reject-negative-stock', workspace: 'api', method: 'POST', path: '/products', body: { name: 'Test', price: 100, stock: -5 }, expect_status: 400 }],
};

const good = await runGuardrailChecks({ wt, config: { ...config, guardrails: { ...config.guardrails, dependency_audit: 'off' } }, plan, baseCommit: state.data.baseCommit, logDir: path.join(state.dir, 'checks') });
const failed = good.results.filter((r) => !r.passed && r.blocking);
assert.equal(failed.length, 0, `unexpected guardrail failures: ${JSON.stringify(failed, null, 2)}`);
assert.ok(good.results.some((r) => r.name === 'api:test' && r.passed));
log.ok(`guardrails pass on a clean change (${good.results.length} checks)`);

fs.appendFileSync(validate, `\nconst apiKey = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";\ndebugger;\n`);
fs.writeFileSync(path.join(wt, 'api/db.json'), '{"products":[]}');
fs.writeFileSync(path.join(wt, 'web/src/extra.js'), 'export const x = 1;\n');
const bad = await runGuardrailChecks({ wt, config: { ...config, guardrails: { ...config.guardrails, dependency_audit: 'off' } }, plan, baseCommit: state.data.baseCommit, logDir: path.join(state.dir, 'checks-bad') });
const names = bad.results.filter((r) => !r.passed).map((r) => r.name);
for (const expected of ['protected_paths', 'scope', 'secret_scan', 'forbidden_patterns']) assert.ok(names.includes(expected), `expected ${expected} to fail, got ${names}`);
log.ok(`guardrails block bad changes: ${names.join(', ')}`);

// Undo the bad changes and capture evidence with the real API running.
await mustRun('git checkout -- api/db.json', { cwd: wt });
fs.rmSync(path.join(wt, 'web/src/extra.js'));
fs.writeFileSync(validate, fs.readFileSync(validate, 'utf8').replace(/\nconst apiKey[\s\S]*$/, '\n'));
await runGuardrailChecks({ wt, config: { ...config, guardrails: { ...config.guardrails, dependency_audit: 'off' } }, plan, baseCommit: state.data.baseCommit, logDir: path.join(state.dir, 'checks') });

Object.assign(state.data, { issue: { key: 'DEMO-1', summary: 'API accepts negative stock', type: 'bug' }, plan, guardrails: good.results, reviews: [{ verdict: 'approve', findings: [] }] });
await evidence({ state, config, repo });
const manifest = JSON.parse(fs.readFileSync(path.join(state.data.evidenceDir, 'manifest.json'), 'utf8'));
assert.ok(manifest.apiSamples.find((s) => s.name === 'reject-negative-stock')?.passed, 'negative stock sample should return 400');
assert.ok(fs.existsSync(path.join(state.data.evidenceDir, 'reports', 'api', 'junit.xml')));
const changes = await getChanges(wt, state.data.baseCommit);
assert.ok(!changes.files.some((f) => f.includes('evidence-db')), 'evidence DB copy must not leak into the diff');
log.ok(`evidence captured: ${fs.readdirSync(state.data.evidenceDir).join(', ')}`);

console.log(`\nAll self-tests passed. Scratch repo: ${repo}`);
