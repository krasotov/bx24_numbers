'use strict';

const { getCounters, saveCounters } = require('./storage');

function padCounter(value, width) {
  const str = String(value);
  if (!width || width <= 0) return str;
  return str.padStart(width, '0');
}

function getPeriodKey(resetPeriod) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  if (resetPeriod === 'year') return `${year}`;
  if (resetPeriod === 'month') return `${year}-${month}`;
  return 'all';
}

function counterKey(entityTypeId, ruleId, unitKey, resetPeriod) {
  const period = getPeriodKey(resetPeriod);
  return `${entityTypeId}:${ruleId}:${unitKey}:${period}`;
}

function nextCounter(entityTypeId, rule, unitKey) {
  const counters = getCounters();
  const key = counterKey(entityTypeId, rule.id, unitKey, rule.counterReset || 'year');
  const current = counters[key] ?? (rule.startFrom || 1) - 1;
  const next = current + 1;
  counters[key] = next;
  saveCounters(counters);
  return next;
}

function formatNumber(rule, counter, unitKey) {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  const template = rule.format || '{prefix}-{year}-{counter:4}';
  const widthMatch = template.match(/\{counter:(\d+)\}/);
  const counterWidth = widthMatch ? parseInt(widthMatch[1], 10) : 0;
  const counterStr = padCounter(counter, counterWidth);

  return template
    .replace(/\{prefix\}/g, rule.prefix || '')
    .replace(/\{suffix\}/g, rule.suffix || '')
    .replace(/\{year\}/g, year)
    .replace(/\{month\}/g, month)
    .replace(/\{day\}/g, day)
    .replace(/\{counter(?::\d+)?\}/g, counterStr)
    .replace(/\{department\}/g, unitKey || '');
}

function normalizeStructuralValue(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'object') {
    return normalizeStructuralValue(value.value ?? value.id ?? value.name ?? value.title);
  }
  if (Array.isArray(value)) return normalizeStructuralValue(value[0]);
  return String(value).trim();
}

function isEmptyStructural(value) {
  return !normalizeStructuralValue(value);
}

function structuralMatch(ruleKey, itemValue) {
  const key = normalizeStructuralValue(ruleKey).toLowerCase();
  const val = normalizeStructuralValue(itemValue).toLowerCase();
  if (!key || key === '*') return true;
  return key === val;
}

function resolveDepartmentMapping(processConfig, bitrixDepartmentId) {
  const mappings = processConfig.departmentMappings || [];
  const exact = mappings.find((m) => String(m.bitrixDepartmentId) === String(bitrixDepartmentId));
  if (exact) return exact;
  return mappings.find((m) => m.bitrixDepartmentId === '*') || null;
}

function ruleStructuralKey(rule, processConfig) {
  if (rule.structuralUnit) return normalizeStructuralValue(rule.structuralUnit);
  if (rule.structuralUnitValue) return normalizeStructuralValue(rule.structuralUnitValue);

  if (rule.departmentId && rule.departmentId !== '*') {
    const mapping = resolveDepartmentMapping(processConfig, rule.departmentId);
    const fromMapping = mapping?.structuralUnitValue || mapping?.structuralUnitName;
    if (fromMapping) return normalizeStructuralValue(fromMapping);
    return String(rule.departmentId);
  }
  return '*';
}

function findRule(processConfig, structuralValue) {
  const rules = (processConfig.numberingRules || []).filter((r) => r.enabled !== false);
  const val = normalizeStructuralValue(structuralValue);

  const exact = rules.find((r) => {
    const key = ruleStructuralKey(r, processConfig);
    return key !== '*' && structuralMatch(key, val);
  });
  if (exact) return exact;

  return rules.find((r) => {
    const key = ruleStructuralKey(r, processConfig);
    return key === '*' || (!r.structuralUnit && (r.departmentId === '*' || r.departmentId == null || r.departmentId === ''));
  });
}

function buildDepartmentFieldValue(mapping, departmentName, fieldType) {
  if (!mapping && !departmentName) return null;
  const name = mapping?.structuralUnitName || departmentName;
  const value = mapping?.structuralUnitValue || mapping?.listValue || name;
  if (!value) return null;
  if (fieldType === 'list') return mapping?.listValue ?? value;
  if (fieldType === 'department') return mapping?.bitrixDepartmentId ?? null;
  return value;
}

module.exports = {
  nextCounter,
  formatNumber,
  findRule,
  ruleStructuralKey,
  resolveDepartmentMapping,
  buildDepartmentFieldValue,
  normalizeStructuralValue,
  isEmptyStructural,
  structuralMatch,
  counterKey,
  getPeriodKey,
};
