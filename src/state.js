import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Persistent run state, so a run can pause at an approval gate (or crash)
 * and resume later. Lives in <repo>/.agent/runs/<TASK>/.
 */
export class RunState {
  constructor(repo, taskId, { fresh = false } = {}) {
    this.dir = path.join(repo, '.agent', 'runs', taskId);
    this.file = path.join(this.dir, 'state.json');
    if (fresh && fs.existsSync(this.dir)) fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : {
          taskId,
          runId: crypto.randomUUID(),
          stage: 'intake',
          createdAt: new Date().toISOString(),
          history: [],
          approvals: [],
          usage: { input_tokens: 0, output_tokens: 0 },
          counters: { reviewRounds: 0, guardrailFixes: 0 },
          feedback: [],
        };
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  transition(next) {
    this.data.history.push({ from: this.data.stage, to: next, at: new Date().toISOString() });
    this.data.stage = next;
    this.save();
  }

  /** Append-only log of every tool call and decision. */
  audit(event) {
    fs.appendFileSync(path.join(this.dir, 'audit.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  }

  writeArtifact(name, content) {
    const file = path.join(this.dir, name);
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    return file;
  }

  addUsage(usage = {}) {
    this.data.usage.input_tokens += usage.input_tokens ?? 0;
    this.data.usage.output_tokens += usage.output_tokens ?? 0;
  }

  totalTokens() {
    return this.data.usage.input_tokens + this.data.usage.output_tokens;
  }
}

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
