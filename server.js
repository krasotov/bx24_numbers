'use strict';

const express = require('express');
const path = require('path');
const { getConfig, saveConfig, getLogs, getCounters, addLog } = require('./lib/storage');
const { processByConfig, pollUnnumbered } = require('./lib/processor');
const { migrateProcessConfig, structuralKeyFromConfig } = require('./lib/department-config');
const { normalizeFields, suggestProcessFields } = require('./lib/fields');
const { parseWebhookPayload } = require('./lib/webhook-parse');
const { VibeApi } = require('./lib/vibe-api');
const {
  resetStoredCounter,
  syncCounterFromPortal,
  getStoredCounter,
  assignNextCounter,
} = require('./lib/counter-assign');
const { getPeriodKey } = require('./lib/numbering');

function normalizeConfig(config) {
  if (!config?.smartProcesses) return config;
  for (const proc of config.smartProcesses) {
    migrateProcessConfig(proc);
  }
  return config;
}

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.VIBE_API_KEY || '';

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function getApiKey(req) {
  return API_KEY || req.headers['x-vibe-api-key'] || '';
}

function getSession(req) {
  return req.headers['x-vibe-authorization'] || '';
}

function requireApiKey(req, res, next) {
  if (!getApiKey(req)) {
    return res.status(500).json({ success: false, error: 'VIBE_API_KEY не настроен' });
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'edo-numbering' });
});

app.get('/api/config', (_req, res) => {
  res.json({ success: true, data: normalizeConfig(getConfig()) });
});

app.put('/api/config', (req, res) => {
  const config = req.body;
  if (!config || !Array.isArray(config.smartProcesses)) {
    return res.status(400).json({ success: false, error: 'Некорректная конфигурация' });
  }
  normalizeConfig(config);
  saveConfig(config);
  res.json({ success: true, data: getConfig() });
});

app.get('/api/logs', (_req, res) => {
  res.json({ success: true, data: getLogs() });
});

app.get('/api/counters', (_req, res) => {
  res.json({ success: true, data: getCounters() });
});

function findDeptConfig(processConfig, { ruleId, configId, unitKey }) {
  migrateProcessConfig(processConfig);
  return processConfig.departmentConfigs.find((c) => {
    if (ruleId && c.numbering?.id === ruleId) return true;
    if (configId && c.id === configId) return true;
    if (unitKey) {
      const key = structuralKeyFromConfig(c);
      return key === unitKey;
    }
    return false;
  });
}

app.post('/api/counters/reset', requireApiKey, (req, res) => {
  const { entityTypeId, ruleId, configId, unitKey, startFrom } = req.body || {};
  if (!entityTypeId || (!ruleId && !configId && !unitKey)) {
    return res.status(400).json({ success: false, error: 'Укажите entityTypeId и ruleId (или configId / unitKey)' });
  }

  const config = getConfig();
  const processConfig = config.smartProcesses.find(
    (p) => String(p.entityTypeId) === String(entityTypeId),
  );
  if (!processConfig) {
    return res.status(404).json({ success: false, error: `Смарт-процесс ${entityTypeId} не найден` });
  }

  const deptConfig = findDeptConfig(processConfig, { ruleId, configId, unitKey });
  if (!deptConfig?.numbering) {
    return res.status(404).json({ success: false, error: 'Правило нумерации не найдено' });
  }

  const unit = structuralKeyFromConfig(deptConfig);
  const result = resetStoredCounter(entityTypeId, deptConfig.numbering, unit, startFrom);
  addLog({
    level: 'info',
    action: 'counter_reset',
    entityTypeId,
    processTitle: processConfig.title,
    ruleId: deptConfig.numbering.id,
    unitKey: unit,
    startFrom: startFrom ?? deptConfig.numbering.startFrom,
    counterKey: result.key,
    nextNumber: result.nextNumber,
  });

  res.json({ success: true, data: { ...result, unitKey: unit, structuralUnit: deptConfig.structuralUnitName } });
});

app.post('/api/counters/sync', requireApiKey, async (req, res) => {
  const { entityTypeId, ruleId, configId, unitKey } = req.body || {};
  if (!entityTypeId || (!ruleId && !configId && !unitKey)) {
    return res.status(400).json({ success: false, error: 'Укажите entityTypeId и ruleId (или configId / unitKey)' });
  }

  const config = getConfig();
  const processConfig = config.smartProcesses.find(
    (p) => String(p.entityTypeId) === String(entityTypeId),
  );
  if (!processConfig) {
    return res.status(404).json({ success: false, error: `Смарт-процесс ${entityTypeId} не найден` });
  }

  const deptConfig = findDeptConfig(processConfig, { ruleId, configId, unitKey });
  if (!deptConfig?.numbering) {
    return res.status(404).json({ success: false, error: 'Правило нумерации не найдено' });
  }

  try {
    const api = new VibeApi(getApiKey(req), getSession(req));
    const unit = structuralKeyFromConfig(deptConfig);
    const structuralValue = deptConfig.structuralUnitValue || deptConfig.structuralUnitName || unit;
    const result = await syncCounterFromPortal(api, entityTypeId, processConfig, deptConfig, structuralValue);
    addLog({
      level: 'info',
      action: 'counter_sync',
      entityTypeId,
      processTitle: processConfig.title,
      ruleId: deptConfig.numbering.id,
      unitKey: unit,
      maxUsed: result.maxUsed,
      nextWithGaps: result.nextWithGaps,
      gaps: result.gaps,
    });
    res.json({ success: true, data: { ...result, unitKey: unit } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/counters/status', requireApiKey, async (req, res) => {
  const entityTypeId = req.query.entityTypeId;
  const ruleId = req.query.ruleId;
  const configId = req.query.configId;
  const unitKey = req.query.unitKey;

  if (!entityTypeId || (!ruleId && !configId && !unitKey)) {
    return res.status(400).json({ success: false, error: 'Укажите entityTypeId и ruleId (или configId / unitKey)' });
  }

  const config = getConfig();
  const processConfig = config.smartProcesses.find(
    (p) => String(p.entityTypeId) === String(entityTypeId),
  );
  if (!processConfig) {
    return res.status(404).json({ success: false, error: `Смарт-процесс ${entityTypeId} не найден` });
  }

  const deptConfig = findDeptConfig(processConfig, { ruleId, configId, unitKey });
  if (!deptConfig?.numbering) {
    return res.status(404).json({ success: false, error: 'Правило нумерации не найдено' });
  }

  const unit = structuralKeyFromConfig(deptConfig);
  const rule = deptConfig.numbering;
  const stored = getStoredCounter(entityTypeId, rule, unit);
  const period = getPeriodKey(rule.counterReset || 'year');

  try {
    const api = new VibeApi(getApiKey(req), getSession(req));
    const structuralValue = deptConfig.structuralUnitValue || deptConfig.structuralUnitName || unit;
    const preview = await assignNextCounter(
      api,
      entityTypeId,
      processConfig,
      rule,
      unit,
      structuralValue,
      { excludeItemId: null, dryRun: true },
    );
    res.json({
      success: true,
      data: {
        counterKey: stored.key,
        stored: stored.value,
        nextStored: stored.value == null ? (rule.startFrom || 1) : stored.value + 1,
        period,
        gaps: preview.gaps,
        nextWithGaps: preview.counter,
        nextFormatted: preview.nextFormatted,
        usedCount: preview.usedCounters?.length || 0,
        fillGaps: rule.fillGaps !== false,
      },
    });
  } catch (err) {
    res.json({
      success: true,
      data: {
        counterKey: stored.key,
        stored: stored.value,
        nextStored: stored.value == null ? (rule.startFrom || 1) : stored.value + 1,
        period,
        fillGaps: rule.fillGaps !== false,
        error: err.message,
      },
    });
  }
});

app.get('/api/smart-processes', requireApiKey, async (req, res) => {
  try {
    const api = new VibeApi(getApiKey(req), getSession(req));
    const data = await api.listSmartProcesses();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/departments', requireApiKey, async (req, res) => {
  try {
    const api = new VibeApi(getApiKey(req), getSession(req));
    const data = await api.listDepartments();
    const list = Array.isArray(data) ? data : data.items || [];
    res.json({ success: true, data: list, meta: { total: list.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/fields/:entityTypeId', requireApiKey, async (req, res) => {
  try {
    const api = new VibeApi(getApiKey(req), getSession(req));
    const data = await api.getItemFields(req.params.entityTypeId);
    const fields = normalizeFields(data);
    res.json({ success: true, data: fields, meta: { total: fields.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/process', requireApiKey, async (req, res) => {
  const { entityTypeId, itemId } = req.body || {};
  if (!entityTypeId || !itemId) {
    return res.status(400).json({ success: false, error: 'Укажите entityTypeId и itemId' });
  }
  try {
    const result = await processByConfig(getApiKey(req), entityTypeId, itemId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/poll', requireApiKey, async (req, res) => {
  try {
    const results = await pollUnnumbered(getApiKey(req));
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function resolveEntityTypeId(parsed, config) {
  if (parsed?.entityTypeId) return parsed.entityTypeId;
  const proc = config?.smartProcesses?.find((p) => p.enabled !== false);
  return proc?.entityTypeId || null;
}

async function handleWebhook(req, res) {
  const parsed = parseWebhookPayload(req.body, req.query);
  const config = getConfig();
  const entityTypeId = resolveEntityTypeId(parsed, config);
  const rawItemId = parsed?.itemId ?? req.query?.itemId;
  const itemId = parsed?.itemId ?? (rawItemId != null && /^\d+$/.test(String(rawItemId)) ? parseInt(String(rawItemId), 10) : null);

  addLog({
    level: itemId ? 'info' : 'warn',
    action: 'webhook_received',
    method: req.method,
    entityTypeId,
    itemId,
    rawItemId: rawItemId != null ? String(rawItemId) : null,
    parseSource: parsed?.source,
    publicRequest: req.headers['x-vibe-public'] === 'true',
    query: req.query,
    bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : [],
  });

  if (!itemId) {
    const raw = String(rawItemId || req.query?.itemId || '');
    const hint = raw.includes('{{') || raw.includes('{=')
      ? 'Макрос ID не подставился. Вставьте поле ID через «…» → {=Document:ID}'
      : 'Проверьте URL робота и что сервер в режиме PUBLIC (для внешних webhook).';
    return res.status(400).json({
      success: false,
      error: 'Не удалось определить числовой ID элемента.',
      hint,
      received: { query: req.query, body: req.body },
    });
  }

  if (!entityTypeId) {
    return res.status(400).json({
      success: false,
      error: 'Не удалось определить entityTypeId. Добавьте entityTypeId=1094 в URL робота.',
    });
  }

  try {
    const result = await processByConfig(getApiKey(req), entityTypeId, itemId);
    res.json({ success: true, event: parsed?.event, entityTypeId, itemId, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

app.post('/api/webhook', requireApiKey, handleWebhook);
app.get('/api/webhook', requireApiKey, handleWebhook);

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let pollTimer = null;

function schedulePolling() {
  if (pollTimer) clearInterval(pollTimer);
  const config = getConfig();
  if (!config.pollingEnabled || !API_KEY) return;

  const minutes = config.pollIntervalMinutes || 5;
  pollTimer = setInterval(async () => {
    try {
      await pollUnnumbered(API_KEY);
    } catch (err) {
      console.error('Poll error:', err.message);
    }
  }, minutes * 60 * 1000);
}

app.listen(PORT, () => {
  console.log(`EDO Numbering app listening on port ${PORT}`);
  schedulePolling();
});

process.on('SIGTERM', () => {
  if (pollTimer) clearInterval(pollTimer);
  process.exit(0);
});
