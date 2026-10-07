'use strict';

// Готовит демо на вымышленных данных: список команды из примера и отчёты за последние недели.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const team = path.join(root, 'config', 'team.json');
if (!fs.existsSync(team)) {
  fs.copyFileSync(path.join(root, 'config', 'team.example.json'), team);
  console.log('Создан config/team.json из примера (вымышленные адреса @example.com).');
}
const reports = path.join(process.env.DATA_DIR || path.join(root, 'data'), 'reports.json');
if (!fs.existsSync(reports)) require('./seed');
