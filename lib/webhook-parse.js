'use strict';

function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && v !== '') return v;
  }
  return null;
}

function parseDocumentId(documentId) {
  if (!documentId) return { entityTypeId: null, itemId: null };

  if (Array.isArray(documentId)) {
    const itemId = documentId[documentId.length - 1];
    const typePart = documentId.find((p) => String(p).startsWith('DYNAMIC_'));
    const entityTypeId = typePart ? parseInt(String(typePart).replace('DYNAMIC_', ''), 10) : null;
    return {
      entityTypeId: Number.isFinite(entityTypeId) ? entityTypeId : null,
      itemId: itemId != null ? parseInt(String(itemId), 10) : null,
    };
  }

  if (typeof documentId === 'string') {
    const m = documentId.match(/DYNAMIC_(\d+).*?(\d+)/i);
    if (m) return { entityTypeId: parseInt(m[1], 10), itemId: parseInt(m[2], 10) };
  }

  return { entityTypeId: null, itemId: null };
}

function parseBitrixEventPayload(body) {
  const data = body?.data || body?.DATA;
  const fields = data?.FIELDS || data?.fields || data?.FIELDS_AFTER;
  const itemId = pick(fields, 'ID', 'id');
  return {
    entityTypeId: pick(body, 'entityTypeId', 'ENTITY_TYPE_ID'),
    itemId: itemId != null ? parseInt(String(itemId), 10) : null,
    event: body?.event || body?.EVENT,
  };
}

function parseNumericId(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/\b(\d{2,})\b/);
  return m ? parseInt(m[1], 10) : null;
}

function parseWebhookPayload(body, query = {}) {
  if (!body && !query) return null;

  const directEntity = pick(body, 'entityTypeId', 'entity_type_id') ?? pick(query, 'entityTypeId', 'entity_type_id');
  const directItemRaw = pick(body, 'itemId', 'item_id', 'id', 'ID') ?? pick(query, 'itemId', 'item_id', 'id');
  const directItem = parseNumericId(directItemRaw);

  if (directItem) {
    return {
      entityTypeId: directEntity != null ? parseInt(String(directEntity), 10) : null,
      itemId: directItem,
      event: body?.event,
      source: 'direct',
    };
  }

  const fromDoc = parseDocumentId(body?.document_id || body?.documentId);
  if (fromDoc.itemId) {
    return { ...fromDoc, event: body?.event, source: 'document_id' };
  }

  const fromEvent = parseBitrixEventPayload(body);
  if (fromEvent.itemId) {
    return { ...fromEvent, source: 'bitrix_event' };
  }

  const flatId = pick(body, 'data[FIELDS][ID]', 'data[FIELDS_AFTER][ID]');
  const flatItem = parseNumericId(flatId);
  if (flatItem) {
    return {
      entityTypeId: directEntity != null ? parseInt(String(directEntity), 10) : null,
      itemId: flatItem,
      event: body?.event,
      source: 'flat_fields',
    };
  }

  return null;
}

module.exports = { parseWebhookPayload, parseDocumentId };
