import fs from 'node:fs';
import path from 'node:path';
import { run, mustRun } from '../shell.js';
import { getChanges } from '../workspace.js';
import { humanGate } from '../approval.js';
import { color, log } from '../log.js';

export async function finalApproval(ctx) {
  const { state, repo } = ctx;
  const wt = state.data.worktree;
  const changes = await getChanges(wt, state.data.baseCommit);
  const review = state.data.reviews?.at(-1);
  const manifest = JSON.parse(fs.readFileSync(path.join(state.data.evidenceDir, 'manifest.json'), 'utf8'));

  console.log(`\n${color.bold('Changes')}\n${changes.stat}`);
  console.log(`\n${color.bold('Implementation')}\n  ${state.data.implementation.summary}`);
  if (state.data.implementation.red_green) console.log(`  Red/green: ${state.data.implementation.red_green}`);
  console.log(`\n${color.bold('Review')}: ${review?.verdict ?? 'n/a'}, ${review?.findings.length ?? 0} findings`);
  review?.findings.forEach((f) => console.log(`  • [${f.severity}] ${f.file ?? ''} ${f.message}`));
  console.log(`\n${color.bold('Guardrails')}: ${manifest.guardrailsPassed ? color.green('all blocking checks passed') : color.red('FAILED')}`);
  manifest.apiSamples.forEach((s) => console.log(`  • API ${s.name}: ${s.passed ? 'as expected' : 'UNEXPECTED'} (${s.status})`));
  console.log(`\n${color.bold('Evidence')}: ${path.relative(repo, state.data.evidenceDir)}`);
  console.log(`${color.bold('Try it yourself')}: the change is checked out in ${path.relative(process.cwd(), wt) || wt}`);

  const gate = await humanGate('Verify the changes manually, then approve to commit.', {
    extras: [{ key: 'd', label: 'show diff', action: async () => console.log(changes.diff) }],
  });
  state.audit({ type: 'gate', stage: 'final_approval', ...gate });

  if (gate.decision === 'quit') return null;
  if (gate.decision === 'reject') {
    state.data.feedback.push({ stage: 'final_approval', feedback: gate.feedback, at: gate.at });
    state.data.pendingFixes = [{ source: 'human', message: gate.feedback }];
    state.data.counters = { reviewRounds: 0, guardrailFixes: 0 };
    return 'implement';
  }
  state.data.approvals.push({ gate: 'final', by: gate.by, at: gate.at, diffSha256: manifest.diffSha256 });
  return 'commit';
}

export async function commit(ctx) {
  const { state, jira, push, repo } = ctx;
  const wt = state.data.worktree;
  const issue = state.data.issue;

  const message = `${issue.key}: ${issue.summary}

${state.data.implementation.summary}

Agent-Run: ${state.data.runId}
Plan-Approved-By: ${state.data.approvals.find((a) => a.gate === 'plan')?.by}
Final-Approved-By: ${state.data.approvals.find((a) => a.gate === 'final')?.by}
`;
  const msgFile = path.join(state.dir, 'commit-message.txt');
  fs.writeFileSync(msgFile, message);
  await mustRun('git add --all', { cwd: wt });
  await mustRun(`git commit -F "${msgFile}"`, { cwd: wt });
  const sha = await mustRun('git rev-parse HEAD', { cwd: wt });
  log.ok(`Committed ${sha.slice(0, 10)} on ${state.data.branch}`);

  const manifestFile = path.join(state.data.evidenceDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.commit = sha;
  manifest.approvals = state.data.approvals;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  if (push) {
    const hasRemote = (await run('git remote get-url origin', { cwd: wt })).ok;
    if (hasRemote) {
      await mustRun(`git push -u origin ${state.data.branch}`, { cwd: wt });
      log.ok(`Pushed ${state.data.branch}. Open a pull request from it.`);
    } else log.warn('No "origin" remote configured; skipped push.');
  }

  await jira.addComment(
    issue.key,
    `Implemented by the AI dev agent and approved by ${manifest.approvals.map((a) => `${a.by} (${a.gate})`).join(', ')}.\n\nBranch: ${state.data.branch}\nCommit: ${sha}\n\n${state.data.implementation.summary}\n\nLocal test evidence: ${path.relative(repo, state.data.evidenceDir)}`
  );
  log.ok(`Posted a summary to ${issue.key} (${jira.mode})`);
  state.data.commit = sha;
  return 'done';
}
