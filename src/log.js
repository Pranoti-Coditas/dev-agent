const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const color = { bold: c(1), dim: c(2), red: c(31), green: c(32), yellow: c(33), blue: c(34), cyan: c(36) };

export const log = {
  stage: (name) => console.log(`\n${color.bold(color.blue(`━━ ${name.toUpperCase()} ━━`))}`),
  info: (msg) => console.log(`${color.cyan('›')} ${msg}`),
  ok: (msg) => console.log(`${color.green('✔')} ${msg}`),
  warn: (msg) => console.log(`${color.yellow('!')} ${msg}`),
  fail: (msg) => console.log(`${color.red('✖')} ${msg}`),
  tool: (name, detail) => console.log(color.dim(`   ↳ ${name} ${detail ?? ''}`)),
};
