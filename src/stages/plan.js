import { runAgent, submitTool } from '../llm.js';
import { buildTools } from '../tools.js';
import { PLAYBOOKS, taskBrief, repoBrief } from '../playbooks.js';
import { ensureWorktree } from '../workspace.js';
import { humanGate } from '../approval.js';
import { color, log } from '../log.js';
import { sha256 } from '../state.js';

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One paragraph: what will change and why' },
    root_cause: { type: 'string', description: 'Bugs only: the root cause. Otherwise empty.' },
    design: { type: 'string', description: 'Stories: data/API/UI design. Otherwise empty.' },
    files_to_change: {
      type: 'array',
      items: { type: 'object', properties: { path: { type: 'string' }, change: { type: 'string' } }, required: ['path', 'change'] },
    },
    new_files: {
      type: 'array',
      items: { type: 'object', properties: { path: { type: 'string' }, purpose: { type: 'string' } }, required: ['path', 'purpose'] },
    },
    new_dependencies: { type: 'array', items: { type: 'string' }, description: 'npm/pip/maven packages to add, with reason' },
    test_plan: { type: 'array', items: { type: 'string' } },
    api_samples: {
      type: 'array',
      description: 'HTTP requests that demonstrate the change, captured as evidence after implementation',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          workspace: { type: 'string' },
          method: { type: 'string' },
          path: { type: 'string' },
          body: { type: 'object' },
          expect_status: { type: 'integer' },
        },
        required: ['name', 'workspace', 'method', 'path', 'expect_status'],
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    out_of_scope: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'files_to_change', 'new_files', 'test_plan', 'risks'],
};

export async function plan(ctx) {
  const { state, config, repo } = ctx;
  const issue = state.data.issue;
  const wt = await ensureWorktree(repo, issue.key, state);
  const feedback = state.data.feedback.filter((f) => f.stage === 'plan_approval').map((f) => `- ${f.feedback}`).join('\n');

  const result = await runAgent({
    stage: 'plan',
    state,
    maxTurns: config.agent.max_turns_per_stage,
    system: `You are a senior engineer writing an implementation plan for a Jira task. You can read the repository but not change it.
Explore enough code to be specific: name real files and functions. Prefer the smallest change that meets every acceptance criterion.
${PLAYBOOKS[issue.type]?.plan ?? ''}

${repoBrief(config)}`,
    prompt: `${taskBrief(issue)}

Acceptance criteria (from triage):
${(state.data.readiness?.acceptance_criteria ?? []).map((c) => `- ${c}`).join('\n')}
${feedback ? `\nThe reviewer rejected your previous plan. Address this feedback:\n${feedback}\n` : ''}
Explore the repository, then call submit_plan.`,
    tools: [
      ...buildTools({ root: wt, config, state, mode: 'read' }),
      submitTool('submit_plan', 'Submit the implementation plan.', PLAN_SCHEMA, (p) =>
        p.files_to_change.length + p.new_files.length === 0 ? 'The plan must change or add at least one file.' : null
      ),
    ],
  });

  state.data.plan = result;
  state.data.planHash = sha256(JSON.stringify(result));
  state.writeArtifact('plan.json', result);
  log.ok('Plan ready');
  return 'plan_approval';
}

export function printPlan(p) {
  const section = (title, items) => items?.length && console.log(`\n${color.bold(title)}\n${items.map((i) => `  • ${i}`).join('\n')}`);
  console.log(`\n${color.bold('Summary')}\n  ${p.summary}`);
  if (p.root_cause) console.log(`\n${color.bold('Root cause')}\n  ${p.root_cause}`);
  if (p.design) console.log(`\n${color.bold('Design')}\n  ${p.design}`);
  section('Files to change', p.files_to_change.map((f) => `${f.path} — ${f.change}`));
  section('New files', p.new_files.map((f) => `${f.path} — ${f.purpose}`));
  section('New dependencies', p.new_dependencies);
  section('Test plan', p.test_plan);
  section('Evidence requests', p.api_samples?.map((s) => `${s.method} ${s.path} → expect ${s.expect_status}`));
  section('Risks', p.risks);
  section('Out of scope', p.out_of_scope);
}

export async function planApproval(ctx) {
  const { state } = ctx;
  printPlan(state.data.plan);
  const gate = await humanGate(`Approve the plan for ${state.data.issue.key}?`);
  state.audit({ type: 'gate', stage: 'plan_approval', ...gate });

  if (gate.decision === 'quit') return null;
  if (gate.decision === 'reject') {
    state.data.feedback.push({ stage: 'plan_approval', feedback: gate.feedback, at: gate.at });
    return 'plan';
  }
  state.data.approvals.push({ gate: 'plan', by: gate.by, at: gate.at, planHash: state.data.planHash });
  return 'implement';
}
