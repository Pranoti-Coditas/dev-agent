import { runAgent, submitTool } from '../llm.js';
import { buildTools } from '../tools.js';
import { repoBrief, taskBrief } from '../playbooks.js';
import { getChanges } from '../workspace.js';
import { confirm } from '../approval.js';
import { log } from '../log.js';

/**
 * A separate reviewer with a fresh context. It sees the diff, the approved
 * plan and the acceptance criteria, but not the coder's reasoning.
 */
export async function review(ctx) {
  const { state, config } = ctx;
  const wt = state.data.worktree;
  const changes = await getChanges(wt, state.data.baseCommit);

  const result = await runAgent({
    stage: 'review',
    state,
    maxTurns: 20,
    system: `You are a strict code reviewer. Judge the diff against the approved plan and the acceptance criteria.
Look for: unmet acceptance criteria, bugs and edge cases, missing or weak tests, deviation from the plan, security issues, and violations of the project conventions.
Severity: "blocker" = must fix (wrong behaviour, criterion unmet, security), "major" = should fix before merge, "minor" = nice to have.
You may read files for context. Do not nitpick formatting.

${repoBrief(config)}`,
    prompt: `${taskBrief(state.data.issue)}

Acceptance criteria:
${(state.data.readiness?.acceptance_criteria ?? []).map((c) => `- ${c}`).join('\n')}

Approved plan:
${JSON.stringify(state.data.plan, null, 2)}

Diff:
\`\`\`diff
${changes.diff.slice(0, 60000)}
\`\`\`

Review it and call submit_review.`,
    tools: [
      ...buildTools({ root: wt, config, state, mode: 'read' }),
      submitTool('submit_review', 'Submit the review.', {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['approve', 'changes_requested'] },
          criteria_check: {
            type: 'array',
            items: { type: 'object', properties: { criterion: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['criterion', 'met'] },
          },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: 'string' }, message: { type: 'string' } },
              required: ['severity', 'message'],
            },
          },
        },
        required: ['verdict', 'criteria_check', 'findings'],
      }),
    ],
  });

  state.data.reviews = [...(state.data.reviews ?? []), result];
  state.writeArtifact('review.json', result);

  const mustFix = result.findings.filter((f) => f.severity !== 'minor');
  result.findings.forEach((f) => log[f.severity === 'minor' ? 'info' : 'warn'](`[${f.severity}] ${f.file ?? ''} ${f.message}`));

  if (mustFix.length === 0 && result.verdict === 'approve') {
    log.ok('Reviewer approved');
    return 'guardrails';
  }

  state.data.counters.reviewRounds += 1;
  if (state.data.counters.reviewRounds > config.agent.max_review_rounds) {
    log.warn(`Review still has ${mustFix.length} open findings after ${config.agent.max_review_rounds} rounds.`);
    if (!(await confirm('Continue to guardrails anyway (you will see the findings at final approval)?'))) return null;
    state.audit({ type: 'override', stage: 'review' });
    return 'guardrails';
  }
  state.data.pendingFixes = mustFix.map((f) => ({ source: `review/${f.severity}`, message: `${f.file ?? ''} ${f.message}`.trim() }));
  log.info(`Sending ${mustFix.length} findings back to the coder (round ${state.data.counters.reviewRounds})`);
  return 'implement';
}
