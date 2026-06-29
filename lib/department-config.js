'use strict';

const { normalizeStructuralValue, structuralMatch } = require('./numbering');

function defaultNumbering(overrides = {}) {
  return {
    id: overrides.id || `rule-${Date.now()}`,
    mode: 'auto',
    prefix: '',
    suffix: '',
    format: '{prefix}-{year}-{counter:4}',
    counterReset: 'year',
    startFrom: 1,
    enabled: true,
    ...overrides,
  };
}

function migrateProcessConfig(proc) {
  if (Array.isArray(proc.departmentConfigs) && proc.departmentConfigs.length) {
    return proc;
  }

  const configs = [];
  const mappings = proc.departmentMappings || [];
  const rules = proc.numberingRules || [];

  for (const m of mappings) {
    const rule = rules.find(
      (r) =>
        String(r.departmentId) === String(m.bitrixDepartmentId) ||
        structuralMatch(r.structuralUnit || r.structuralUnitValue, m.structuralUnitName) ||
        structuralMatch(r.structuralUnit, m.structuralUnitValue),
    );
    configs.push({
      id: m.id || `dc-${m.bitrixDepartmentId}-${configs.length}`,
      bitrixDepartmentId: m.bitrixDepartmentId ?? '',
      structuralUnitName: m.structuralUnitName || '',
      structuralUnitValue: m.structuralUnitValue || '',
      listValue: m.listValue || '',
      numbering: defaultNumbering(rule ? { ...rule, id: rule.id } : {}),
    });
  }

  for (const r of rules) {
    const exists = configs.some(
      (c) =>
        String(c.bitrixDepartmentId) === String(r.departmentId) ||
        structuralMatch(c.structuralUnitName, r.structuralUnit) ||
        structuralMatch(c.structuralUnitValue, r.structuralUnit),
    );
    if (!exists) {
      configs.push({
        id: `dc-rule-${r.id || configs.length}`,
        bitrixDepartmentId: r.departmentId && r.departmentId !== '*' ? r.departmentId : '',
        structuralUnitName: r.structuralUnit || r.structuralUnitValue || '',
        structuralUnitValue: r.structuralUnitValue || r.structuralUnit || '',
        listValue: '',
        numbering: defaultNumbering({ ...r, id: r.id }),
      });
    }
  }

  proc.departmentConfigs = configs;
  return proc;
}

function getDepartmentConfigs(processConfig) {
  migrateProcessConfig(processConfig);
  return processConfig.departmentConfigs || [];
}

function findConfigByBitrixDepartment(processConfig, departmentId) {
  if (departmentId == null) return null;
  return getDepartmentConfigs(processConfig).find(
    (c) => c.numbering?.enabled !== false && String(c.bitrixDepartmentId) === String(departmentId),
  );
}

function findConfigByStructuralValue(processConfig, structuralValue) {
  const val = normalizeStructuralValue(structuralValue);
  if (!val) return null;

  return getDepartmentConfigs(processConfig).find((c) => {
    if (c.numbering?.enabled === false) return false;
    return (
      structuralMatch(c.structuralUnitName, val) ||
      structuralMatch(c.structuralUnitValue, val) ||
      structuralMatch(c.listValue, val)
    );
  });
}

function resolveConfig(processConfig, { departmentId, structuralValue }) {
  return (
    findConfigByStructuralValue(processConfig, structuralValue) ||
    findConfigByBitrixDepartment(processConfig, departmentId) ||
    getDepartmentConfigs(processConfig).find(
      (c) => c.numbering?.enabled !== false && (!c.bitrixDepartmentId || c.bitrixDepartmentId === '*'),
    )
  );
}

function buildFieldValueFromConfig(config, departmentName, fieldType) {
  if (!config) {
    if (!departmentName) return null;
    return fieldType === 'list' ? null : departmentName;
  }
  const name = config.structuralUnitName || departmentName;
  const value = config.structuralUnitValue || config.listValue || name;
  if (!value && !name) return null;
  if (fieldType === 'list') return config.listValue || config.structuralUnitValue || value;
  if (fieldType === 'department') return config.bitrixDepartmentId || null;
  return value || name;
}

function structuralKeyFromConfig(config) {
  return (
    normalizeStructuralValue(config.structuralUnitValue) ||
    normalizeStructuralValue(config.structuralUnitName) ||
    String(config.bitrixDepartmentId || 'default')
  );
}

module.exports = {
  defaultNumbering,
  migrateProcessConfig,
  getDepartmentConfigs,
  findConfigByBitrixDepartment,
  findConfigByStructuralValue,
  resolveConfig,
  buildFieldValueFromConfig,
  structuralKeyFromConfig,
};
