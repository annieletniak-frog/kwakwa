'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Хранилище в JSON-файле: данные держим в памяти, на диск пишем атомарно
// (временный файл + rename), раз в сутки откладываем резервную копию.
class JsonStore {
  constructor(file, initial) {
    this.file = file;
    this.backupDir = path.join(path.dirname(file), 'backups');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      this.data = initial;
      this.save();
    }
  }

  save() {
    this.backupOncePerDay();
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  backupOncePerDay() {
    if (!fs.existsSync(this.file)) return;
    const day = new Date().toISOString().slice(0, 10);
    const name = `${path.basename(this.file, '.json')}-${day}.json`;
    const target = path.join(this.backupDir, name);
    if (fs.existsSync(target)) return;
    fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(this.file, target);
  }
}

module.exports = { JsonStore };
