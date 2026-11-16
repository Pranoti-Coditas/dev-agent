/**
 * Type-specific guidance. The router picks a playbook from the Jira issue
 * type; the stages inject the matching text into their prompts.
 */
export const PLAYBOOKS = {
  bug: {
    plan: `This is a BUG. Plan in this order:
1. Locate the code path from the reproduction steps and identify the root cause (not just the symptom).
2. Plan a regression test that FAILS on the current code and will pass after the fix.
3. Plan the smallest fix that addresses the root cause.
4. List any other callers that rely on the buggy behaviour.`,
    implement: `Work test-first: write the regression test, run it and confirm it FAILS, then fix the code and confirm it PASSES. Mention both results in your submission.`,
  },
  enhancement: {
    plan: `This is an ENHANCEMENT to existing behaviour. Plan in this order:
1. Find every place that uses the code you will change (search for callers, imports, API consumers).
2. Keep backward compatibility unless the ticket says otherwise; call out any breaking change as a risk.
3. Plan tests for the new behaviour and for the existing behaviour that must not change.`,
    implement: `Change only what the plan lists. Keep existing tests passing; extend them rather than rewriting them.`,
  },
  story: {
    plan: `This is a USER STORY that may span backend and frontend. Plan in this order:
1. Describe the design: data model changes, API contract changes (method, path, request, response, errors) and UI changes.
2. Order the work so the backend contract lands before the frontend that uses it.
3. Map every acceptance criterion to at least one test.
4. If the story is too large for one change (more than ~10 files), say so in risks and propose a split.`,
    implement: `Implement backend changes first and run their tests, then the frontend. Make sure each acceptance criterion has a test.`,
  },
};

export function taskBrief(issue) {
  return `Jira task ${issue.key} (${issue.rawType} → ${issue.type} playbook, priority ${issue.priority})
Summary: ${issue.summary}

Description:
${issue.description || '(empty)'}`;
}

export function repoBrief(config) {
  const ws = config.workspaces
    .map((w) => `- ${w.name}: path "${w.path}", stack ${w.preset ?? 'custom'}, checks: ${Object.keys(w.checks ?? {}).join(', ') || 'none'}`)
    .join('\n');
  return `Workspaces in this repository:\n${ws}\n\nProject conventions:\n${config.conventionsText || '(none provided)'}`;
}
