# Бесплатный запуск через Cloudflare Workers

Этот вариант нужен, чтобы бот работал без VPS и без включенного компьютера.

## Что получится

```text
MAX -> Cloudflare Worker -> клиенту или оператору
Сайт -> Cloudflare Worker -> заявка оператору в MAX
```

## 1. Войти в Cloudflare

Сначала перейдите в папку бота:

```bash
cd "/Users/elenapapina/Desktop/вся работа/my-company/papina-portfolio/max-bot"
```

Потом запустите вход:

```bash
npm run cf:login
```

Откроется браузер. Войдите в Cloudflare и разрешите Wrangler доступ.

## 2. Создать KV-хранилище

```bash
npm run cf:kv
```

Команда вернет блок примерно такого вида:

```toml
[[kv_namespaces]]
binding = "PAPINA_BOT_STATE"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Скопируйте `id` и замените `REPLACE_WITH_KV_NAMESPACE_ID` в `max-bot/wrangler.toml`.

## 3. Добавить секреты

```bash
npx wrangler secret put MAX_BOT_TOKEN
npx wrangler secret put OPERATOR_SETUP_CODE
npx wrangler secret put MAX_WEBHOOK_SECRET
```

Что вводить:

```text
MAX_BOT_TOKEN       новый токен бота MAX
OPERATOR_SETUP_CODE papina-operator-2026
MAX_WEBHOOK_SECRET  любая длинная случайная строка
```

`OPERATOR_USER_ID = "34533394"` уже указан в `wrangler.toml`, поэтому бот сразу знает, куда слать заявки.

## 4. Задеплоить

```bash
npm run cf:deploy
```

В конце Wrangler покажет адрес вида:

```text
https://papina-max-bot.papina.workers.dev
```

Проверьте:

```bash
curl https://papina-max-bot.papina.workers.dev/health
```

## 5. Подключить webhook MAX

В `max-bot/.env` временно заполните:

```env
PUBLIC_BASE_URL=https://papina-max-bot.papina.workers.dev
MAX_WEBHOOK_SECRET=та_же_строка_что_в_Cloudflare
```

Потом выполните:

```bash
npm run subscribe
```

После этого клиентские сообщения в MAX будут приходить в Cloudflare Worker.

## 6. Подключить сайт

В `index.html` найдите:

```js
const BOT_API_URL = window.PAPINA_BOT_API_URL || '';
```

Замените на:

```js
const BOT_API_URL = window.PAPINA_BOT_API_URL || 'https://papina-max-bot.papina.workers.dev';
```

Теперь заявки с сайта будут уходить через Worker в MAX.

## Если что-то не работает

Проверить здоровье Worker:

```bash
curl https://papina-max-bot.papina.workers.dev/health
```

Посмотреть логи:

```bash
npm run cf:tail
```
