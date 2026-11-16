import fs from 'node:fs';
import path from 'node:path';
import { run, startBackground, waitForUrl } from '../shell.js';
import { affectedWorkspaces } from '../config.js';
import { getChanges } from '../workspace.js';
import { sha256 } from '../state.js';
import { MODEL } from '../llm.js';
import { log } from '../log.js';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function copyIfExists(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  return true;
}

async function loadPlaywright() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    return null;
  }
}

/** Starts every workspace that has a start command, in config order (API before web). */
async function startServices(wt, workspaces) {
  const services = [];
  for (const ws of workspaces) {
    if (!ws.start || !ws.evidence) continue;
    const cwd = path.join(wt, ws.path);
    if (ws.evidence.prepare) {
      const prep = await run(ws.evidence.prepare, { cwd });
      if (!prep.ok) {
        services.forEach((s) => s.proc.stop());
        throw new Error(`${ws.name}: evidence prepare command failed (${prep.code}): ${ws.evidence.prepare}\n${(prep.stderr || prep.stdout).trim()}`);
      }
    }
    const proc = startBackground(ws.start, { cwd, env: ws.evidence.env ?? {} });
    const up = ws.healthcheck ? await waitForUrl(ws.healthcheck, 45000) : true;
    services.push({ ws, proc, up });
    (up ? log.ok : log.fail)(`${ws.name} ${up ? 'started' : 'failed to start'} for evidence capture`);
  }
  return services;
}

async function captureApiSamples(samples, workspaces, outDir) {
  const results = [];
  for (const s of samples) {
    const ws = workspaces.find((w) => w.name === s.workspace);
    if (!ws?.evidence?.base_url) continue;
    const request = { method: s.method.toUpperCase(), url: `${ws.evidence.base_url}${s.path}`, body: s.body };
    let response;
    try {
      const res = await fetch(request.url, {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
        body: s.body ? JSON.stringify(s.body) : undefined,
      });
      const text = await res.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep text */
      }
      response = { status: res.status, body };
    } catch (err) {
      response = { error: err.message };
    }
    const passed = response.status === s.expect_status;
    const record = { name: s.name, request, expect_status: s.expect_status, response, passed };
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `${s.name}.json`), JSON.stringify(record, null, 2));
    (passed ? log.ok : log.fail)(`API sample ${s.name}: ${request.method} ${s.path} → ${response.status ?? response.error} (expected ${s.expect_status})`);
    results.push({ name: s.name, passed, status: response.status });
  }
  return results;
}

async function captureScreenshots(workspaces, outDir) {
  const uiWorkspaces = workspaces.filter((w) => w.evidence?.type === 'ui');
  if (uiWorkspaces.length === 0) return { skipped: 'no UI workspace affected' };
  const chromium = await loadPlaywright();
  if (!chromium) return { skipped: 'playwright not installed (npm i playwright && npx playwright install chromium)' };

  const browser = await chromium.launch();
  const shots = [];
  try {
    for (const ws of uiWorkspaces) {
      for (const route of ws.evidence.routes ?? ['/']) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const consoleErrors = [];
        page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
        await page.goto(`${ws.evidence.base_url}${route}`, { waitUntil: 'networkidle' });
        const file = `${ws.name}${route === '/' ? '-home' : route.replace(/\//g, '-')}.png`;
        fs.mkdirSync(outDir, { recursive: true });
        await page.screenshot({ path: path.join(outDir, file), fullPage: true });
        shots.push({ workspace: ws.name, route, file, consoleErrors });
        log.ok(`Screenshot ${file}${consoleErrors.length ? ` (${consoleErrors.length} console errors)` : ''}`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return { shots };
}

export async function evidence(ctx) {
  const { state, config, repo } = ctx;
  const wt = state.data.worktree;
  const outDir = path.join(repo, 'testing-evidence', state.data.taskId, stamp());
  fs.mkdirSync(outDir, { recursive: true });

  for (const name of ['readiness.json', 'plan.json', 'implementation.json', 'review.json', 'guardrails.json']) {
    copyIfExists(path.join(state.dir, name), path.join(outDir, name));
  }
  copyIfExists(path.join(state.dir, 'checks'), path.join(outDir, 'logs'));

  const changes = await getChanges(wt, state.data.baseCommit);
  fs.writeFileSync(path.join(outDir, 'diff.patch'), changes.diff);
  const touched = affectedWorkspaces(config, changes.files);

  for (const ws of touched) {
    if (ws.reports?.junit) copyIfExists(path.join(wt, ws.path, ws.reports.junit), path.join(outDir, 'reports', ws.name, path.basename(ws.reports.junit)));
  }

  const needsServices = touched.length > 0;
  const services = needsServices ? await startServices(wt, config.workspaces) : [];
  let apiResults = [];
  let ui = { skipped: 'services not started' };
  try {
    if (services.every((s) => s.up)) {
      const samples = [
        ...touched.flatMap((ws) => (ws.evidence?.samples ?? []).map((s) => ({ ...s, workspace: ws.name }))),
        ...(state.data.plan.api_samples ?? []),
      ];
      apiResults = await captureApiSamples(samples, config.workspaces, path.join(outDir, 'api-samples'));
      ui = await captureScreenshots(touched, path.join(outDir, 'screenshots'));
      if (ui.skipped) log.warn(`Screenshots skipped: ${ui.skipped}`);
    }
  } finally {
    services.forEach((s) => s.proc.stop());
    for (const ws of config.workspaces) {
      const dbCopy = ws.evidence?.env?.DB_FILE;
      if (dbCopy) fs.rmSync(path.join(wt, ws.path, dbCopy), { force: true });
    }
  }

  const g = state.data.guardrails ?? [];
  const lastReview = state.data.reviews?.at(-1);
  const manifest = {
    taskId: state.data.taskId,
    summary: state.data.issue.summary,
    issueType: state.data.issue.type,
    runId: state.data.runId,
    branch: state.data.branch,
    baseCommit: state.data.baseCommit,
    commit: null,
    diffSha256: sha256(changes.diff),
    planSha256: state.data.planHash,
    filesChanged: changes.files,
    linesChanged: changes.linesChanged,
    checks: g.map((r) => ({ name: r.name, passed: r.passed, blocking: r.blocking })),
    guardrailsPassed: g.filter((r) => r.blocking).every((r) => r.passed),
    review: lastReview ? { verdict: lastReview.verdict, openFindings: lastReview.findings.length } : null,
    apiSamples: apiResults,
    screenshots: ui.shots?.map((s) => s.file) ?? [],
    screenshotsSkipped: ui.skipped ?? null,
    approvals: state.data.approvals,
    model: MODEL,
    tokens: state.data.usage,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  state.data.evidenceDir = outDir;
  log.ok(`Evidence saved to ${path.relative(repo, outDir)}`);
  return 'final_approval';
}
