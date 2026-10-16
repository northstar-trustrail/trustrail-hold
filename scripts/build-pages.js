// Static build for GitHub Pages: web/ + src/core, src/paypal, src/ai. Runs fully in-browser (mock PayPal).
import fs from 'node:fs'; import path from 'node:path';
const out = 'dist'; fs.rmSync(out, { recursive: true, force: true });
fs.cpSync('web', out, { recursive: true });
for (const d of ['core', 'paypal', 'ai']) fs.cpSync(`src/${d}`, `${out}/src/${d}`, { recursive: true });
fs.mkdirSync(`${out}/eval`); fs.copyFileSync('eval/cases.json', `${out}/eval/cases.json`);
fs.writeFileSync(`${out}/.nojekyll`, '');
console.log('built', out);
