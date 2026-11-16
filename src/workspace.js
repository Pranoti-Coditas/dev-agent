import fs from 'node:fs';
import path from 'node:path';
import { mustRun, run } from './shell.js';
import { log } from './log.js';

/**
 * Each task gets its own git worktree and branch, so the agent never edits
 * your working copy and several tasks can run side by side.
 */
export async function ensureWorktree(repo, taskId, state) {
  const wt = path.join(repo, '.agent', 'worktrees', taskId);
  const branch = `agent/${taskId}`;
  if (!fs.existsSync(wt)) {
    await mustRun('git rev-parse --is-inside-work-tree', { cwd: repo });
    const base = await mustRun('git rev-parse HEAD', { cwd: repo });
    const branchExists = (await run(`git rev-parse --verify --quiet ${branch}`, { cwd: repo })).ok;
    await mustRun(branchExists ? `git worktree add "${wt}" ${branch}` : `git worktree add -b ${branch} "${wt}" HEAD`, { cwd: repo });
    state.data.baseCommit = base;
    log.ok(`Created worktree ${path.relative(repo, wt)} on branch ${branch}`);
  }
  state.data.worktree = wt;
  state.data.branch = branch;
  state.save();
  return wt;
}

export async function installDependencies(wt, config, state) {
  if (state.data.depsInstalled) return;
  for (const ws of config.workspaces) {
    if (!ws.install) continue;
    log.info(`Installing dependencies in ${ws.name}…`);
    const res = await run(ws.install, { cwd: path.join(wt, ws.path) });
    if (!res.ok) throw new Error(`Install failed in ${ws.name}:\n${res.stderr.slice(-2000)}`);
  }
  state.data.depsInstalled = true;
  state.save();
}

/** Diff of everything the agent changed since the base commit, including new files. */
export async function getChanges(wt, baseCommit) {
  await run('git add --intent-to-add --all', { cwd: wt });
  const diff = (await run(`git diff ${baseCommit}`, { cwd: wt })).stdout;
  const files = (await run(`git diff --name-only ${baseCommit}`, { cwd: wt })).stdout.split('\n').filter(Boolean);
  const stat = (await run(`git diff --stat ${baseCommit}`, { cwd: wt })).stdout.trim();
  const numstat = (await run(`git diff --numstat ${baseCommit}`, { cwd: wt })).stdout;
  const linesChanged = numstat
    .split('\n')
    .filter(Boolean)
    .reduce((sum, line) => {
      const [a, d] = line.split('\t');
      return sum + (Number(a) || 0) + (Number(d) || 0);
    }, 0);
  const addedLines = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
  return { diff, files, stat, linesChanged, addedLines };
}
