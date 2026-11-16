import path from 'node:path';
import { loadConfig } from './config.js';
import { RunState } from './state.js';
import { createJiraClient } from './jira.js';
import { log } from './log.js';
import { BudgetError } from './llm.js';
import { readiness } from './stages/readiness.js';
import { plan, planApproval } from './stages/plan.js';
import { implement } from './stages/implement.js';
import { review } from './stages/review.js';
import { guardrails } from './stages/guardrails.js';
import { evidence } from './stages/evidence.js';
import { finalApproval, commit } from './stages/finalize.js';

async function intake(ctx) {
  const issue = await ctx.jira.getIssue(ctx.taskId);
  ctx.state.data.issue = issue;
  log.ok(`${issue.key} [${issue.rawType} → ${issue.type} playbook] ${issue.summary}`);
  return 'readiness';
}

/**
 * The state machine. Each stage returns the next stage name, or null to
 * pause (human quit, ticket blocked). State is saved after every step, so
 * `resume` continues exactly where the run stopped.
 */
const STAGES = {
  intake,
  readiness,
  plan,
  plan_approval: planApproval,
  implement,
  review,
  guardrails,
  evidence,
  final_approval: finalApproval,
  commit,
};

export async function runTask({ repo, taskId, fresh = false, push = false }) {
  const repoPath = path.resolve(repo);
  const config = loadConfig(repoPath);
  const state = new RunState(repoPath, taskId, { fresh });
  state.budget = config.agent.max_tokens_per_run;
  const ctx = { repo: repoPath, taskId, config, state, jira: createJiraClient(repoPath, config), push };

  log.info(`Run ${state.data.runId} · stage ${state.data.stage} · Jira ${ctx.jira.mode}`);
  while (state.data.stage !== 'done') {
    const stage = state.data.stage;
    log.stage(stage);
    let next;
    try {
      next = await STAGES[stage](ctx);
    } catch (err) {
      state.audit({ type: 'error', stage, message: err.message });
      state.save();
      if (err instanceof BudgetError) log.fail(`Budget limit: ${err.message}`);
      throw err;
    }
    if (!next) {
      state.save();
      log.info(`Paused at "${state.data.stage}". Resume with: npm run agent -- resume ${taskId} --repo ${repo}`);
      return state.data;
    }
    state.transition(next);
  }
  log.ok(`Done. Tokens used: ${state.totalTokens()}`);
  return state.data;
}

export function status({ repo, taskId }) {
  const state = new RunState(path.resolve(repo), taskId);
  return state.data;
}
