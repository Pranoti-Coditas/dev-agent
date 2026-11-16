import fs from 'node:fs';
import path from 'node:path';
import { run, tail } from './shell.js';
import { matchesAny } from './glob.js';

/**
 * Tools the model can call. Read tools are given to every stage; write tools
 * only to the implementation stage. Paths are confined to the worktree and
 * protected paths are blocked here too (defense in depth: the guardrail stage
 * checks again on the final diff).
 */
export function buildTools({ root, config, state, mode = 'read', changed = new Set() }) {
  const resolveSafe = (p) => {
    const rel = path.normalize(p).replace(/^(\.\/)+/, '');
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep) && abs !== root) throw new Error(`Path escapes the repository: ${p}`);
    if (/(^|\/)(\.git|node_modules)(\/|$)/.test(rel)) throw new Error(`Access to ${p} is not allowed`);
    return { abs, rel: path.relative(root, abs).split(path.sep).join('/') };
  };

  const read = [
    {
      name: 'list_files',
      description: 'List files in the repository (respects .gitignore). Optionally filter by directory prefix.',
      input_schema: { type: 'object', properties: { dir: { type: 'string', description: 'Directory prefix, e.g. "web/src"' } } },
      handler: async ({ dir = '' }) => {
        const out = (await run('git ls-files --cached --others --exclude-standard', { cwd: root })).stdout;
        const files = out.split('\n').filter((f) => f && f.startsWith(dir.replace(/^\.\/?/, '')));
        return files.slice(0, 500).join('\n') || '(no files)';
      },
    },
    {
      name: 'read_file',
      description: 'Read a file with line numbers. Use start_line/end_line for big files.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } },
        required: ['path'],
      },
      handler: async ({ path: p, start_line = 1, end_line }) => {
        const { abs } = resolveSafe(p);
        if (!fs.existsSync(abs)) throw new Error(`File not found: ${p}`);
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        const end = Math.min(end_line ?? start_line + 399, lines.length);
        return lines.slice(start_line - 1, end).map((l, i) => `${start_line + i}\t${l}`).join('\n');
      },
    },
    {
      name: 'search_code',
      description: 'Search the repository with a regular expression (git grep). Returns file:line:match.',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' }, dir: { type: 'string' } },
        required: ['pattern'],
      },
      handler: async ({ pattern, dir = '.' }) => {
        const safe = pattern.replace(/'/g, `'\\''`);
        const res = await run(`git grep -n -I -E --untracked '${safe}' -- '${dir}'`, { cwd: root });
        return res.stdout.split('\n').slice(0, 200).join('\n') || '(no matches)';
      },
    },
  ];

  if (mode !== 'write') return read;

  const assertWritable = (rel) => {
    if (matchesAny(rel, config.guardrails.protected_paths)) {
      throw new Error(`${rel} is a protected path. Stop and explain in your submission if the change is truly required.`);
    }
  };

  const write = [
    {
      name: 'write_file',
      description: 'Create or overwrite a file with the full content given.',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      handler: async ({ path: p, content }) => {
        const { abs, rel } = resolveSafe(p);
        assertWritable(rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        changed.add(rel);
        return `Wrote ${rel} (${content.split('\n').length} lines)`;
      },
    },
    {
      name: 'edit_file',
      description: 'Replace one exact, unique occurrence of old_str with new_str in a file. Read the file first.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } },
        required: ['path', 'old_str', 'new_str'],
      },
      handler: async ({ path: p, old_str, new_str }) => {
        const { abs, rel } = resolveSafe(p);
        assertWritable(rel);
        const text = fs.readFileSync(abs, 'utf8');
        const count = text.split(old_str).length - 1;
        if (count !== 1) throw new Error(`old_str must match exactly once in ${rel}; found ${count} matches`);
        fs.writeFileSync(abs, text.replace(old_str, () => new_str));
        changed.add(rel);
        return `Edited ${rel}`;
      },
    },
    {
      name: 'run_check',
      description: 'Run one configured check (for example "test" or "build") in a workspace. Arbitrary shell commands are not allowed.',
      input_schema: {
        type: 'object',
        properties: {
          workspace: { type: 'string', enum: config.workspaces.map((w) => w.name) },
          check: { type: 'string', description: 'Name of a check from the workspace config' },
        },
        required: ['workspace', 'check'],
      },
      handler: async ({ workspace, check }) => {
        const ws = config.workspaces.find((w) => w.name === workspace);
        const cmd = ws?.checks?.[check];
        if (!cmd) throw new Error(`No check "${check}" in workspace ${workspace}. Available: ${Object.keys(ws?.checks ?? {}).join(', ')}`);
        const res = await run(cmd, { cwd: path.join(root, ws.path), env: { CI: 'true' } });
        state.audit({ type: 'check', workspace, check, ok: res.ok });
        return `${res.ok ? 'PASSED' : 'FAILED'} (exit ${res.code}) ${cmd}\n${tail(res.stdout + res.stderr, 80)}`;
      },
    },
  ];

  return [...read, ...write];
}
