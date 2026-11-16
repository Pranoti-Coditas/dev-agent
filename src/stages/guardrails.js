import fs from 'node:fs';
import path from 'node:path';
import { run, tail } from '../shell.js';
import { matchesAny } from '../glob.js';
import { affectedWorkspaces } from '../config.js';
import { getChanges } from '../workspace.js';
import { log } from '../log.js';

const SECRET_PATTERNS = [
  { name: 'private key', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'GCP service account', re: /"type"\s*:\s*"service_account"/ },
  { name: 'hard-coded credential', re: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i },
];

/**
 * Deterministic checks. No LLM involved: a model can be argued out of a
 * rule, a script cannot. Returns a list of { name, passed, blocking, details }.
 */
export async function runGuardrailChecks({ wt, config, plan, baseCommit, logDir }) {
  const g = config.guardrails;
  const changes = await getChanges(wt, baseCommit);
  const results = [];
  const add = (name, passed, details, blocking = true) => results.push({ name, passed, blocking, details });

  const protectedHits = changes.files.filter((f) => matchesAny(f, g.protected_paths));
  add('protected_paths', protectedHits.length === 0, protectedHits.length ? `Protected files changed: ${protectedHits.join(', ')}` : 'No protected files changed');

  const planned = new Set([...plan.files_to_change.map((f) => f.path), ...plan.new_files.map((f) => f.path)]);
  const unplanned = changes.files.filter((f) => !planned.has(f) && !matchesAny(f, g.always_allowed));
  add('scope', unplanned.length === 0, unplanned.length ? `Files changed outside the approved plan: ${unplanned.join(', ')}` : 'All changes are within the approved plan');

  add('diff_size', changes.files.length <= g.max_files_changed && changes.linesChanged <= g.max_lines_changed,
    `${changes.files.length}/${g.max_files_changed} files, ${changes.linesChanged}/${g.max_lines_changed} lines`);

  const secrets = [];
  for (const line of changes.addedLines) for (const p of SECRET_PATTERNS) if (p.re.test(line)) secrets.push(`${p.name}: ${line.trim().slice(0, 80)}`);
  add('secret_scan', secrets.length === 0, secrets.length ? secrets.join('\n') : 'No secrets found in added lines');

  const forbidden = [];
  for (const pattern of g.forbidden_patterns ?? []) {
    const re = new RegExp(pattern);
    for (const line of changes.addedLines) if (re.test(line)) forbidden.push(`/${pattern}/: ${line.trim().slice(0, 80)}`);
  }
  add('forbidden_patterns', forbidden.length === 0, forbidden.length ? forbidden.join('\n') : 'None found');

  const touched = affectedWorkspaces(config, changes.files);
  const manifestsChanged = touched.filter((ws) => ws.manifest && changes.files.includes(path.posix.join(ws.path, ws.manifest)));
  const undeclaredDeps = manifestsChanged.length > 0 && !(plan.new_dependencies?.length > 0);
  add('new_dependencies', !undeclaredDeps, undeclaredDeps ? `Dependency manifest changed in ${manifestsChanged.map((w) => w.name).join(', ')} but the plan declared no new dependencies` : 'OK');

  fs.mkdirSync(logDir, { recursive: true });
  for (const ws of touched) {
    for (const [check, cmd] of Object.entries(ws.checks ?? {})) {
      const res = await run(cmd, { cwd: path.join(wt, ws.path), env: { CI: 'true' } });
      fs.writeFileSync(path.join(logDir, `${ws.name}-${check}.log`), `$ ${cmd}\nexit ${res.code} in ${res.durationMs}ms\n\n${res.stdout}\n${res.stderr}`);
      add(`${ws.name}:${check}`, res.ok, res.ok ? `passed in ${res.durationMs}ms` : tail(res.stdout + res.stderr, 40));
    }
    if (ws.audit && g.dependency_audit !== 'off') {
      const res = await run(ws.audit, { cwd: path.join(wt, ws.path), timeoutMs: 120000 });
      fs.writeFileSync(path.join(logDir, `${ws.name}-audit.log`), `${res.stdout}\n${res.stderr}`);
      add(`${ws.name}:dependency_audit`, res.ok, res.ok ? 'No high-severity advisories' : tail(res.stdout, 20), g.dependency_audit === 'block');
    }
  }
  if (touched.length === 0) add('checks', false, 'No workspace was affected by the change; nothing was tested');

  return { results, changes };
}

export async function guardrails(ctx) {
  const { state, config } = ctx;
  const { results } = await runGuardrailChecks({
    wt: state.data.worktree,
    config,
    plan: state.data.plan,
    baseCommit: state.data.baseCommit,
    logDir: path.join(state.dir, 'checks'),
  });

  state.data.guardrails = results;
  state.writeArtifact('guardrails.json', results);
  for (const r of results) {
    const fn = r.passed ? log.ok : r.blocking ? log.fail : log.warn;
    fn(`${r.name}: ${r.passed ? r.details : r.details.split('\n')[0]}`);
  }

  const blocking = results.filter((r) => !r.passed && r.blocking);
  if (blocking.length === 0) return 'evidence';

  state.data.counters.guardrailFixes += 1;
  if (state.data.counters.guardrailFixes > config.agent.max_guardrail_fixes) {
    log.fail(`Guardrails still failing after ${config.agent.max_guardrail_fixes} fix attempts. Stopping for a human to look.`);
    log.info(`Worktree: ${state.data.worktree}`);
    state.data.blocked = 'guardrails';
    return null;
  }
  state.data.pendingFixes = blocking.map((r) => ({ source: `guardrail/${r.name}`, message: r.details }));
  return 'implement';
}
