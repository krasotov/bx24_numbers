#!/usr/bin/env node
/**
 * Bind numbering app to Bitrix24 left menu (LEFT_MENU placement).
 * Uses OAuth app credentials from vibecode-app/.env
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NUMBERING_APP_URL = 'https://app-41feb0ab6c14.vibecode.bitrix24.tech';
const PLACEMENT_TITLE = 'Нумерация ЭДО';
const API_URL = 'https://vibecode.bitrix24.tech';

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const signEnv = loadEnvFile(process.env.SIGN_ENV_FILE || '/Users/sergejkrasotov/vibecode-app/.env');
const appKey = signEnv.VIBE_API_KEY;
const sessionToken = signEnv.VIBE_SESSION_TOKEN;
const deployKey = signEnv.VIBE_DEPLOY_API_KEY || appKey;

if (!appKey?.startsWith('vibe_app_')) {
  console.error('Need vibe_app_ key in vibecode-app/.env');
  process.exit(1);
}
if (!sessionToken) {
  console.error('Need VIBE_SESSION_TOKEN — run: cd vibecode-app && npm run oauth:url && npm run oauth:poll');
  process.exit(1);
}

async function vibe(method, path, body, key = appKey, auth = sessionToken) {
  const headers = {
    'X-Api-Key': key,
    'Content-Type': 'application/json',
  };
  if (auth) headers.Authorization = `Bearer ${auth}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(JSON.stringify(json.error ?? json, null, 2));
  }
  return json.data ?? json;
}

async function findOrCreateNumberingApp() {
  const apps = await vibe('GET', '/v1/apps', undefined, deployKey, null);
  const list = Array.isArray(apps) ? apps : apps.items ?? [];
  const existing = list.find(
    (a) => a.appUrl?.includes('app-41feb0ab6c14') || a.title?.includes('Нумерация'),
  );
  if (existing) {
    console.log('Found app:', existing.id, existing.title, existing.appUrl);
    return existing;
  }

  console.log('Creating OAuth app for numbering...');
  const created = await vibe(
    'POST',
    '/v1/apps',
    {
      title: PLACEMENT_TITLE,
      appUrl: NUMBERING_APP_URL,
      redirectUris: [
        'https://vibecode.bitrix24.tech/oauth/complete',
        `${NUMBERING_APP_URL}/oauth/callback`,
        NUMBERING_APP_URL,
      ],
    },
    appKey,
    sessionToken,
  );
  console.log('Created app:', created.id);
  return created;
}

async function bindLeftMenu(appKeyForBind) {
  const handler = `${API_URL}/v1/bitrix-handler`;
  const result = await vibe(
    'POST',
    '/v1/placements/bind',
    {
      placement: 'LEFT_MENU',
      handler,
      title: PLACEMENT_TITLE,
    },
    appKeyForBind,
    sessionToken,
  );
  console.log('LEFT_MENU bound:', JSON.stringify(result, null, 2));
}

async function main() {
  const app = await findOrCreateNumberingApp();
  const bindKey = app.apiKey || app.key || appKey;

  // Update app URL if needed
  if (app.appUrl !== NUMBERING_APP_URL) {
    await vibe(
      'PATCH',
      `/v1/apps/${app.id}`,
      { appUrl: NUMBERING_APP_URL },
      appKey,
      sessionToken,
    );
    console.log('Updated appUrl to', NUMBERING_APP_URL);
  }

  await bindLeftMenu(bindKey);

  // Open access on numbering server
  try {
    await vibe(
      'PATCH',
      '/v1/infra/servers/fe72eceb-cd67-4940-b660-acd702108f47/access-policy',
      { accessPolicy: 'PORTAL' },
      deployKey,
      null,
    );
    console.log('Server access policy set to PORTAL');
  } catch (e) {
    console.warn('Could not update access policy:', e.message);
  }

  console.log('\nDone! Refresh Bitrix24 — item should appear in left menu.');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
