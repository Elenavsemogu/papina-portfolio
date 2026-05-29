import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const statePath = path.join(dataDir, 'state.json');

loadDotEnv(path.join(rootDir, '.env'));

const config = {
  port: Number(process.env.PORT || 3000),
  maxApiBase: process.env.MAX_API_BASE || 'https://platform-api.max.ru',
  token: process.env.MAX_BOT_TOKEN || '',
  webhookSecret: process.env.MAX_WEBHOOK_SECRET || '',
  operatorUserId: process.env.OPERATOR_USER_ID || '',
  operatorSetupCode: process.env.OPERATOR_SETUP_CODE || '',
  host: process.env.HOST || '127.0.0.1',
  siteOrigins: parseOrigins(process.env.SITE_ORIGINS || '*')
};

const state = await loadState();
if (config.operatorUserId && !state.operatorUserId) {
  state.operatorUserId = String(config.operatorUserId);
  await saveState();
}

if (process.argv.includes('--poll')) {
  await startPolling();
} else {
  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { ok: false, error: 'internal_error' });
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(`MAX bot backend is running on http://${config.host}:${config.port}`);
    if (!config.token) {
      console.warn('MAX_BOT_TOKEN is empty. Create max-bot/.env before using the bot.');
    }
  });
}

async function startPolling() {
  if (!config.token) {
    console.warn('MAX_BOT_TOKEN is empty. Create max-bot/.env before using the bot.');
    process.exitCode = 1;
    return;
  }

  console.log('MAX bot is listening with Long Polling.');
  console.log('Open MAX, send a message to your bot, or send /operator YOUR_CODE to connect yourself as operator.');

  let marker = state.pollMarker ?? null;

  while (true) {
    try {
      const result = await getUpdates(marker);
      marker = result.marker ?? marker;
      state.pollMarker = marker;
      await saveState();

      for (const update of result.updates || []) {
        await handleUpdate(update);
      }
    } catch (error) {
      console.error('Long polling failed:', error.message);
      await sleep(5000);
    }
  }
}

async function route(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    setCorsHeaders(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      operatorConfigured: Boolean(getOperatorUserId()),
      maxTokenConfigured: Boolean(config.token)
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/lead') {
    setCorsHeaders(req, res);
    await handleLeadRequest(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/max/webhook') {
    await handleWebhook(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not_found' });
}

async function handleLeadRequest(req, res) {
  if (!isAllowedOrigin(req.headers.origin)) {
    sendJson(res, 403, { ok: false, error: 'origin_not_allowed' });
    return;
  }

  const body = await readJson(req);
  if (body.company) {
    sendJson(res, 200, { ok: true });
    return;
  }

  const website = normalizeWebsite(body.website);
  const contact = cleanText(body.contact || body.phone || body.telegram || '', 300);
  const page = cleanText(body.page || '', 500);

  if (!website) {
    sendJson(res, 400, { ok: false, error: 'website_required' });
    return;
  }

  const operatorUserId = getOperatorUserId();
  if (!operatorUserId) {
    sendJson(res, 503, { ok: false, error: 'operator_not_configured' });
    return;
  }

  const text = [
    'Новая заявка с сайта',
    '',
    `Сайт: ${website}`,
    `Контакт: ${contact || 'не указан'}`,
    page ? `Страница: ${page}` : '',
    `Дата: ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Barnaul' })}`
  ].filter(Boolean).join('\n');

  await sendMaxMessage({ userId: operatorUserId, text });
  sendJson(res, 200, { ok: true });
}

async function handleWebhook(req, res) {
  if (config.webhookSecret) {
    const incomingSecret = req.headers['x-max-bot-api-secret'];
    if (incomingSecret !== config.webhookSecret) {
      sendJson(res, 401, { ok: false, error: 'bad_webhook_secret' });
      return;
    }
  }

  const update = await readJson(req);
  sendJson(res, 200, { ok: true });

  handleUpdate(update).catch((error) => {
    console.error('Webhook update failed:', error);
  });
}

async function handleUpdate(update) {
  const message = extractMessage(update);
  if (!message.text || !message.senderId) {
    if (process.argv.includes('--poll')) {
      console.log(`Skipped update without text sender: ${update.update_type || update.type || 'unknown'}`);
    }
    return;
  }

  const senderId = String(message.senderId);
  const text = message.text.trim();
  if (process.argv.includes('--poll')) {
    console.log(`Incoming message from ${senderId}: ${text}`);
  }

  if (await handleOperatorSetup(senderId, text)) return;

  const operatorUserId = getOperatorUserId();
  if (operatorUserId && senderId === String(operatorUserId)) {
    await handleOperatorCommand(text);
    return;
  }

  await handleClientMessage(senderId, text, message.chatId);
}

async function handleOperatorSetup(senderId, text) {
  if (!text.toLowerCase().startsWith('/operator')) {
    return false;
  }

  const [, code = ''] = text.split(/\s+/, 2);
  if (!config.operatorSetupCode || code !== config.operatorSetupCode) {
    await sendMaxMessage({
      userId: senderId,
      text: 'Код оператора не подошел. Проверьте OPERATOR_SETUP_CODE в .env.'
    });
    return true;
  }

  state.operatorUserId = senderId;
  await saveState();
  await sendMaxMessage({
    userId: senderId,
    text: `Готово. Вы подключены как оператор. Ваш user_id: ${senderId}`
  });
  return true;
}

async function handleOperatorCommand(text) {
  const [command, clientId, ...rest] = text.split(/\s+/);
  const lowerCommand = command.toLowerCase();

  if (lowerCommand === '/id') {
    await sendMaxMessage({
      userId: getOperatorUserId(),
      text: `Ваш user_id: ${getOperatorUserId()}`
    });
    return;
  }

  if (lowerCommand === '/help') {
    await sendOperatorHelp();
    return;
  }

  if (lowerCommand === '/take') {
    await takeDialog(clientId);
    return;
  }

  if (lowerCommand === '/close') {
    await closeDialog(clientId);
    return;
  }

  if (lowerCommand === '/reply') {
    const replyText = rest.join(' ').trim();
    await replyToClient(clientId, replyText);
    return;
  }

  await sendOperatorHelp('Не узнала команду.');
}

async function takeDialog(clientId) {
  const dialog = getDialog(clientId);
  if (!dialog) {
    await sendMaxMessage({ userId: getOperatorUserId(), text: 'Диалог не найден.' });
    return;
  }

  dialog.status = 'operator';
  await saveState();
  await sendMaxMessage({
    userId: clientId,
    text: 'Подключаю специалиста. Она ответит здесь же в чате.'
  });
  await sendMaxMessage({
    userId: getOperatorUserId(),
    text: `Диалог ${clientId} переведен на оператора. Ответ: /reply ${clientId} текст`
  });
}

async function closeDialog(clientId) {
  const dialog = getDialog(clientId);
  if (!dialog) {
    await sendMaxMessage({ userId: getOperatorUserId(), text: 'Диалог не найден.' });
    return;
  }

  dialog.status = 'bot';
  await saveState();
  await sendMaxMessage({
    userId: clientId,
    text: 'Спасибо. Если появятся вопросы, напишите сюда.'
  });
  await sendMaxMessage({
    userId: getOperatorUserId(),
    text: `Диалог ${clientId} закрыт. Бот снова отвечает сам.`
  });
}

async function replyToClient(clientId, replyText) {
  if (!clientId || !replyText) {
    await sendMaxMessage({
      userId: getOperatorUserId(),
      text: 'Формат: /reply CLIENT_ID текст ответа'
    });
    return;
  }

  await sendMaxMessage({ userId: clientId, text: replyText });
  const dialog = getDialog(clientId);
  if (dialog) {
    dialog.status = 'operator';
    dialog.updatedAt = new Date().toISOString();
    dialog.messages.push({ from: 'operator', text: replyText, at: dialog.updatedAt });
    await saveState();
  }
}

async function handleClientMessage(senderId, text, chatId) {
  const dialog = ensureDialog(senderId, chatId);
  const now = new Date().toISOString();
  dialog.updatedAt = now;
  dialog.messages.push({ from: 'client', text, at: now });
  dialog.messages = dialog.messages.slice(-20);

  const operatorUserId = getOperatorUserId();
  const needsOperator = shouldEscalate(text) || dialog.status === 'operator';

  if (needsOperator) {
    dialog.status = 'operator';
    await saveState();

    if (operatorUserId) {
      await notifyOperatorAboutClient(senderId, text, dialog);
    }

    await sendMaxMessage({
      userId: senderId,
      text: 'Я передала сообщение специалисту. Она подключится и ответит здесь.'
    });
    return;
  }

  const answer = buildBotAnswer(text);
  await saveState();
  await sendMaxMessage({ userId: senderId, text: answer });
}

async function notifyOperatorAboutClient(senderId, text, dialog) {
  const history = dialog.messages
    .slice(-6)
    .map((item) => `${item.from === 'client' ? 'Клиент' : 'Оператор'}: ${item.text}`)
    .join('\n');

  await sendMaxMessage({
    userId: getOperatorUserId(),
    text: [
      `Нужен ответ клиенту ${senderId}`,
      '',
      `Последнее сообщение: ${text}`,
      '',
      history ? `История:\n${history}` : '',
      '',
      `Ответить: /reply ${senderId} текст`,
      `Закрыть: /close ${senderId}`
    ].filter(Boolean).join('\n')
  });
}

function buildBotAnswer(text) {
  const normalized = text.toLowerCase();

  if (hasAny(normalized, ['цена', 'стоимость', 'сколько', 'прайс', 'руб'])) {
    return [
      'По сайту ориентиры такие: аудит + прототип от 25 000 руб., экспресс-обновление от 50 000 руб., полный редизайн от 120 000 руб.',
      'Точную стоимость считаем после ссылки на сайт. Пришлите адрес сайта и удобный контакт.'
    ].join('\n\n');
  }

  if (hasAny(normalized, ['срок', 'долго', 'когда', 'дней'])) {
    return 'Обычно аудит и прототип занимают около 3 дней, экспресс-обновление около 7 дней, полный редизайн обсуждаем по объему. Пришлите ссылку на сайт, и мы сориентируем точнее.';
  }

  if (hasAny(normalized, ['аудит', 'провер', 'разбор'])) {
    return 'Можем посмотреть скорость, структуру, мобильную версию, SEO и точки, где сайт теряет заявки. Пришлите ссылку на сайт и контакт для связи.';
  }

  if (hasAny(normalized, ['сайт', 'лендинг', 'редизайн', 'дизайн'])) {
    return 'Да, занимаемся модернизацией сайтов, лендингами и редизайном. Чтобы начать, пришлите ссылку на текущий сайт и коротко напишите, что хотите улучшить.';
  }

  if (hasAny(normalized, ['бренд', 'логотип', 'айдентика'])) {
    return 'По брендингу можем сделать логотип, цвета, типографику и правила использования. Напишите, для какого бизнеса нужен бренд и есть ли уже материалы.';
  }

  return 'Спасибо, я передам вопрос специалисту, если не смогу ответить точно. Чтобы быстрее помочь, пришлите ссылку на сайт и удобный контакт.';
}

function shouldEscalate(text) {
  const normalized = text.toLowerCase();
  return hasAny(normalized, [
    'оператор',
    'человек',
    'специалист',
    'менеджер',
    'позвоните',
    'перезвоните',
    'не понял',
    'не понимаю',
    'сложно',
    'договор',
    'счет',
    'оплата',
    'жалоба'
  ]);
}

function hasAny(text, words) {
  return words.some((word) => text.includes(word));
}

function ensureDialog(userId, chatId) {
  const key = String(userId);
  if (!state.dialogs[key]) {
    state.dialogs[key] = {
      userId: key,
      chatId: chatId ? String(chatId) : '',
      status: 'bot',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }
  return state.dialogs[key];
}

function getDialog(userId) {
  if (!userId) return null;
  return state.dialogs[String(userId)] || null;
}

function getOperatorUserId() {
  return state.operatorUserId || config.operatorUserId || '';
}

async function sendOperatorHelp(prefix = '') {
  await sendMaxMessage({
    userId: getOperatorUserId(),
    text: [
      prefix,
      'Команды оператора:',
      '/reply CLIENT_ID текст - ответить клиенту',
      '/take CLIENT_ID - перевести диалог на себя',
      '/close CLIENT_ID - закрыть диалог',
      '/id - показать ваш user_id'
    ].filter(Boolean).join('\n')
  });
}

async function sendMaxMessage({ userId, chatId, text }) {
  if (!config.token) {
    throw new Error('MAX_BOT_TOKEN is not configured');
  }

  const url = new URL('/messages', config.maxApiBase);
  if (userId) url.searchParams.set('user_id', String(userId));
  if (chatId) url.searchParams.set('chat_id', String(chatId));

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: config.token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MAX API error ${response.status}: ${body}`);
  }

  return response.json().catch(() => ({}));
}

async function getUpdates(marker) {
  const url = new URL('/updates', config.maxApiBase);
  url.searchParams.set('timeout', '30');
  url.searchParams.set('limit', '50');
  if (marker) {
    url.searchParams.set('marker', String(marker));
  }

  const response = await fetch(url, {
    headers: {
      Authorization: config.token
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MAX updates error ${response.status}: ${body}`);
  }

  return response.json();
}

function extractMessage(update) {
  const message =
    update.message ||
    update.update?.message ||
    update.payload?.message ||
    update.body?.message ||
    update.event?.message ||
    {};

  const sender =
    message.sender ||
    message.from ||
    message.author ||
    message.user ||
    update.user ||
    update.sender ||
    {};

  const chat = message.chat || message.recipient || update.chat || {};
  const body = message.body || message.content || {};

  return {
    text: cleanText(message.text || body.text || update.text || '', 4000),
    senderId: sender.user_id || sender.id || message.sender_id || message.user_id || update.user_id,
    chatId: chat.chat_id || chat.id || message.chat_id || update.chat_id
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) {
      throw new Error('Request body is too large');
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    Connection: 'close'
  });
  res.end(body);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function isAllowedOrigin(origin) {
  if (config.siteOrigins.includes('*')) return true;
  if (!origin) return false;
  return config.siteOrigins.includes(origin);
}

function parseOrigins(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeWebsite(value) {
  const raw = cleanText(value || '', 500);
  if (!raw) return '';

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withProtocol);
    if (!url.hostname.includes('.')) return '';
    return url.href;
  } catch {
    return '';
  }
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

async function loadState() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(statePath)) {
    return { operatorUserId: '', dialogs: {} };
  }

  try {
    const raw = await readFile(statePath, 'utf8');
    return { operatorUserId: '', dialogs: {}, ...JSON.parse(raw) };
  } catch {
    return { operatorUserId: '', dialogs: {} };
  }
}

async function saveState() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
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
