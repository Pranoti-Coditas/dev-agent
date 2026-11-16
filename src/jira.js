import fs from 'node:fs';
import path from 'node:path';

/** Flattens Atlassian Document Format (Jira Cloud descriptions) to plain text. */
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  const inner = (node.content ?? []).map(adfToText).join('');
  return ['paragraph', 'heading', 'listItem', 'codeBlock'].includes(node.type) ? `${inner}\n` : inner;
}

const textToAdf = (text) => ({
  type: 'doc',
  version: 1,
  content: text.split('\n\n').map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
});

function normalize(raw, typeMap) {
  const f = raw.fields ?? {};
  const rawType = (f.issuetype?.name ?? 'task').toLowerCase();
  return {
    key: raw.key,
    rawType,
    type: typeMap[rawType] ?? 'enhancement',
    summary: f.summary ?? '',
    description: adfToText(f.description).trim(),
    priority: f.priority?.name ?? 'Medium',
    labels: f.labels ?? [],
  };
}

export function createJiraClient(repo, config) {
  const typeMap = config.jira.type_map;

  if (process.env.JIRA_BASE_URL) {
    const base = process.env.JIRA_BASE_URL.replace(/\/$/, '');
    const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
    const headers = { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' };
    return {
      mode: 'jira',
      async getIssue(key) {
        const res = await fetch(`${base}/rest/api/3/issue/${key}?fields=summary,description,issuetype,priority,labels`, { headers });
        if (!res.ok) throw new Error(`Jira returned ${res.status} for ${key}: ${await res.text()}`);
        return normalize(await res.json(), typeMap);
      },
      async addComment(key, text) {
        const res = await fetch(`${base}/rest/api/3/issue/${key}/comment`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ body: textToAdf(text) }),
        });
        if (!res.ok) throw new Error(`Jira comment failed (${res.status}): ${await res.text()}`);
      },
    };
  }

  const dir = path.join(repo, config.jira.mock_dir);
  return {
    mode: 'mock',
    async getIssue(key) {
      const file = path.join(dir, `${key}.json`);
      if (!fs.existsSync(file)) throw new Error(`Mock ticket not found: ${file}`);
      return normalize(JSON.parse(fs.readFileSync(file, 'utf8')), typeMap);
    },
    async addComment(key, text) {
      const file = path.join(dir, `${key}.comments.md`);
      fs.appendFileSync(file, `\n---\n**jira-dev-agent** · ${new Date().toISOString()}\n\n${text}\n`);
    },
  };
}
