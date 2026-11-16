import { runAgent, submitTool } from '../llm.js';
import { taskBrief } from '../playbooks.js';
import { log } from '../log.js';
import { confirm } from '../approval.js';

/** Stops vague tickets before any code is written. */
export async function readiness(ctx) {
  const { state, jira, config } = ctx;
  const issue = state.data.issue;

  const result = await runAgent({
    stage: 'readiness',
    state,
    maxTurns: 5,
    system: `You are a senior engineer triaging Jira tickets before an AI coding agent works on them.
A ticket is READY when a developer could implement it without guessing: the expected behaviour is specific and there are testable acceptance criteria (explicit or clearly implied).
Be strict about vague words like "better", "faster", "improve" without a measurable target. Do not invent requirements.`,
    prompt: `${taskBrief(issue)}\n\nDecide whether this ticket is ready. Call submit_readiness.`,
    tools: [
      submitTool('submit_readiness', 'Submit the readiness verdict.', {
        type: 'object',
        properties: {
          ready: { type: 'boolean' },
          acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'The criteria as you understand them' },
          questions: { type: 'array', items: { type: 'string' }, description: 'Clarifying questions if not ready' },
        },
        required: ['ready', 'acceptance_criteria', 'questions'],
      }),
    ],
  });

  state.data.readiness = result;
  state.writeArtifact('readiness.json', result);

  if (result.ready) {
    log.ok(`Ticket is ready (${result.acceptance_criteria.length} acceptance criteria)`);
    return 'plan';
  }

  log.warn('The agent thinks this ticket is not ready:');
  result.questions.forEach((q) => console.log(`   • ${q}`));
  if (await confirm('Proceed anyway?')) {
    state.audit({ type: 'override', stage: 'readiness' });
    return 'plan';
  }
  const comment = `The AI dev agent could not start on this ticket yet. Please clarify:\n\n${result.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;
  await jira.addComment(issue.key, comment);
  log.info(`Posted clarifying questions to ${issue.key} (${jira.mode}). Re-run with --fresh after the ticket is updated.`);
  state.data.blocked = 'readiness';
  return null;
}
