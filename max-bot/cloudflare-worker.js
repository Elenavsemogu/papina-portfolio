const MAX_API_BASE = 'https://platform-api.max.ru';

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: 'internal_error' }, 500);
    }
  }
};

async function route(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return withCors(request, new Response(null, { status: 204 }), env);
  }

  if (request.method === 'GET' && url.pathname === '/') {
    return json({
      ok: true,
      service: 'papina-max-bot',
      endpoints: ['/health', '/api/lead', '/max/webhook']
    });
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    const operatorUserId = await getOperatorUserId(env);
    return json({
      ok: true,
      operatorConfigured: Boolean(operatorUserId),
      maxTokenConfigured: Boolean(env.MAX_BOT_TOKEN)
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/lead') {
    return withCors(request, await handleLead(request, env), env);
  }

  if (request.method === 'POST' && url.pathname === '/max/webhook') {
    if (env.MAX_WEBHOOK_SECRET) {
      const incomingSecret = request.headers.get('x-max-bot-api-secret');
      if (incomingSecret !== env.MAX_WEBHOOK_SECRET) {
        return json({ ok: false, error: 'bad_webhook_secret' }, 401);
      }
    }

    const update = await readJson(request);
    ctx.waitUntil(handleUpdate(update, env));
    return json({ ok: true });
  }

  return json({ ok: false, error: 'not_found' }, 404);
}

async function handleLead(request, env) {
  if (!isAllowedOrigin(request.headers.get('origin'), env)) {
    return json({ ok: false, error: 'origin_not_allowed' }, 403);
  }

  const body = await readJson(request);
  if (body.company) {
    return json({ ok: true });
  }

  const website = normalizeWebsite(body.website);
  const contact = cleanText(body.contact || body.phone || body.telegram || '', 300);
  const page = cleanText(body.page || '', 500);

  if (!website) {
    return json({ ok: false, error: 'website_required' }, 400);
  }

  const operatorUserId = await getOperatorUserId(env);
  if (!operatorUserId) {
    return json({ ok: false, error: 'operator_not_configured' }, 503);
  }

  const text = [
    'Новая заявка с сайта',
    '',
    `Сайт: ${website}`,
    `Контакт: ${contact || 'не указан'}`,
    page ? `Страница: ${page}` : '',
    `Дата: ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Barnaul' })}`
  ].filter(Boolean).join('\n');

  await sendMaxMessage(env, { userId: operatorUserId, text });
  return json({ ok: true });
}

async function handleUpdate(update, env) {
  const message = extractMessage(update);
  if (!message.text || !message.senderId) {
    return;
  }

  const senderId = String(message.senderId);
  const text = message.text.trim();

  if (await handleOperatorSetup(env, senderId, text)) return;

  const operatorUserId = await getOperatorUserId(env);
  if (operatorUserId && senderId === String(operatorUserId)) {
    await handleOperatorCommand(env, text);
    return;
  }

  await handleClientMessage(env, senderId, text, message.chatId);
}

async function handleOperatorSetup(env, senderId, text) {
  if (!text.toLowerCase().startsWith('/operator')) {
    return false;
  }

  const [, code = ''] = text.split(/\s+/, 2);
  if (!env.OPERATOR_SETUP_CODE || code !== env.OPERATOR_SETUP_CODE) {
    await sendMaxMessage(env, {
      userId: senderId,
      text: 'Код оператора не подошел. Проверьте OPERATOR_SETUP_CODE в Cloudflare secrets.'
    });
    return true;
  }

  await env.PAPINA_BOT_STATE.put('operatorUserId', senderId);
  await sendMaxMessage(env, {
    userId: senderId,
    text: `Готово. Вы подключены как оператор. Ваш user_id: ${senderId}`
  });
  return true;
}

async function handleOperatorCommand(env, text) {
  const [command = '', clientId = '', ...rest] = text.split(/\s+/);
  const lowerCommand = command.toLowerCase();

  if (lowerCommand === '/id') {
    await sendMaxMessage(env, {
      userId: await getOperatorUserId(env),
      text: `Ваш user_id: ${await getOperatorUserId(env)}`
    });
    return;
  }

  if (lowerCommand === '/help') {
    await sendOperatorHelp(env);
    return;
  }

  if (lowerCommand === '/take') {
    await takeDialog(env, clientId);
    return;
  }

  if (lowerCommand === '/close') {
    await closeDialog(env, clientId);
    return;
  }

  if (lowerCommand === '/reply') {
    await replyToClient(env, clientId, rest.join(' ').trim());
    return;
  }

  await sendOperatorHelp(env, 'Не узнала команду.');
}

async function takeDialog(env, clientId) {
  const dialog = await getDialog(env, clientId);
  if (!dialog) {
    await sendMaxMessage(env, { userId: await getOperatorUserId(env), text: 'Диалог не найден.' });
    return;
  }

  dialog.status = 'operator';
  dialog.updatedAt = new Date().toISOString();
  await saveDialog(env, clientId, dialog);

  await sendMaxMessage(env, {
    userId: clientId,
    text: 'Подключаю специалиста. Она ответит здесь же в чате.'
  });
  await sendMaxMessage(env, {
    userId: await getOperatorUserId(env),
    text: `Диалог ${clientId} переведен на оператора. Ответ: /reply ${clientId} текст`
  });
}

async function closeDialog(env, clientId) {
  const dialog = await getDialog(env, clientId);
  if (!dialog) {
    await sendMaxMessage(env, { userId: await getOperatorUserId(env), text: 'Диалог не найден.' });
    return;
  }

  dialog.status = 'bot';
  dialog.updatedAt = new Date().toISOString();
  await saveDialog(env, clientId, dialog);

  await sendMaxMessage(env, {
    userId: clientId,
    text: 'Спасибо. Если появятся вопросы, напишите сюда.'
  });
  await sendMaxMessage(env, {
    userId: await getOperatorUserId(env),
    text: `Диалог ${clientId} закрыт. Бот снова отвечает сам.`
  });
}

async function replyToClient(env, clientId, replyText) {
  if (!clientId || !replyText) {
    await sendMaxMessage(env, {
      userId: await getOperatorUserId(env),
      text: 'Формат: /reply CLIENT_ID текст ответа'
    });
    return;
  }

  await sendMaxMessage(env, { userId: clientId, text: replyText });

  const dialog = await getDialog(env, clientId);
  if (dialog) {
    const now = new Date().toISOString();
    dialog.status = 'operator';
    dialog.updatedAt = now;
    dialog.messages.push({ from: 'operator', text: replyText, at: now });
    dialog.messages = dialog.messages.slice(-20);
    await saveDialog(env, clientId, dialog);
  }
}

async function handleClientMessage(env, senderId, text, chatId) {
  const dialog = await ensureDialog(env, senderId, chatId);
  const now = new Date().toISOString();
  dialog.updatedAt = now;
  dialog.messages.push({ from: 'client', text, at: now });
  dialog.messages = dialog.messages.slice(-20);

  const operatorUserId = await getOperatorUserId(env);
  const needsOperator = shouldEscalate(text) || dialog.status === 'operator';

  if (needsOperator) {
    dialog.status = 'operator';
    await saveDialog(env, senderId, dialog);

    if (operatorUserId) {
      await notifyOperatorAboutClient(env, senderId, text, dialog);
    }

    await sendMaxMessage(env, {
      userId: senderId,
      text: 'Я передала сообщение специалисту. Она подключится и ответит здесь.'
    });
    return;
  }

  await saveDialog(env, senderId, dialog);
  await sendMaxMessage(env, { userId: senderId, text: buildBotAnswer(text) });
}

async function notifyOperatorAboutClient(env, senderId, text, dialog) {
  const history = dialog.messages
    .slice(-6)
    .map((item) => `${item.from === 'client' ? 'Клиент' : 'Оператор'}: ${item.text}`)
    .join('\n');

  await sendMaxMessage(env, {
    userId: await getOperatorUserId(env),
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

async function sendOperatorHelp(env, prefix = '') {
  await sendMaxMessage(env, {
    userId: await getOperatorUserId(env),
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

async function sendMaxMessage(env, { userId, chatId, text }) {
  if (!env.MAX_BOT_TOKEN) {
    throw new Error('MAX_BOT_TOKEN is not configured');
  }

  const url = new URL('/messages', MAX_API_BASE);
  if (userId) url.searchParams.set('user_id', String(userId));
  if (chatId) url.searchParams.set('chat_id', String(chatId));

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: env.MAX_BOT_TOKEN,
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

async function getOperatorUserId(env) {
  return await env.PAPINA_BOT_STATE.get('operatorUserId') || env.OPERATOR_USER_ID || '';
}

async function ensureDialog(env, userId, chatId) {
  const dialog = await getDialog(env, userId);
  if (dialog) return dialog;

  return {
    userId: String(userId),
    chatId: chatId ? String(chatId) : '',
    status: 'bot',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function getDialog(env, userId) {
  if (!userId) return null;
  const raw = await env.PAPINA_BOT_STATE.get(`dialog:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveDialog(env, userId, dialog) {
  await env.PAPINA_BOT_STATE.put(`dialog:${userId}`, JSON.stringify(dialog));
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

async function readJson(request) {
  const raw = await request.text();
  if (!raw) return {};
  return JSON.parse(raw);
}

function withCors(request, response, env) {
  const origin = request.headers.get('origin');
  const headers = new Headers(response.headers);

  if (isAllowedOrigin(origin, env)) {
    headers.set('Access-Control-Allow-Origin', origin || '*');
    headers.set('Vary', 'Origin');
  }

  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(response.body, { status: response.status, headers });
}

function isAllowedOrigin(origin, env) {
  const origins = String(env.SITE_ORIGINS || '*').split(',').map((item) => item.trim()).filter(Boolean);
  if (origins.includes('*')) return true;
  if (!origin) return false;
  return origins.includes(origin);
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

function hasAny(text, words) {
  return words.some((word) => text.includes(word));
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}
