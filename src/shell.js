import { spawn, spawnSync } from 'node:child_process';

/** Runs a shell command and captures output. Never throws on non-zero exit. */
export function run(command, { cwd, env = {}, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ command, code: code ?? 1, ok: code === 0, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}

/** Like run() but throws when the command fails. For git plumbing. */
export async function mustRun(command, opts) {
  const res = await run(command, opts);
  if (!res.ok) throw new Error(`Command failed (${res.code}): ${command}\n${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

/** Starts a long-running process (dev server) in its own process group. */
export function startBackground(command, { cwd, env = {} } = {}) {
  const child = spawn(command, { cwd, shell: true, detached: true, env: { ...process.env, ...env } });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  return {
    child,
    output: () => output,
    stop: () => {
      try {
        if (process.platform === 'win32') {
          // Negative-PID group kill doesn't exist on Windows; kill the whole tree (cmd -> npx -> node).
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          process.kill(-child.pid, 'SIGTERM');
        }
      } catch {
        /* already exited */
      }
    },
  };
}

export async function waitForUrl(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export const tail = (text, lines = 60) => text.split('\n').slice(-lines).join('\n');
