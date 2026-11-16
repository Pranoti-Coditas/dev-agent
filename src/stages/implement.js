import { runAgent, submitTool } from '../llm.js';
import { buildTools } from '../tools.js';
import { PLAYBOOKS, taskBrief, repoBrief } from '../playbooks.js';
import { installDependencies, getChanges } from '../workspace.js';
import { log } from '../log.js';

/** Collects everything the coder must fix on this pass: review findings, guardrail failures, human feedback. */
function fixList(state) {
  const items = [];
  for (const f of state.data.pendingFixes ?? []) items.push(`- [${f.source}] ${f.message}`);
  return items.length ? `\nYou are revising your previous attempt. Fix these before anything else:\n${items.join('\n')}\n` : '';
}

export async function implement(ctx) {
  const { state, config } = ctx;
  const issue = state.data.issue;
  const wt = state.data.worktree;
  await installDependencies(wt, config, state);

  const changed = new Set(state.data.changedByAgent ?? []);
  const result = await runAgent({
    stage: 'implement',
    state,
    maxTurns: config.agent.max_turns_per_stage,
    system: `You are a careful software engineer implementing an APPROVED plan in a git worktree.
Rules:
- Follow the plan. Do not touch files outside it, except tests. If the plan is wrong, say so in your submission instead of improvising.
- Read a file before editing it. Prefer edit_file for small changes.
- After changing code, run the relevant checks with run_check and fix failures. Do not submit while checks fail.
- Never weaken or delete existing tests to make them pass.
- No secrets, no debug leftovers (console.log for debugging, debugger, .only).
${PLAYBOOKS[issue.type]?.implement ?? ''}

${repoBrief(config)}`,
    prompt: `${taskBrief(issue)}

Approved plan:
${JSON.stringify(state.data.plan, null, 2)}
${fixList(state)}
Implement it now, run the checks, then call submit_implementation.`,
    tools: [
      ...buildTools({ root: wt, config, state, mode: 'write', changed }),
      submitTool('submit_implementation', 'Submit when the change is complete and checks pass.', {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          tests_added: { type: 'array', items: { type: 'string' } },
          checks_run: { type: 'array', items: { type: 'string' }, description: 'e.g. "api:test PASSED"' },
          deviations_from_plan: { type: 'array', items: { type: 'string' } },
          red_green: { type: 'string', description: 'Bugs: evidence the new test failed before the fix and passes after' },
        },
        required: ['summary', 'tests_added', 'checks_run', 'deviations_from_plan'],
      }),
    ],
  });

  state.data.changedByAgent = [...changed];
  state.data.implementation = result;
  state.data.pendingFixes = [];
  const changes = await getChanges(wt, state.data.baseCommit);
  state.writeArtifact('implementation.json', result);
  state.writeArtifact('diff.patch', changes.diff);
  log.ok(`Implementation submitted: ${changes.files.length} files, ${changes.linesChanged} lines changed`);
  return 'review';
}
