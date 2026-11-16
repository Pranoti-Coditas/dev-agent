import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import os from 'node:os';
import { color } from './log.js';

async function prompt(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Human gate. Returns { decision: 'approve' | 'reject' | 'quit', feedback }.
 * `extras` adds options such as { key: 'd', label: 'show diff', action: fn }.
 */
export async function humanGate(title, { extras = [] } = {}) {
  const opts = [...extras.map((e) => `[${e.key}] ${e.label}`), '[a] approve', '[r] reject with feedback', '[q] pause and quit'];
  while (true) {
    console.log(`\n${color.bold(color.yellow(`⏸  ${title}`))}`);
    const answer = (await prompt(`${opts.join('   ')}\n> `)).toLowerCase();
    const extra = extras.find((e) => e.key === answer);
    if (extra) {
      await extra.action();
      continue;
    }
    if (answer === 'a') return { decision: 'approve', by: os.userInfo().username, at: new Date().toISOString() };
    if (answer === 'q') return { decision: 'quit' };
    if (answer === 'r') {
      const feedback = await prompt('What should change? > ');
      if (feedback) return { decision: 'reject', feedback, by: os.userInfo().username, at: new Date().toISOString() };
    }
  }
}

export async function confirm(question) {
  return (await prompt(`${question} [y/N] > `)).toLowerCase() === 'y';
}
