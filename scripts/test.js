// Explicit file arguments work on Node 20+ and Windows without shell glob expansion.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const dir = new URL('../test/', import.meta.url);
const files = readdirSync(dir).filter(name => name.endsWith('.test.js')).sort().map(name => fileURLToPath(new URL(name, dir)));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
