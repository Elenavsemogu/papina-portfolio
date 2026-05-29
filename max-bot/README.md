# MAX bot backend for Papina

Этот backend делает три вещи:

1. Принимает webhook от бота MAX.
2. Отправляет заявки с сайта в личные сообщения оператору.
3. Переводит сложные диалоги на оператора через команды `/take`, `/reply`, `/close`.

Токен нельзя хранить в `index.html` или другом браузерном коде. Он должен быть только в `.env` на сервере.

## 1. Создайте `.env`

Скопируйте пример:

```bash
cd max-bot
cp .env.example .env
```

Откройте `max-bot/.env` и заполните:

```env
MAX_BOT_TOKEN=новый_токен_бота_MAX
MAX_API_BASE=https://platform-api.max.ru
PUBLIC_BASE_URL=https://ваш-backend-домен.ru
MAX_WEBHOOK_SECRET=любая_длинная_случайная_строка
OPERATOR_SETUP_CODE=секретный_код_для_вас
SITE_ORIGINS=https://papina.team,http://localhost:8000,http://127.0.0.1:8000
PORT=3000
HOST=127.0.0.1
```

Если пока не знаете свой `OPERATOR_USER_ID`, оставьте его пустым.

На обычном VPS или некоторых хостингах может понадобиться `HOST=0.0.0.0`.

## 2. Запустите локально

Для теста на компьютере без домена запустите Long Polling:

```bash
npm run poll
```

Оставьте этот терминал открытым, пока тестируете бота.

Для режима backend-сервера:

```bash
npm start
```

Проверка:

```bash
curl http://localhost:3000/health
```

## 3. Подключите себя как оператора

1. Откройте личный аккаунт MAX.
2. Найдите своего бота и напишите ему:

```text
/operator ваш_секретный_код_из_OPERATOR_SETUP_CODE
```

Бот ответит, что вы подключены как оператор, и сохранит ваш `user_id`.

## 4. Поставьте webhook

Для webhook нужен публичный HTTPS-домен backend-а. После деплоя выполните:

```bash
npm run subscribe -- https://ваш-backend-домен.ru/max/webhook
```

Если `PUBLIC_BASE_URL` уже заполнен, можно так:

```bash
npm run subscribe
```

## 5. Подключите форму сайта

В `index.html` есть строка:

```js
const BOT_API_URL = window.PAPINA_BOT_API_URL || '';
```

Для production нужно задать URL backend-а одним из двух способов.

Первый способ: заменить строку на:

```js
const BOT_API_URL = window.PAPINA_BOT_API_URL || 'https://ваш-backend-домен.ru';
```

Второй способ: добавить перед основным скриптом сайта:

```html
<script>
  window.PAPINA_BOT_API_URL = 'https://ваш-backend-домен.ru';
</script>
```

## Команды оператора

```text
/reply CLIENT_ID текст ответа
/take CLIENT_ID
/close CLIENT_ID
/id
/help
```

Когда клиент попросит человека или бот не сможет уверенно ответить, вам придет сообщение с `CLIENT_ID` и готовой командой для ответа.

## Важная безопасность

Токен, который уже попадал в чат или в публичный HTML, нужно перевыпустить. Старый токен считайте раскрытым.
