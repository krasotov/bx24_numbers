'use strict';

let config = { smartProcesses: [], pollingEnabled: true, pollIntervalMinutes: 5, userDepartmentField: 'departmentId' };
let portalProcesses = [];
let portalDepartments = [];
let portalDataLoaded = false;
let portalDataError = null;
const processFieldsCache = new Map();
const deptSearchOptionsCache = new Map();
let deptSearchCounter = 0;

const DEPT_FIELD_TYPES = [
  { value: 'string', label: 'Текст', hint: 'Обычное текстовое поле — в карточку записывается название подразделения' },
  { value: 'list', label: 'Список', hint: 'Поле-список — нужно выбрать элемент списка (ID) для каждого отдела' },
  { value: 'department', label: 'Привязка к отделу', hint: 'Поле типа «Привязка к структуре» — подставляется ID отдела Bitrix24' },
];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function uid() {
  return crypto.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toast(msg, type = 'success') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  setTimeout(() => el.classList.add('hidden'), 4000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  const json = await res.json();
  if (!json.success) {
    const err = json.error?.message || json.error || 'Ошибка запроса';
    throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
  }
  return json.data;
}

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'logs') loadLogs();
  if (name === 'counters') loadCounters();
}

function readGlobalSettings() {
  config.userDepartmentField = $('#userDepartmentField').value.trim() || 'departmentId';
  config.pollingEnabled = $('#pollingEnabled').checked;
  config.pollIntervalMinutes = parseInt($('#pollIntervalMinutes').value, 10) || 5;
  config.fillDepartmentFromUser = $('#fillDepartmentFromUser')?.checked !== false;
}

function writeGlobalSettings() {
  $('#userDepartmentField').value = config.userDepartmentField || 'departmentId';
  $('#pollingEnabled').checked = config.pollingEnabled !== false;
  $('#pollIntervalMinutes').value = config.pollIntervalMinutes || 5;
  if ($('#fillDepartmentFromUser')) {
    $('#fillDepartmentFromUser').checked = config.fillDepartmentFromUser !== false;
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

function normalizeFields(raw) {
  if (!raw) return [];
  if (Array.isArray(raw) && raw[0]?.code) {
    return raw.map((f) => ({
      code: f.code,
      title: f.title || f.label || f.code,
      type: String(f.type || '').toLowerCase(),
      readonly: f.readonly === true,
      items: getFieldEnumItems(f),
    }));
  }

  let map = raw;
  if (raw.fields && typeof raw.fields === 'object' && !Array.isArray(raw.fields)) {
    map = raw.fields;
  } else if (!Array.isArray(raw)) {
    map = raw;
  }

  const list = Array.isArray(map)
    ? map
    : Object.entries(map).map(([code, meta]) => ({ code, ...(typeof meta === 'object' ? meta : { title: meta }) }));

  return list
    .map((f) => {
      const code = f.code || f.fieldName || f.name;
      const type = String(f.type || f.userTypeId || '').toLowerCase();
      return {
        code,
        title: f.label || f.title || f.formLabel || f.listLabel || code,
        type,
        readonly: f.readonly === true || f.isReadOnly === true,
        items: getFieldEnumItems(f),
      };
    })
    .filter((f) => f.code && !['products', 'aggregatable', 'batch'].includes(f.code));
}

function fixLegacyFieldCode(code, fieldsByCode) {
  if (!code || fieldsByCode[code]) return code;
  const fixed = String(code).replace(/^ufCrm_(\d+)_/, 'ufCrm$1_');
  return fieldsByCode[fixed] ? fixed : code;
}

function suggestProcessFields(proc, fields) {
  if (!fields?.length) return;
  proc.fields = proc.fields || {};
  const byCode = Object.fromEntries(fields.map((f) => [f.code, f]));

  for (const key of ['creatorField', 'departmentField', 'numberField']) {
    if (proc.fields[key]) proc.fields[key] = fixLegacyFieldCode(proc.fields[key], byCode);
  }

  const findByLabel = (re) => fields.find((f) => re.test(`${f.title} ${f.code}`) && !f.readonly);

  const fromField = findByLabel(/от кого/i);
  if (fromField) {
    proc.fields.creatorField = fromField.code;
  } else if (!proc.fields.creatorField || (!byCode[proc.fields.creatorField] && proc.fields.creatorField !== 'createdBy')) {
    const c = fields.find((f) => f.type === 'employee');
    if (c) proc.fields.creatorField = c.code;
  }
  if (!proc.fields.departmentField || !byCode[proc.fields.departmentField]) {
    const c = findByLabel(/структурн.*подраздел/i);
    if (c) {
      proc.fields.departmentField = c.code;
      proc.fields.departmentFieldType = inferDepartmentFieldType(c);
    }
  }
  if (!proc.fields.numberField || !byCode[proc.fields.numberField]) {
    const c = findByLabel(/номер документ/i);
    if (c) proc.fields.numberField = c.code;
  }
  if (proc.fields.departmentField && byCode[proc.fields.departmentField]) {
    proc.fields.departmentFieldType = inferDepartmentFieldType(byCode[proc.fields.departmentField]);
  }
}

function isUserField(f) {
  return f.type === 'user' || f.type === 'employee' || f.code === 'createdBy' || f.code === 'assignedById';
}

function isDepartmentTargetField(f) {
  if (f.readonly) return false;
  return ['string', 'text', 'enumeration', 'list', 'department', 'crm', 'crm_status'].includes(f.type)
    || f.code.startsWith('ufCrm');
}

function isNumberTargetField(f) {
  if (f.readonly) return false;
  return ['string', 'text', 'integer', 'double', 'number'].includes(f.type) || f.code.startsWith('ufCrm');
}

function getFieldEnumItems(field) {
  if (!field) return [];
  const raw = field.items || field.enums || field.values || field.list || field.ENUM;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((x) => ({
      id: String(x.id ?? x.ID ?? x.value ?? x.VALUE ?? ''),
      label: x.value ?? x.VALUE ?? x.title ?? x.name ?? String(x.id ?? x.ID),
    })).filter((x) => x.id);
  }
  return Object.entries(raw).map(([k, v]) => ({
    id: String(k),
    label: typeof v === 'object' ? (v.value || v.VALUE || v.title || k) : String(v),
  }));
}

function inferDepartmentFieldType(field) {
  if (!field) return 'string';
  const t = (field.type || '').toLowerCase();
  if (t === 'enumeration' || t === 'list' || t === 'crm_status') return 'list';
  if (t === 'department' || t === 'iblock_section') return 'department';
  return 'string';
}

function fieldOptionLabel(f) {
  return `${f.title} (${f.code})`;
}

function renderSmartProcessSelect(proc) {
  const selected = proc.entityTypeId != null ? String(proc.entityTypeId) : '';
  const options = [{ id: '', label: '— выберите смарт-процесс —' }];

  for (const p of portalProcesses) {
    const id = String(p.entityTypeId ?? p.id ?? '');
    if (!id) continue;
    options.push({ id, label: `${p.title || 'Без названия'} (${id})` });
  }

  if (selected && !options.some((o) => o.id === selected)) {
    options.push({
      id: selected,
      label: `${proc.title || 'Текущий'} (${selected})`,
    });
  }

  return `
    <select class="proc-entityTypeId">
      ${options.map((o) =>
        `<option value="${escapeHtml(o.id)}" ${o.id === selected ? 'selected' : ''}>${escapeHtml(o.label)}</option>`,
      ).join('')}
    </select>
  `;
}

function renderFieldSelect(selectedCode, className, fields, filterFn, emptyLabel) {
  const selected = selectedCode || '';
  const filtered = fields.filter(filterFn);
  const options = [{ code: '', label: emptyLabel || '— не выбрано —' }];

  for (const f of filtered) {
    options.push({ code: f.code, label: fieldOptionLabel(f) });
  }

  if (selected && !options.some((o) => o.code === selected)) {
    options.push({ code: selected, label: `${selected} (сохранённое)` });
  }

  // Стандартные системные поля
  const system = [
    { code: 'createdBy', label: 'createdBy — кем создан' },
    { code: 'assignedById', label: 'assignedById — ответственный' },
  ];
  if (className === 'proc-creatorField') {
    for (const s of system) {
      if (!options.some((o) => o.code === s.code)) options.unshift(s);
    }
  }

  return `
    <select class="${className}">
      ${options.map((o) =>
        `<option value="${escapeHtml(o.code)}" ${o.code === selected ? 'selected' : ''}>${escapeHtml(o.label)}</option>`,
      ).join('')}
    </select>
  `;
}

function getProcessFields(proc) {
  if (!proc?.entityTypeId) return [];
  return processFieldsCache.get(String(proc.entityTypeId)) || [];
}

function getDepartmentFieldMeta(proc) {
  const fields = getProcessFields(proc);
  const code = proc.fields?.departmentField;
  return fields.find((f) => f.code === code) || null;
}

function renderDepartmentFieldTypeSelect(proc) {
  const selected = proc.fields?.departmentFieldType || 'string';
  const meta = getDepartmentFieldMeta(proc);
  const inferred = meta ? inferDepartmentFieldType(meta) : selected;
  const effective = proc.fields?.departmentField ? (selected || inferred) : selected;

  return `
    <select class="proc-departmentFieldType">
      ${DEPT_FIELD_TYPES.map((t) =>
        `<option value="${t.value}" ${effective === t.value ? 'selected' : ''}>${t.label}</option>`,
      ).join('')}
    </select>
    <span class="hint dept-type-hint">${escapeHtml(
      DEPT_FIELD_TYPES.find((t) => t.value === effective)?.hint || DEPT_FIELD_TYPES[0].hint,
    )}</span>
  `;
}

function renderProcessFieldsGrid(proc) {
  const fields = getProcessFields(proc);
  const hasFields = fields.length > 0;
  const deptType = proc.fields?.departmentFieldType || inferDepartmentFieldType(getDepartmentFieldMeta(proc));

  return `
    <div class="form-grid process-fields-grid">
      <label>Смарт-процесс
        ${renderSmartProcessSelect(proc)}
        <span class="hint">${portalProcesses.length ? 'Список с портала Bitrix24' : 'Нажмите «Загрузить из портала» выше'}</span>
      </label>
      <label class="fields-status-label">
        Поля карточки
        <span class="fields-status ${hasFields ? 'loaded' : ''}">${hasFields ? `Загружено ${fields.length} полей` : 'Выберите смарт-процесс — поля подгрузятся автоматически'}</span>
        ${proc.entityTypeId ? '<button type="button" class="btn btn-ghost btn-sm btn-reload-fields">Обновить поля</button>' : ''}
      </label>
      <label>Поле «От кого» (сотрудник)
        ${hasFields
          ? renderFieldSelect(
            proc.fields?.creatorField || 'createdBy',
            'proc-creatorField',
            fields,
            isUserField,
            '— выберите поле сотрудника —',
          )
          : `<input type="text" class="proc-creatorField" value="${escapeHtml(proc.fields?.creatorField || 'createdBy')}" placeholder="ufCrm24_... или createdBy">`}
        <span class="hint">Сотрудник «от кого». По его отделу определяется подразделение</span>
      </label>
      <label>Поле «Структурное подразделение»
        ${hasFields
          ? renderFieldSelect(
            proc.fields?.departmentField,
            'proc-departmentField',
            fields,
            isDepartmentTargetField,
            '— выберите поле подразделения —',
          )
          : `<input type="text" class="proc-departmentField" value="${escapeHtml(proc.fields?.departmentField || '')}" placeholder="ufCrm24_...">`}
        <span class="hint">Куда приложение запишет подразделение в карточке</span>
      </label>
      <label>Тип поля подразделения
        ${renderDepartmentFieldTypeSelect(proc)}
      </label>
      <label>Поле «Номер документа»
        ${hasFields
          ? renderFieldSelect(
            proc.fields?.numberField,
            'proc-numberField',
            fields,
            isNumberTargetField,
            '— выберите поле номера —',
          )
          : `<input type="text" class="proc-numberField" value="${escapeHtml(proc.fields?.numberField || '')}" placeholder="ufCrm24_...">`}
        <span class="hint">Сюда приложение запишет номер после обработки записи</span>
      </label>
    </div>
    <p class="hint card-fill-hint">Здесь вы только <strong>выбираете</strong> поля. Значения в карточке заполняются автоматически — см. вкладку «Интеграция».</p>
  `;
}

function renderProcesses() {
  const container = $('#processesList');
  updatePortalBanner();

  if (!config.smartProcesses.length) {
    container.innerHTML = '<div class="empty-state">Добавьте смарт-процесс для настройки нумерации</div>';
    return;
  }

  container.innerHTML = config.smartProcesses.map((proc, idx) => {
    migrateProcessForUi(proc);
    const deptType = proc.fields?.departmentFieldType
      || inferDepartmentFieldType(getDepartmentFieldMeta(proc));
    return `
    <div class="card" data-idx="${idx}">
      <div class="card-header">
        <h3>${escapeHtml(proc.title || `Смарт-процесс ${proc.entityTypeId || '—'}`)}</h3>
        <div>
          <label style="display:inline-flex;align-items:center;gap:6px;margin-right:12px;">
            <input type="checkbox" class="proc-enabled" ${proc.enabled !== false ? 'checked' : ''}> Включён
          </label>
          <button class="btn btn-danger btn-sm btn-remove-process">Удалить</button>
        </div>
      </div>

      ${renderProcessFieldsGrid(proc)}

      <div class="section-title">Нумерация по подразделениям</div>
      ${renderDepartmentTableHint(deptType)}
      <div class="dept-table-wrap">${renderDepartmentTable(proc, proc.departmentConfigs, deptType)}</div>
      <button class="btn btn-ghost btn-sm btn-add-dept-config">+ Добавить подразделение</button>
    </div>
  `;
  }).join('');

  bindProcessEvents();
  initDeptSearchSelects(container);
}

function renderDepartmentTableHint(deptType) {
  if (deptType === 'list') {
    return `<p class="hint block-hint">Для каждого отдела Bitrix24 выберите <strong>элемент списка</strong> — то же значение, что видно в карточке в поле «Структурное подразделение». Название подставится автоматически.</p>`;
  }
  if (deptType === 'department') {
    return `<p class="hint block-hint">Для каждого отдела укажите отдел Bitrix24 — в карточку будет записан его ID. Префикс и формат номера настраиваются отдельно для каждой строки.</p>`;
  }
  return `<p class="hint block-hint">Для каждого отдела Bitrix24 укажите <strong>название подразделения</strong> — именно этот текст будет записан в поле «Структурное подразделение» в карточке (например: «Управление делопроизводства»).</p>`;
}

function migrateProcessForUi(proc) {
  if (Array.isArray(proc.departmentConfigs) && proc.departmentConfigs.length) {
    return proc.departmentConfigs;
  }
  const configs = [];
  const mappings = proc.departmentMappings || [];
  const rules = proc.numberingRules || [];
  for (const m of mappings) {
    const rule = rules.find((r) => String(r.departmentId) === String(m.bitrixDepartmentId)) || {};
    configs.push({
      id: uid(),
      bitrixDepartmentId: m.bitrixDepartmentId ?? '',
      structuralUnitName: m.structuralUnitName || '',
      structuralUnitValue: m.structuralUnitValue || '',
      listValue: m.listValue || '',
      numbering: {
        id: rule.id || uid(),
        mode: rule.mode || 'auto',
        prefix: rule.prefix || '',
        suffix: rule.suffix || '',
        format: rule.format || '{prefix}-{year}-{counter:4}',
        counterReset: rule.counterReset || 'year',
        startFrom: rule.startFrom || 1,
        enabled: rule.enabled !== false,
      },
    });
  }
  for (const r of rules) {
    if (configs.some((c) => String(c.bitrixDepartmentId) === String(r.departmentId))) continue;
    configs.push({
      id: uid(),
      bitrixDepartmentId: r.departmentId && r.departmentId !== '*' ? r.departmentId : '',
      structuralUnitName: r.structuralUnit || '',
      structuralUnitValue: r.structuralUnitValue || r.structuralUnit || '',
      listValue: '',
      numbering: {
        id: r.id || uid(),
        mode: r.mode || 'auto',
        prefix: r.prefix || '',
        suffix: r.suffix || '',
        format: r.format || '{prefix}-{year}-{counter:4}',
        counterReset: r.counterReset || 'year',
        startFrom: r.startFrom || 1,
        enabled: r.enabled !== false,
      },
    });
  }
  proc.departmentConfigs = configs;
  return configs;
}

function renderListValueCell(proc, config, deptType) {
  const enumItems = getDepartmentFieldMeta(proc)?.items || [];
  const value = config.listValue || config.structuralUnitValue || '';

  if (deptType !== 'list') {
    return `<span class="hint cell-muted">—</span>`;
  }

  if (enumItems.length) {
    return `
      <select class="cfg-list-value">
        <option value="">— элемент списка —</option>
        ${enumItems.map((item) =>
          `<option value="${escapeHtml(item.id)}" data-label="${escapeHtml(item.label)}" ${String(item.id) === String(value) ? 'selected' : ''}>${escapeHtml(item.label)} (ID: ${escapeHtml(item.id)})</option>`,
        ).join('')}
      </select>
    `;
  }

  return `
    <input type="text" class="cfg-list-value" value="${escapeHtml(value)}"
      placeholder="ID элемента списка" title="Числовой ID варианта из настроек поля в Bitrix24">
  `;
}

function renderStructuralNameCell(config, deptType) {
  if (deptType === 'department') {
    return `<span class="hint cell-muted">Подставится ID отдела</span>`;
  }
  const placeholder = deptType === 'list'
    ? 'Заполнится из списка'
    : 'Например: Управление делопроизводства';
  const readonly = deptType === 'list' ? 'readonly' : '';
  return `<input type="text" class="cfg-structural-name" value="${escapeHtml(config.structuralUnitName || '')}" placeholder="${placeholder}" ${readonly}>`;
}

function renderDepartmentTable(proc, configs, deptType) {
  if (!configs?.length) {
    return '<p class="hint">Нажмите «+ Добавить подразделение» и настройте нумерацию для каждого отдела</p>';
  }

  const listColTitle = deptType === 'list' ? 'Элемент списка' : 'ID списка';
  const nameColTitle = deptType === 'list' ? 'Название (авто)' : 'Название в карточке';

  return `
    <table class="dept-table">
      <thead>
        <tr>
          <th>Отдел Bitrix24</th>
          <th>${nameColTitle}</th>
          ${deptType === 'list' ? `<th>${listColTitle}</th>` : ''}
          <th>Режим</th>
          <th>Префикс</th>
          <th>Формат</th>
          <th>Сброс</th>
          <th>С</th>
          <th>Вкл</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${configs.map((c, i) => `
          <tr class="dept-config-row" data-config-idx="${i}" data-config-id="${escapeHtml(c.id || '')}" data-rule-id="${escapeHtml(c.numbering?.id || '')}">
            <td>${renderDeptSearchSelect(c.bitrixDepartmentId, 'cfg-dept', false)}</td>
            <td>${renderStructuralNameCell(c, deptType)}</td>
            ${deptType === 'list' ? `<td>${renderListValueCell(proc, c, deptType)}</td>` : ''}
            <td>
              <select class="cfg-mode">
                <option value="auto" ${c.numbering?.mode === 'auto' ? 'selected' : ''}>Авто</option>
                <option value="manual" ${c.numbering?.mode === 'manual' ? 'selected' : ''}>Вручную</option>
              </select>
            </td>
            <td><input type="text" class="cfg-prefix" value="${escapeHtml(c.numbering?.prefix || '')}" placeholder="СЗ"></td>
            <td><input type="text" class="cfg-format" value="${escapeHtml(c.numbering?.format || '{prefix}-{year}-{counter:4}')}"></td>
            <td>
              <select class="cfg-reset">
                ${['year', 'month', 'never'].map((v) =>
                  `<option value="${v}" ${(c.numbering?.counterReset || 'year') === v ? 'selected' : ''}>${v}</option>`,
                ).join('')}
              </select>
            </td>
            <td><input type="number" class="cfg-start" value="${c.numbering?.startFrom || 1}" min="1" style="width:4rem"></td>
            <td><input type="checkbox" class="cfg-enabled" ${c.numbering?.enabled !== false ? 'checked' : ''}></td>
            <td><button type="button" class="btn btn-danger btn-sm btn-remove-dept-config">×</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function collectProcessFromCard(card) {
  const idx = parseInt(card.dataset.idx, 10);
  const proc = config.smartProcesses[idx];

  proc.enabled = card.querySelector('.proc-enabled').checked;
  const entitySel = card.querySelector('.proc-entityTypeId');
  proc.entityTypeId = entitySel?.value ? parseInt(entitySel.value, 10) : null;

  const portalProc = portalProcesses.find((p) => String(p.entityTypeId ?? p.id) === String(proc.entityTypeId));
  if (portalProc?.title) proc.title = portalProc.title;

  proc.fields = {
    creatorField: card.querySelector('.proc-creatorField')?.value.trim() || 'createdBy',
    departmentField: card.querySelector('.proc-departmentField')?.value.trim() || '',
    departmentFieldType: card.querySelector('.proc-departmentFieldType')?.value || 'string',
    numberField: card.querySelector('.proc-numberField')?.value.trim() || '',
  };

  proc.departmentConfigs = [...card.querySelectorAll('.dept-config-row')].map((row) => {
    const listEl = row.querySelector('.cfg-list-value');
    let listValue = listEl?.value?.trim() || '';
    let structuralName = row.querySelector('.cfg-structural-name')?.value.trim() || '';

    if (listEl?.tagName === 'SELECT' && listEl.selectedOptions[0]) {
      const opt = listEl.selectedOptions[0];
      listValue = opt.value;
      if (!structuralName && opt.dataset.label) structuralName = opt.dataset.label;
    }

    return {
      id: row.dataset.configId || uid(),
      bitrixDepartmentId: row.querySelector('.cfg-dept.dept-search-value, .cfg-dept')?.value || '',
      structuralUnitName: structuralName,
      structuralUnitValue: listValue || structuralName,
      listValue,
      numbering: {
        id: row.dataset.ruleId || uid(),
        mode: row.querySelector('.cfg-mode')?.value || 'auto',
        prefix: row.querySelector('.cfg-prefix')?.value.trim() || '',
        suffix: '',
        format: row.querySelector('.cfg-format')?.value.trim() || '{prefix}-{year}-{counter:4}',
        counterReset: row.querySelector('.cfg-reset')?.value || 'year',
        startFrom: parseInt(row.querySelector('.cfg-start')?.value, 10) || 1,
        enabled: row.querySelector('.cfg-enabled')?.checked !== false,
      },
    };
  });

  proc.departmentMappings = proc.departmentConfigs.map((c) => ({
    bitrixDepartmentId: c.bitrixDepartmentId,
    structuralUnitName: c.structuralUnitName,
    structuralUnitValue: c.structuralUnitValue,
    listValue: c.listValue,
  }));
  proc.numberingRules = proc.departmentConfigs.map((c) => ({
    id: c.numbering.id,
    departmentId: c.bitrixDepartmentId,
    structuralUnit: c.structuralUnitName,
    ...c.numbering,
  }));

  config.smartProcesses[idx] = proc;
}

function collectAll() {
  readGlobalSettings();
  $$('.card[data-idx]').forEach(collectProcessFromCard);
}

async function loadProcessFields(entityTypeId, force = false) {
  if (!entityTypeId) return [];
  const key = String(entityTypeId);
  if (!force && processFieldsCache.has(key)) return processFieldsCache.get(key);

  try {
    const raw = await api(`/api/fields/${entityTypeId}`);
    const fields = normalizeFields(raw);
    processFieldsCache.set(key, fields);
    return fields;
  } catch (err) {
    toast(`Не удалось загрузить поля: ${err.message}`, 'error');
    return processFieldsCache.get(key) || [];
  }
}

async function onProcessEntityChange(card) {
  const idx = parseInt(card.dataset.idx, 10);
  collectProcessFromCard(card);
  const proc = config.smartProcesses[idx];
  if (!proc.entityTypeId) {
    renderProcesses();
    return;
  }

  await loadProcessFields(proc.entityTypeId, true);
  const portalProc = portalProcesses.find((p) => String(p.entityTypeId ?? p.id) === String(proc.entityTypeId));
  if (portalProc?.title) proc.title = portalProc.title;

  const fields = getProcessFields(proc);
  suggestProcessFields(proc, fields);

  renderProcesses();
}

async function onReloadFields(card) {
  const idx = parseInt(card.dataset.idx, 10);
  collectProcessFromCard(card);
  const proc = config.smartProcesses[idx];
  if (!proc.entityTypeId) return toast('Сначала выберите смарт-процесс', 'error');
  await loadProcessFields(proc.entityTypeId, true);
  suggestProcessFields(proc, getProcessFields(proc));
  renderProcesses();
  toast(`Поля загружены: ${getProcessFields(proc).length}`);
}

async function onDepartmentFieldChange(card) {
  const idx = parseInt(card.dataset.idx, 10);
  collectProcessFromCard(card);
  const proc = config.smartProcesses[idx];
  const meta = getDepartmentFieldMeta(proc);
  if (meta) {
    proc.fields.departmentFieldType = inferDepartmentFieldType(meta);
  }
  renderProcesses();
}

function bindProcessEvents() {
  $$('.btn-remove-process').forEach((btn) => {
    btn.onclick = () => {
      const idx = parseInt(btn.closest('.card').dataset.idx, 10);
      config.smartProcesses.splice(idx, 1);
      renderProcesses();
    };
  });

  $$('.proc-entityTypeId').forEach((sel) => {
    sel.onchange = () => onProcessEntityChange(sel.closest('.card'));
  });

  $$('.btn-reload-fields').forEach((btn) => {
    btn.onclick = () => onReloadFields(btn.closest('.card'));
  });

  $$('.proc-departmentField').forEach((sel) => {
    sel.onchange = () => onDepartmentFieldChange(sel.closest('.card'));
  });

  $$('.proc-departmentFieldType').forEach((sel) => {
    sel.onchange = () => {
      const card = sel.closest('.card');
      collectProcessFromCard(card);
      renderProcesses();
    };
  });

  $$('.cfg-list-value').forEach((sel) => {
    if (sel.tagName !== 'SELECT') return;
    sel.onchange = () => {
      const row = sel.closest('.dept-config-row');
      const nameInput = row?.querySelector('.cfg-structural-name');
      const opt = sel.selectedOptions[0];
      if (nameInput && opt?.dataset.label) nameInput.value = opt.dataset.label;
    };
  });

  $$('.btn-add-dept-config').forEach((btn) => {
    btn.onclick = () => {
      const card = btn.closest('.card');
      const idx = parseInt(card.dataset.idx, 10);
      collectProcessFromCard(card);
      migrateProcessForUi(config.smartProcesses[idx]);
      config.smartProcesses[idx].departmentConfigs.push({
        id: uid(),
        bitrixDepartmentId: '',
        structuralUnitName: '',
        structuralUnitValue: '',
        listValue: '',
        numbering: {
          id: uid(),
          mode: 'auto',
          prefix: '',
          format: '{prefix}-{year}-{counter:4}',
          counterReset: 'year',
          startFrom: 1,
          enabled: true,
        },
      });
      renderProcesses();
    };
  });

  $$('.btn-remove-dept-config').forEach((btn) => {
    btn.onclick = () => {
      const card = btn.closest('.card');
      const row = btn.closest('.dept-config-row');
      const idx = parseInt(card.dataset.idx, 10);
      const cIdx = parseInt(row.dataset.configIdx, 10);
      collectProcessFromCard(card);
      migrateProcessForUi(config.smartProcesses[idx]);
      config.smartProcesses[idx].departmentConfigs.splice(cIdx, 1);
      renderProcesses();
    };
  });
}

async function loadConfig() {
  config = await api('/api/config');
  config.smartProcesses?.forEach((p) => migrateProcessForUi(p));
  writeGlobalSettings();
  $('#webhookUrl').textContent = `${location.origin}/api/webhook`;
}

async function saveConfig() {
  collectAll();
  await api('/api/config', { method: 'PUT', body: JSON.stringify(config) });
  toast('Настройки сохранены');
}

async function loadLogs() {
  const logs = await api('/api/logs');
  const container = $('#logsList');
  if (!logs.length) {
    container.innerHTML = '<div class="empty-state">Журнал пуст</div>';
    return;
  }
  container.innerHTML = logs.map((l) => `
    <div class="log-entry ${l.level === 'error' ? 'log-error' : ''}">
      <span class="log-time">${l.timestamp || ''}</span>
      ${escapeHtml(l.action || '')} — ${escapeHtml(l.processTitle || l.entityTypeId || '')}
      ${l.numberAssigned ? ` → номер: ${escapeHtml(l.numberAssigned)}` : ''}
      ${l.error ? ` — ${escapeHtml(l.error)}` : ''}
    </div>
  `).join('');
}

async function loadCounters() {
  const counters = await api('/api/counters');
  const container = $('#countersList');
  const entries = Object.entries(counters);
  if (!entries.length) {
    container.innerHTML = '<div class="empty-state">Счётчики ещё не использовались</div>';
    return;
  }
  container.innerHTML = entries.map(([key, val]) =>
    `<div class="log-entry"><code>${escapeHtml(key)}</code> = ${val}</div>`,
  ).join('');
}

function updatePortalBanner() {
  const el = $('#portalDataBanner');
  if (!el) return;
  if (portalDataError) {
    el.className = 'portal-banner error';
    el.textContent = `Не удалось загрузить данные с портала: ${portalDataError}. Нажмите «Загрузить из портала».`;
    el.hidden = false;
  } else if (!portalDataLoaded) {
    el.className = 'portal-banner warn';
    el.textContent = 'Загрузка данных с портала…';
    el.hidden = false;
  } else if (!portalDepartments.length) {
    el.className = 'portal-banner warn';
    el.textContent = 'Отделы не загружены — поиск по отделам не будет работать. Нажмите «Загрузить из портала».';
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

async function loadPortalData() {
  portalDataError = null;
  portalDataLoaded = false;
  updatePortalBanner();

  try {
    const [processes, departments] = await Promise.all([
      api('/api/smart-processes'),
      api('/api/departments'),
    ]);
    portalProcesses = Array.isArray(processes) ? processes : processes?.items || [];
    portalDepartments = Array.isArray(departments) ? departments : departments?.items || [];
    portalDepartments = sortDepartmentsForDisplay(portalDepartments);
    portalDataLoaded = true;

    for (const proc of config.smartProcesses) {
      if (proc.entityTypeId) {
        await loadProcessFields(proc.entityTypeId);
        suggestProcessFields(proc, getProcessFields(proc));
      }
    }

    renderProcesses();
    return { processes: portalProcesses.length, departments: portalDepartments.length };
  } catch (err) {
    portalDataError = err.message;
    portalDataLoaded = true;
    updatePortalBanner();
    throw err;
  }
}

function sortDepartmentsForDisplay(departments) {
  const byId = Object.fromEntries(departments.map((d) => [String(d.id), d]));

  function label(dept) {
    const parts = [dept.name || `Отдел ${dept.id}`];
    let parentId = dept.parentId;
    const seen = new Set([String(dept.id)]);
    while (parentId && byId[String(parentId)] && !seen.has(String(parentId))) {
      seen.add(String(parentId));
      const parent = byId[String(parentId)];
      parts.unshift(parent.name || `Отдел ${parent.id}`);
      parentId = parent.parentId;
    }
    return parts.join(' → ');
  }

  return departments
    .map((d) => ({ ...d, displayName: label(d) }))
    .sort((a, b) => (a.displayName || a.name || '').localeCompare(b.displayName || b.name || '', 'ru'));
}

function departmentOptionLabel(d) {
  return d.displayName || d.name || `Отдел ${d.id}`;
}

function departmentSearchText(d) {
  return `${departmentOptionLabel(d)} ${d.id}`.toLowerCase();
}

function renderDeptSearchSelect(selectedValue, inputClass, includeAny = false) {
  const selected = selectedValue == null ? '' : String(selectedValue);
  const selectedDept = portalDepartments.find((d) => String(d.id) === selected);
  let displayText = '';
  if (selected === '*') displayText = 'Любой (*)';
  else if (selectedDept) displayText = departmentOptionLabel(selectedDept);
  else if (selected) displayText = `Отдел #${selected}`;

  const emptyHint = portalDepartments.length
    ? '— выберите —'
    : 'Сначала загрузите отделы с портала';

  const options = [
    ...(includeAny ? [{ id: '*', label: 'Любой (*)', search: 'любой *' }] : [{ id: '', label: emptyHint, search: '' }]),
    ...portalDepartments.map((d) => ({
      id: String(d.id),
      label: departmentOptionLabel(d),
      search: departmentSearchText(d),
    })),
  ];

  const cacheId = `ds-${++deptSearchCounter}`;
  deptSearchOptionsCache.set(cacheId, options);

  return `
    <div class="dept-search ${inputClass}-wrap" data-cache-id="${cacheId}">
      <input type="hidden" class="${inputClass} dept-search-value" value="${escapeHtml(selected)}">
      <input type="text" class="dept-search-input" value="${escapeHtml(displayText)}"
        placeholder="${portalDepartments.length ? 'Введите название отдела…' : 'Загрузите данные с портала'}"
        autocomplete="off">
      <div class="dept-search-dropdown hidden"></div>
    </div>
  `;
}

function positionDeptDropdown(wrap, dropdown) {
  const rect = wrap.getBoundingClientRect();
  dropdown.style.position = 'fixed';
  dropdown.style.left = `${rect.left}px`;
  dropdown.style.top = `${rect.bottom + 4}px`;
  dropdown.style.width = `${Math.max(rect.width, 280)}px`;
  dropdown.style.zIndex = '1000';
}

function initDeptSearchSelects(root = document) {
  root.querySelectorAll('.dept-search:not([data-init])').forEach((wrap) => {
    wrap.dataset.init = '1';
    const hidden = wrap.querySelector('.dept-search-value');
    const input = wrap.querySelector('.dept-search-input');
    const dropdown = wrap.querySelector('.dept-search-dropdown');
    const options = deptSearchOptionsCache.get(wrap.dataset.cacheId) || [];
    let searchQuery = '';

    function renderDropdown(filter = '') {
      searchQuery = filter;
      const q = filter.trim().toLowerCase();
      const globalQ = ($('#deptGlobalSearch')?.value || '').trim().toLowerCase();

      if (!portalDepartments.length) {
        dropdown.innerHTML = '<div class="dept-search-empty">Нет отделов. Нажмите «Загрузить из портала» вверху страницы.</div>';
        positionDeptDropdown(wrap, dropdown);
        dropdown.classList.remove('hidden');
        return;
      }

      const filtered = (q || globalQ)
        ? options.filter((o) => {
            if (!o.id) return false;
            const hay = `${o.search} ${o.label}`.toLowerCase();
            const words = [...(q ? q.split(/\s+/) : []), ...(globalQ ? globalQ.split(/\s+/) : [])].filter(Boolean);
            return words.every((word) => hay.includes(word));
          })
        : options.filter((o) => o.id !== '');

      if (!filtered.length) {
        dropdown.innerHTML = '<div class="dept-search-empty">Ничего не найдено — попробуйте другой запрос</div>';
      } else {
        dropdown.innerHTML = filtered.slice(0, 100).map((o) =>
          `<button type="button" class="dept-search-item" data-id="${escapeHtml(o.id)}">${escapeHtml(o.label)}</button>`,
        ).join('');
        if (filtered.length > 100) {
          dropdown.innerHTML += `<div class="dept-search-empty">Показано 100 из ${filtered.length} — уточните запрос</div>`;
        }
      }
      positionDeptDropdown(wrap, dropdown);
      dropdown.classList.remove('hidden');
    }

    function selectOption(id, label) {
      hidden.value = id;
      input.value = label;
      searchQuery = '';
      dropdown.classList.add('hidden');
    }

    input.addEventListener('focus', () => {
      input.select();
      renderDropdown('');
    });
    input.addEventListener('input', () => renderDropdown(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') dropdown.classList.add('hidden');
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = dropdown.querySelector('.dept-search-item');
        if (first) selectOption(first.dataset.id, first.textContent);
      }
    });

    dropdown.addEventListener('click', (e) => {
      const btn = e.target.closest('.dept-search-item');
      if (!btn) return;
      selectOption(btn.dataset.id, btn.textContent);
    });

    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) dropdown.classList.add('hidden');
    });

    window.addEventListener('scroll', () => {
      if (!dropdown.classList.contains('hidden')) positionDeptDropdown(wrap, dropdown);
    }, true);
    window.addEventListener('resize', () => {
      if (!dropdown.classList.contains('hidden')) positionDeptDropdown(wrap, dropdown);
    });
  });
}

function addProcessFromPortal() {
  config.smartProcesses.push({
    id: uid(),
    entityTypeId: null,
    title: '',
    enabled: true,
    fields: { creatorField: 'createdBy', departmentFieldType: 'string' },
    departmentConfigs: [],
  });
  renderProcesses();
}

$$('.tab').forEach((tab) => {
  tab.onclick = () => switchTab(tab.dataset.tab);
});

$('#btnSave').onclick = () => saveConfig().catch((e) => toast(e.message, 'error'));
$('#btnPoll').onclick = async () => {
  try {
    const results = await api('/api/poll', { method: 'POST', body: '{}' });
    toast(`Опрос завершён: ${results.length} элементов`);
    loadLogs();
  } catch (e) {
    toast(e.message, 'error');
  }
};
$('#btnAddProcess').onclick = addProcessFromPortal;
$('#btnLoadProcesses').onclick = () => loadPortalData()
  .then((r) => toast(`Загружено: ${r.departments} отделов, ${r.processes} смарт-процессов`))
  .catch((e) => toast(e.message, 'error'));

const deptGlobalSearch = $('#deptGlobalSearch');
if (deptGlobalSearch) {
  deptGlobalSearch.addEventListener('input', () => {
    document.querySelectorAll('.dept-search-input:focus').forEach((input) => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}

async function bootstrap() {
  try {
    await loadConfig();
    renderProcesses();
    await loadPortalData();
  } catch (e) {
    toast(e.message, 'error');
    try {
      await loadPortalData();
    } catch {
      renderProcesses();
    }
  }
}

bootstrap();
