'use strict';

const { getCounters, saveCounters } = require('./storage');
const {
  counterKey,
  getPeriodKey,
  formatNumber,
  parseCounterFromNumber,
  normalizeStructuralValue,
  structuralMatch,
} = require('./numbering');
const { structuralKeyFromConfig } = require('./department-config');

function getFieldValue(item, fieldCode) {
  if (!fieldCode) return null;
  return item[fieldCode] ?? item[fieldCode.toLowerCase()] ?? null;
}

function getStoredCounter(entityTypeId, rule, unitKey) {
  const counters = getCounters();
  const key = counterKey(entityTypeId, rule.id, unitKey, rule.counterReset || 'year');
  return { key, value: counters[key] ?? null };
}

function resetStoredCounter(entityTypeId, rule, unitKey, startFrom) {
  const counters = getCounters();
  const key = counterKey(entityTypeId, rule.id, unitKey, rule.counterReset || 'year');
  const base = Math.max(1, parseInt(startFrom, 10) || rule.startFrom || 1);
  counters[key] = base - 1;
  saveCounters(counters);
  return { key, value: counters[key], nextNumber: base };
}

function setStoredCounter(entityTypeId, rule, unitKey, counterValue) {
  const counters = getCounters();
  const key = counterKey(entityTypeId, rule.id, unitKey, rule.counterReset || 'year');
  counters[key] = counterValue;
  saveCounters(counters);
  return { key, value: counterValue };
}

async function searchAllItems(api, entityTypeId, filter = {}, pageSize = 200) {
  const all = [];
  let start = 0;

  while (start <= 10000) {
    const result = await api.searchItems(entityTypeId, filter, { limit: pageSize, start });
    const items = result.items || result || [];
    if (!items.length) break;
    all.push(...items);
    if (items.length < pageSize) break;
    start += pageSize;
  }

  return all;
}

function structuralValueMatches(itemValue, expected) {
  const val = normalizeStructuralValue(itemValue);
  const exp = normalizeStructuralValue(expected);
  if (!exp) return true;
  return structuralMatch(exp, val) || structuralMatch(val, exp);
}

async function collectUsedCounters(api, entityTypeId, processConfig, rule, unitKey, structuralValue, options = {}) {
  const { excludeItemId } = options;
  const fields = processConfig.fields || {};
  const numberField = fields.numberField;
  const departmentField = fields.departmentField;
  if (!numberField) return [];

  const items = await searchAllItems(api, entityTypeId);
  const used = new Set();

  for (const item of items) {
    if (excludeItemId != null && String(item.id) === String(excludeItemId)) continue;

    if (departmentField && structuralValue) {
      const itemDept = getFieldValue(item, departmentField);
      if (!structuralValueMatches(itemDept, structuralValue)) continue;
    }

    const numberRaw = getFieldValue(item, numberField);
    const numberStr = normalizeStructuralValue(numberRaw);
    if (!numberStr) continue;

    const parsed = parseCounterFromNumber(numberStr, rule, unitKey);
    if (parsed != null) used.add(parsed);
  }

  return [...used].sort((a, b) => a - b);
}

function findFirstAvailableCounter(usedCounters, startFrom) {
  const start = Math.max(1, parseInt(startFrom, 10) || 1);
  const used = new Set(
    (usedCounters || []).filter((n) => Number.isFinite(n) && n >= start).map((n) => Number(n)),
  );

  let candidate = start;
  while (used.has(candidate)) candidate += 1;
  return candidate;
}

function findGaps(usedCounters, startFrom) {
  const start = Math.max(1, parseInt(startFrom, 10) || 1);
  const used = [...new Set((usedCounters || []).filter((n) => n >= start))].sort((a, b) => a - b);
  if (!used.length) return [];

  const gaps = [];
  let expected = start;
  for (const n of used) {
    while (expected < n) {
      gaps.push(expected);
      expected += 1;
    }
    expected = n + 1;
  }
  return gaps;
}

async function assignNextCounter(api, entityTypeId, processConfig, rule, unitKey, structuralValue, options = {}) {
  const startFrom = rule.startFrom || 1;
  const fillGaps = rule.fillGaps !== false;
  const { excludeItemId, dryRun = false } = options;
  const counters = getCounters();
  const key = counterKey(entityTypeId, rule.id, unitKey, rule.counterReset || 'year');
  const stored = counters[key] ?? startFrom - 1;

  let usedCounters = [];
  if (fillGaps && api) {
    usedCounters = await collectUsedCounters(
      api,
      entityTypeId,
      processConfig,
      rule,
      unitKey,
      structuralValue,
      { excludeItemId },
    );
  }

  let next;
  let gapFilled = false;

  if (fillGaps && usedCounters.length) {
    const gapCandidate = findFirstAvailableCounter(usedCounters, startFrom);
    const sequentialCandidate = Math.max(stored, startFrom - 1) + 1;
    next = Math.min(gapCandidate, sequentialCandidate);
    if (gapCandidate < sequentialCandidate) gapFilled = true;
  } else {
    next = Math.max(stored, startFrom - 1) + 1;
  }

  if (!dryRun) {
    counters[key] = Math.max(stored, next);
    saveCounters(counters);
  }

  return {
    counter: next,
    counterKey: key,
    storedBefore: stored,
    storedAfter: dryRun ? stored : Math.max(stored, next),
    gapFilled,
    usedCounters,
    gaps: fillGaps ? findGaps(usedCounters, startFrom) : [],
    nextFormatted: formatNumber(rule, next, unitKey),
  };
}

async function syncCounterFromPortal(api, entityTypeId, processConfig, deptConfig, structuralValue) {
  const rule = deptConfig.numbering;
  const unitKey = structuralKeyFromConfig(deptConfig);
  const startFrom = rule.startFrom || 1;
  const usedCounters = await collectUsedCounters(
    api,
    entityTypeId,
    processConfig,
    rule,
    unitKey,
    structuralValue,
  );

  const maxUsed = usedCounters.length ? Math.max(...usedCounters) : startFrom - 1;
  const { key, value } = setStoredCounter(entityTypeId, rule, unitKey, Math.max(maxUsed, startFrom - 1));

  return {
    key,
    value,
    maxUsed,
    usedCount: usedCounters.length,
    gaps: findGaps(usedCounters, startFrom),
    nextWithGaps: findFirstAvailableCounter(usedCounters, startFrom),
    nextFormatted: formatNumber(rule, findFirstAvailableCounter(usedCounters, startFrom), unitKey),
  };
}

function listCounterEntries(entityTypeId, ruleId, unitKey, counterReset) {
  const counters = getCounters();
  const period = getPeriodKey(counterReset || 'year');
  const prefix = `${entityTypeId}:${ruleId}:${unitKey}:`;
  return Object.entries(counters)
    .filter(([key]) => key.startsWith(prefix) && key.endsWith(`:${period}`))
    .map(([key, value]) => ({ key, value, next: value + 1 }));
}

module.exports = {
  getStoredCounter,
  resetStoredCounter,
  setStoredCounter,
  collectUsedCounters,
  findFirstAvailableCounter,
  findGaps,
  assignNextCounter,
  syncCounterFromPortal,
  listCounterEntries,
  structuralKeyFromConfig,
};
