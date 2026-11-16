/**
 * Stack presets. A workspace in .agent/config.yaml says `extends: <preset>`
 * and overrides only what differs. Add a preset here to support a new stack.
 * Every preset must produce JUnit XML so evidence handling stays stack-agnostic.
 */
export const PRESETS = {
  'node-api': {
    install: 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund',
    checks: { test: 'npm test' },
    reports: { junit: 'reports/junit.xml' },
    audit: 'npm audit --omit=dev --audit-level=high',
    manifest: 'package.json',
  },
  'react-vite': {
    install: 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund',
    checks: { test: 'npm test', build: 'npm run build' },
    reports: { junit: 'reports/junit.xml' },
    audit: 'npm audit --omit=dev --audit-level=high',
    manifest: 'package.json',
  },
  'spring-boot': {
    install: './mvnw -q -DskipTests dependency:go-offline',
    checks: { test: './mvnw -q test', build: './mvnw -q -DskipTests package' },
    reports: { junit: 'target/surefire-reports' },
    manifest: 'pom.xml',
  },
  'python-fastapi': {
    install: 'pip install -r requirements.txt',
    checks: { lint: 'ruff check .', test: 'pytest --junitxml=reports/junit.xml' },
    reports: { junit: 'reports/junit.xml' },
    audit: 'pip-audit',
    manifest: 'requirements.txt',
  },
};

/** Guesses a preset from files in a workspace, used when `extends` is missing. */
export function detectPreset(files, packageJson) {
  if (files.includes('pom.xml')) return 'spring-boot';
  if (files.includes('pyproject.toml') || files.includes('requirements.txt')) return 'python-fastapi';
  if (packageJson) {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    if (deps.react && deps.vite) return 'react-vite';
    return 'node-api';
  }
  return null;
}
