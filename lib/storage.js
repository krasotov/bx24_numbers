'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJson(filename, fallback) {
  ensureDir();
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return structuredClone(fallback);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(filename, data) {
  ensureDir();
  const filePath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

const DEFAULT_CONFIG = {
  pollIntervalMinutes: 5,
  pollingEnabled: true,
  fillDepartmentFromUser: true,
  userDepartmentField: 'departmentId',
  departmentNameField: 'name',
  smartProcesses: [],
};

function getConfig() {
  return readJson('config.json', DEFAULT_CONFIG);
}

function saveConfig(config) {
  writeJson('config.json', config);
}

function getCounters() {
  return readJson('counters.json', {});
}

function saveCounters(counters) {
  writeJson('counters.json', counters);
}

function getLogs() {
  return readJson('logs.json', []);
}

function addLog(entry) {
  const logs = getLogs();
  logs.unshift({ ...entry, timestamp: new Date().toISOString() });
  writeJson('logs.json', logs.slice(0, 200));
}

module.exports = {
  DATA_DIR,
  getConfig,
  saveConfig,
  getCounters,
  saveCounters,
  getLogs,
  addLog,
};
