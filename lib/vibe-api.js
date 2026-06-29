'use strict';

const BASE_URL = process.env.VIBE_BASE_URL || 'https://vibecode.bitrix24.tech/v1';

class VibeApi {
  constructor(apiKey, sessionToken) {
    this.apiKey = apiKey;
    this.sessionToken = sessionToken;
  }

  headers() {
    const h = {
      'X-Api-Key': this.apiKey,
      'Content-Type': 'application/json',
    };
    if (this.sessionToken) {
      h.Authorization = this.sessionToken.startsWith('Bearer ')
        ? this.sessionToken
        : `Bearer ${this.sessionToken}`;
    }
    return h;
  }

  async request(method, path, body) {
    const opts = { method, headers: this.headers() };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${BASE_URL}${path}`, opts);
    const json = await res.json().catch(() => ({}));

    if (!res.ok || json.success === false) {
      const msg = json.error?.message || json.error?.code || res.statusText;
      throw new Error(`${method} ${path}: ${msg}`);
    }
    return json.data ?? json;
  }

  getUser(id) {
    return this.request('GET', `/users/${id}`);
  }

  getDepartment(id) {
    return this.request('GET', `/departments/${id}`);
  }

  listDepartments() {
    // По умолчанию API отдаёт limit=50; limit>5000 собирает все страницы на стороне Vibe
    return this.request('GET', '/departments?limit=5000&select=id,name,parentId,sort');
  }

  listSmartProcesses() {
    return this.request('GET', '/smart-processes');
  }

  getItemFields(entityTypeId) {
    return this.request('GET', `/items/${entityTypeId}/fields`);
  }

  getItem(entityTypeId, id) {
    return this.request('GET', `/items/${entityTypeId}/${id}`);
  }

  updateItem(entityTypeId, id, fields) {
    return this.request('PATCH', `/items/${entityTypeId}/${id}`, fields);
  }

  searchItems(entityTypeId, filter, options = {}) {
    return this.request('POST', `/items/${entityTypeId}/search`, {
      filter: filter || {},
      order: { updatedTime: 'DESC' },
      limit: options.limit || 50,
    });
  }
}

module.exports = { VibeApi };
