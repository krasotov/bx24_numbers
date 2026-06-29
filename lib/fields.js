'use strict';

function unwrapFieldsResponse(raw) {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    return Object.fromEntries(raw.map((f) => [f.code || f.fieldName || f.name, f]));
  }
  if (raw.fields && typeof raw.fields === 'object' && !Array.isArray(raw.fields)) {
    return raw.fields;
  }
  return raw;
}

function getFieldEnumItems(field) {
  if (!field) return [];
  const raw = field.items || field.enums || field.values || field.list || field.ENUM;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((x) => ({
        id: String(x.id ?? x.ID ?? x.value ?? x.VALUE ?? ''),
        label: x.value ?? x.VALUE ?? x.title ?? x.name ?? String(x.id ?? x.ID),
      }))
      .filter((x) => x.id);
  }
  return Object.entries(raw).map(([k, v]) => ({
    id: String(k),
    label: typeof v === 'object' ? (v.value || v.VALUE || v.title || k) : String(v),
  }));
}

function normalizeFields(raw) {
  const map = unwrapFieldsResponse(raw);
  return Object.entries(map)
    .map(([code, meta]) => {
      const field = typeof meta === 'object' ? { code, ...meta } : { code, title: meta };
      const type = String(field.type || field.userTypeId || '').toLowerCase();
      const readonly = field.readonly === true || field.isReadOnly === true;
      return {
        code,
        title: field.label || field.title || field.formLabel || field.listLabel || code,
        type,
        readonly,
        items: getFieldEnumItems(field),
      };
    })
    .filter((f) => f.code && !['products', 'aggregatable', 'batch'].includes(f.code));
}

function inferDepartmentFieldType(field) {
  if (!field) return 'string';
  const t = (field.type || '').toLowerCase();
  if (t === 'enumeration' || t === 'list' || t === 'crm_status') return 'list';
  if (t === 'department' || t === 'iblock_section') return 'department';
  return 'string';
}

function fixLegacyFieldCode(code, fieldsByCode) {
  if (!code || fieldsByCode[code]) return code;
  const fixed = String(code).replace(/^ufCrm_(\d+)_/, 'ufCrm$1_');
  if (fieldsByCode[fixed]) return fixed;
  return code;
}

function suggestProcessFields(proc, fields) {
  if (!fields?.length) return proc;
  proc.fields = proc.fields || {};
  const byCode = Object.fromEntries(fields.map((f) => [f.code, f]));

  for (const key of ['creatorField', 'departmentField', 'numberField']) {
    if (proc.fields[key]) {
      proc.fields[key] = fixLegacyFieldCode(proc.fields[key], byCode);
    }
  }

  const findByLabel = (re) => fields.find((f) => re.test(`${f.title} ${f.code}`) && !f.readonly);

  const fromField = findByLabel(/от кого/i);
  if (fromField) {
    proc.fields.creatorField = fromField.code;
  } else if (!proc.fields.creatorField || (!byCode[proc.fields.creatorField] && proc.fields.creatorField !== 'createdBy')) {
    const candidate =
      fields.find((f) => f.type === 'employee' && /кому|сотрудник|автор/i.test(f.title)) ||
      fields.find((f) => f.type === 'employee');
    if (candidate) proc.fields.creatorField = candidate.code;
  }

  if (!proc.fields.departmentField || !byCode[proc.fields.departmentField]) {
    const candidate = findByLabel(/структурн.*подраздел/i) || findByLabel(/подраздел/i);
    if (candidate) {
      proc.fields.departmentField = candidate.code;
      proc.fields.departmentFieldType = inferDepartmentFieldType(candidate);
    }
  }

  if (!proc.fields.numberField || !byCode[proc.fields.numberField]) {
    const candidate = findByLabel(/номер документ/i) || findByLabel(/номер/i);
    if (candidate) proc.fields.numberField = candidate.code;
  }

  if (proc.fields.departmentField && byCode[proc.fields.departmentField]) {
    proc.fields.departmentFieldType = inferDepartmentFieldType(byCode[proc.fields.departmentField]);
  }

  return proc;
}

module.exports = {
  unwrapFieldsResponse,
  normalizeFields,
  inferDepartmentFieldType,
  suggestProcessFields,
  getFieldEnumItems,
};
