#!/usr/bin/env node
import './env.js';
import { runTask, status } from './orchestrator.js';
import { checkLlmConfig, PROVIDER, MODEL } from './llm.js';
import { log } from './log.js';

const USAGE = `Usage:
  npm run agent -- run <TASK-ID> --repo <path> [--fresh] [--push]
  npm run agent -- resume <TASK-ID> --repo <path> [--push]
  npm run agent -- status <TASK-ID> --repo <path>`;

const args = process.argv.slice(2);
const [command, taskId] = args;
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!command || !taskId || !option('repo')) {
  console.log(USAGE);
  process.exit(1);
}

if (command !== 'status') {
  const problem = checkLlmConfig();
  if (problem) {
    log.fail(`${problem} Copy .env.example to .env and fill in your LLM settings.`);
    process.exit(1);
  }
  log.info(`LLM: ${PROVIDER} / ${MODEL}`);
}

try {
  if (command === 'status') {
    const s = status({ repo: option('repo'), taskId });
    console.log(JSON.stringify({ stage: s.stage, blocked: s.blocked, branch: s.branch, evidence: s.evidenceDir, commit: s.commit, usage: s.usage }, null, 2));
  } else if (command === 'run' || command === 'resume') {
    await runTask({ repo: option('repo'), taskId, fresh: command === 'run' && flag('fresh'), push: flag('push') });
  } else {
    console.log(USAGE);
    process.exit(1);
  }
} catch (err) {
  log.fail(err.message);
  process.exit(1);
}
