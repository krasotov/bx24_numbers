'use strict';

const { VibeApi } = require('./vibe-api');
const { formatNumber, normalizeStructuralValue, isEmptyStructural, isPlaceholderStructural } = require('./numbering');
const { assignNextCounter } = require('./counter-assign');
const {
  migrateProcessConfig,
  resolveConfigForAutofill,
  resolveConfigForNumbering,
  findSingletonStructuralOnlyConfig,
  isEmptyBitrixDepartment,
  buildFieldValueFromConfig,
  structuralKeyFromConfig,
} = require('./department-config');
const { getConfig, addLog } = require('./storage');

const SYSTEM_CREATOR_FIELDS = new Set(['createdBy', 'assignedById', 'updatedBy', 'movedBy']);

function extractUserId(value) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  if (Array.isArray(value) && value.length) return extractUserId(value[0]);
  if (typeof value === 'object' && value.id) return extractUserId(value.id);
  return null;
}

function getFieldValue(item, fieldCode) {
  if (!fieldCode) return null;
  return item[fieldCode] ?? item[fieldCode.toLowerCase()] ?? null;
}

function hasNumber(value) {
  return !isEmptyStructural(value);
}

function shouldFillFromUser(globalConfig) {
  return globalConfig.fillDepartmentFromUser !== false;
}

function resolveCreatorUserId(item, fields) {
  const fieldCode = fields.creatorField || 'createdBy';
  const fromField = extractUserId(getFieldValue(item, fieldCode));

  if (fromField) {
    return { userId: fromField, source: fieldCode };
  }

  // Для пользовательского поля «От кого» не подставляем createdBy — иначе
  // нумерация идёт по отделу создателя карточки (часто админ), а не по автору записки.
  if (fieldCode && !SYSTEM_CREATOR_FIELDS.has(fieldCode)) {
    return { userId: null, source: fieldCode, waitingFor: true };
  }

  const fallback = extractUserId(item.createdBy);
  return { userId: fallback, source: fallback ? 'createdBy' : fieldCode };
}

async function resolveUserDepartment(api, userId, config) {
  const user = await api.getUser(userId);
  const deptField = config.userDepartmentField || 'departmentId';
  let deptIds = user[deptField] ?? user.departmentId ?? [];

  if (!Array.isArray(deptIds)) deptIds = [deptIds].filter(Boolean);
  if (!deptIds.length) {
    return { user, departmentId: null, departmentName: null };
  }

  const departmentId = deptIds[0];
  let departmentName = null;
  try {
    const dept = await api.getDepartment(departmentId);
    departmentName = dept.name || dept.NAME || String(departmentId);
  } catch {
    departmentName = String(departmentId);
  }

  return { user, departmentId, departmentName };
}

async function processItem(api, entityTypeId, itemId, processConfig, globalConfig) {
  migrateProcessConfig(processConfig);
  const item = await api.getItem(entityTypeId, itemId);
  const fields = processConfig.fields || {};
  const updates = {};
  const logDetails = { entityTypeId, itemId, itemTitle: item.title };

  const creator = resolveCreatorUserId(item, fields);
  const userId = creator.userId;
  logDetails.userId = userId;
  logDetails.creatorSource = creator.source;
  if (creator.waitingFor) {
    logDetails.creatorWaiting = fields.creatorField;
  }

  let departmentId = null;
  let departmentName = null;
  if (userId) {
    const resolved = await resolveUserDepartment(api, userId, globalConfig);
    departmentId = resolved.departmentId;
    departmentName = resolved.departmentName;
    logDetails.departmentId = departmentId;
    logDetails.departmentName = departmentName;
  }

  let structuralValue = getFieldValue(item, fields.departmentField);
  if (isPlaceholderStructural(structuralValue)) {
    logDetails.structuralPlaceholder = normalizeStructuralValue(structuralValue);
    structuralValue = null;
  }

  // Автозаполнение «Структурное подразделение» — только если поле пустое
  if (
    shouldFillFromUser(globalConfig) &&
    fields.departmentField &&
    isEmptyStructural(structuralValue) &&
    userId
  ) {
    let fillConfig = resolveConfigForAutofill(processConfig, departmentId);
    if (!fillConfig && departmentId) {
      fillConfig = findOrCreateFallbackConfig(processConfig, departmentId, departmentName);
    }
    if (fillConfig && isEmptyBitrixDepartment(fillConfig.bitrixDepartmentId)) {
      logDetails.autofillStructuralOnly = true;
    }
    const deptValue = buildFieldValueFromConfig(
      fillConfig,
      departmentName,
      fields.departmentFieldType || 'string',
    );
    const target = normalizeStructuralValue(deptValue);
    if (deptValue != null && target) {
      updates[fields.departmentField] = deptValue;
      structuralValue = deptValue;
      logDetails.departmentSet = deptValue;
      logDetails.autofillFromDept = departmentId;
    }
  }

  logDetails.structuralUnit = normalizeStructuralValue(structuralValue);

  if (creator.waitingFor && isEmptyStructural(structuralValue)) {
    logDetails.numbering = `ожидание — заполните поле «${fields.creatorField}»`;
    addLog({ level: 'warn', action: 'process_item', processTitle: processConfig.title, ...logDetails });
    if (Object.keys(updates).length) await api.updateItem(entityTypeId, itemId, updates);
    return { item, updates, logDetails };
  }

  if (isEmptyStructural(structuralValue)) {
    const structuralOnlyRule = findSingletonStructuralOnlyConfig(processConfig);
    if (!structuralOnlyRule) {
      logDetails.numbering = userId
        ? 'ожидание — не удалось определить подразделение (настройте строку для отдела сотрудника или одну строку без отдела HR)'
        : 'ожидание — укажите сотрудника в поле «от кого»';
      addLog({ level: 'warn', action: 'process_item', processTitle: processConfig.title, ...logDetails });
      if (Object.keys(updates).length) await api.updateItem(entityTypeId, itemId, updates);
      return { item, updates, logDetails };
    }
    logDetails.structuralOnlyRule = true;
  }

  // Номер — строго по значению «Структурное подразделение», не по орг. отделу сотрудника
  const deptConfig = resolveConfigForNumbering(processConfig, structuralValue);

  if (!deptConfig || deptConfig.numbering?.enabled === false) {
    logDetails.numbering = `нет правила для подразделения «${logDetails.structuralUnit}» (номер не по отделу HR)`;
    logDetails.hint = 'Добавьте строку в таблице с тем же названием, что в поле карточки';
    addLog({ level: 'warn', action: 'process_item', processTitle: processConfig.title, ...logDetails });
    if (Object.keys(updates).length) await api.updateItem(entityTypeId, itemId, updates);
    return { item, updates, logDetails };
  }

  const rule = deptConfig.numbering;
  const unitKey = structuralKeyFromConfig(deptConfig);
  const existingNumber = getFieldValue(item, fields.numberField);
  logDetails.ruleMatch = unitKey;
  logDetails.matchedConfigDept = deptConfig.bitrixDepartmentId;

  if (fields.numberField) {
    if (rule.mode === 'manual') {
      logDetails.numbering = 'ручная нумерация для этого подразделения';
    } else if (!hasNumber(existingNumber) || rule.overwriteExisting) {
      const assignment = await assignNextCounter(
        api,
        entityTypeId,
        processConfig,
        rule,
        unitKey,
        normalizeStructuralValue(structuralValue) || unitKey,
        { excludeItemId: itemId },
      );
      const number = assignment.nextFormatted;
      updates[fields.numberField] = number;
      logDetails.numberAssigned = number;
      logDetails.ruleId = rule.id;
      logDetails.counterUsed = assignment.counter;
      logDetails.counterKey = assignment.counterKey;
      if (assignment.gapFilled) logDetails.gapFilled = true;
    } else {
      logDetails.numbering = 'номер уже задан';
    }
  }

  if (Object.keys(updates).length) {
    await api.updateItem(entityTypeId, itemId, updates);
    logDetails.updated = updates;
  }

  addLog({
    level: logDetails.numberAssigned ? 'info' : 'info',
    action: 'process_item',
    processTitle: processConfig.title,
    ...logDetails,
  });

  return { item, updates, logDetails };
}

function findOrCreateFallbackConfig(processConfig, departmentId, departmentName) {
  migrateProcessConfig(processConfig);
  let cfg = processConfig.departmentConfigs.find(
    (c) => String(c.bitrixDepartmentId) === String(departmentId),
  );
  if (!cfg && departmentName) {
    cfg = {
      id: `auto-${departmentId}`,
      bitrixDepartmentId: String(departmentId),
      structuralUnitName: departmentName,
      structuralUnitValue: departmentName,
      listValue: '',
      numbering: {
        id: `auto-rule-${departmentId}`,
        mode: 'manual',
        prefix: '',
        format: '{prefix}-{year}-{counter:4}',
        counterReset: 'year',
        startFrom: 1,
        enabled: false,
      },
    };
  }
  return cfg;
}

async function processByConfig(apiKey, entityTypeId, itemId) {
  const config = getConfig();
  const api = new VibeApi(apiKey);
  const processConfig = config.smartProcesses.find(
    (p) => p.enabled !== false && String(p.entityTypeId) === String(entityTypeId),
  );

  if (!processConfig) {
    throw new Error(`Смарт-процесс ${entityTypeId} не настроен в приложении`);
  }

  return processItem(api, entityTypeId, itemId, processConfig, config);
}

async function pollUnnumbered(apiKey) {
  const config = getConfig();
  const api = new VibeApi(apiKey);
  const results = [];

  for (const processConfig of config.smartProcesses.filter((p) => p.enabled !== false)) {
    migrateProcessConfig(processConfig);
    const { entityTypeId, fields } = processConfig;
    if (!fields?.numberField) continue;

    try {
      const searchResult = await api.searchItems(entityTypeId, {}, { limit: 200 });
      const items = searchResult.items || searchResult || [];

      for (const item of items) {
        if (hasNumber(getFieldValue(item, fields.numberField))) continue;
        try {
          const result = await processItem(api, entityTypeId, item.id, processConfig, config);
          results.push({ success: true, itemId: item.id, ...result.logDetails });
        } catch (err) {
          results.push({ success: false, itemId: item.id, error: err.message });
          addLog({ level: 'error', action: 'poll_item', entityTypeId, itemId: item.id, error: err.message });
        }
      }
    } catch (err) {
      results.push({ success: false, entityTypeId, error: err.message });
    }
  }

  return results;
}

module.exports = {
  processByConfig,
  pollUnnumbered,
  processItem,
  resolveCreatorUserId,
};
