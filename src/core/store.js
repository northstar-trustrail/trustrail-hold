import fs from 'node:fs';
import path from 'node:path';

// One server process per store. Atomic replacement and fsync prevent partial snapshots.
export class FileStore {
  constructor(file) {
    this.file = path.resolve(file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.lock = `${this.file}.lock`;
    if (fs.existsSync(this.lock)) {
      const pid = Number(fs.readFileSync(this.lock, 'utf8'));
      try { process.kill(pid, 0); throw new Error('store already in use'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; fs.unlinkSync(this.lock); }
    }
    fs.writeFileSync(this.lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  load() {
    if (!fs.existsSync(this.file)) return null;
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (data.version !== 1) throw new Error('unsupported store version');
    return data;
  }
  save(data) {
    const fd = fs.openSync(`${this.file}.tmp`, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ ...data, version: 1 })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  close() { fs.unlinkSync(this.lock); }
}
