import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

loadDotEnv(path.join(rootDir, '.env'));

const token = process.env.MAX_BOT_TOKEN;
const apiBase = process.env.MAX_API_BASE || 'https://platform-api.max.ru';
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const webhookSecret = process.env.MAX_WEBHOOK_SECRET || '';
const webhookUrl = process.argv[2] || (publicBaseUrl ? `${publicBaseUrl}/max/webhook` : '');

if (!token) {
  fail('MAX_BOT_TOKEN is empty. Add it to max-bot/.env first.');
}

if (!webhookUrl) {
  fail('Provide webhook URL: npm run subscribe -- https://your-domain.com/max/webhook');
}

const response = await fetch(new URL('/subscriptions', apiBase), {
  method: 'POST',
  headers: {
    Authorization: token,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    url: webhookUrl,
    secret: webhookSecret || undefined
  })
});

const body = await response.text();
if (!response.ok) {
  fail(`MAX API error ${response.status}: ${body}`);
}

console.log(`Webhook subscribed: ${webhookUrl}`);
if (body) console.log(body);

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(rawValue.trim());
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
