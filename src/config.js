import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { PRESETS, detectPreset } from './presets.js';

const DEFAULTS = {
  project: { base_branch: 'main' },
  jira: { mock_dir: '.agent/mock-jira', type_map: { bug: 'bug', story: 'story', improvement: 'enhancement', task: 'enhancement' } },
  guardrails: {
    protected_paths: ['.env*', '.agent/**', '.github/**'],
    always_allowed: ['**/tests/**', '**/*.test.*', '**/*.spec.*'],
    max_files_changed: 15,
    max_lines_changed: 800,
    forbidden_patterns: [],
    dependency_audit: 'warn',
  },
  agent: { max_turns_per_stage: 40, max_review_rounds: 2, max_guardrail_fixes: 2, max_tokens_per_run: 1500000 },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

export function loadConfig(repo) {
  const file = path.join(repo, '.agent', 'config.yaml');
  if (!fs.existsSync(file)) throw new Error(`No agent config at ${file}. Create .agent/config.yaml first.`);
  const raw = yaml.load(fs.readFileSync(file, 'utf8')) ?? {};
  const config = merge(DEFAULTS, raw);

  config.workspaces = (raw.workspaces ?? [{ name: 'root', path: '.' }]).map((ws) => {
    let preset = ws.extends;
    if (!preset) {
      const dir = path.join(repo, ws.path);
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const pkgFile = path.join(dir, 'package.json');
      preset = detectPreset(files, fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, 'utf8')) : null);
    }
    if (preset && !PRESETS[preset]) throw new Error(`Unknown preset "${preset}" in workspace ${ws.name}`);
    return merge(PRESETS[preset] ?? {}, { ...ws, preset });
  });

  const convFile = config.conventions && path.join(repo, config.conventions);
  config.conventionsText = convFile && fs.existsSync(convFile) ? fs.readFileSync(convFile, 'utf8') : '';
  return config;
}

/** Which workspaces does a set of changed files touch? */
export function affectedWorkspaces(config, files) {
  return config.workspaces.filter((ws) => {
    const prefix = ws.path === '.' ? '' : `${ws.path.replace(/\/$/, '')}/`;
    return files.some((f) => f.startsWith(prefix));
  });
}
