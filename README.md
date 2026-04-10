# WHMineBot 🤖⛏️

Telegram-бот для постоянного подключения к Minecraft-серверу. Держит бесплатные сервера живыми, пока ты не онлайн.

## Возможности

| Функция | Бесплатно | Premium |
|---|---|---|
| Бот на сервере | до 72 часов | постоянно |
| Анти-АФК | ✅ | ✅ |
| Панель управления | ✅ | ✅ |
| Запрос ОП + Креатив | ✅ | ✅ |
| Управление движением (WASD) | ❌ | ✅ |
| Слежка за игроком | ❌ | ✅ |
| Чат-мост TG ↔ MC | ❌ | ✅ |
| Лог действий | ❌ | ✅ |

**Тарифы:** Monthly — 29 Stars/мес, Eternal — 89 Stars (навсегда).  
Оплата: Telegram Stars / CryptoBot (USDT) / Карта BY.

---

## Быстрый старт

### 1. Получи токен бота

У [@BotFather](https://t.me/BotFather) создай бота командой `/newbot`.

### 2. Узнай свой Telegram ID

Напиши [@userinfobot](https://t.me/userinfobot) — он покажет твой числовой ID.

### 3. Настрой .env

```bash
cp .env.example .env
# Открой .env и заполни BOT_TOKEN и ADMIN_ID
```

### 4. Установи зависимости и запусти

```bash
npm install
npm start
```

---

## Деплой на Railway

1. Создай проект на [railway.app](https://railway.app)
2. Подключи этот GitHub репозиторий
3. В настройках Railway добавь переменные окружения из `.env.example`
4. Railway автоматически запустит бот через `railway.toml`

> ⚠️ **Важно:** SQLite-файл хранится в контейнере. На Railway Free база сбрасывается при редеплое.  
> Для продакшена добавь Volume и укажи путь в `DB_PATH`.

---

## Переменные окружения

| Переменная | Описание | Обязательная |
|---|---|---|
| `BOT_TOKEN` | Токен от @BotFather | ✅ |
| `ADMIN_ID` | Твой Telegram ID | ✅ |
| `CRYPTOBOT_TOKEN` | Токен от @CryptoBot → Pay | ❌ |
| `CARD_NUMBER` | Номер карты для BY-оплаты | ❌ |
| `CARD_HOLDER` | Имя держателя карты | ❌ |
| `CARD_MONTHLY_PRICE` | Цена Monthly картой | ❌ |
| `CARD_ETERNAL_PRICE` | Цена Eternal картой | ❌ |

---

## Поддерживаемые версии MC

`1.8.8` `1.9.4` `1.10.2` `1.11.2` `1.12.2` `1.13.2` `1.14.4` `1.15.2` `1.16.5` `1.17.1` `1.18.2` `1.19.4` `1.20.1` `1.20.4` `1.20.6` `1.21.1` `1.21.4` `26.1`

---

## Админ-команды

- `/admin` — открыть панель администратора
- Просмотр всех ботов и пользователей
- Выдача/отзыв Premium вручную
- Подтверждение оплат картой
- Рассылка всем пользователям

---

## Стек

- [mineflayer](https://github.com/PrismarineJS/mineflayer) — MC бот
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) — навигация
- [telegraf](https://github.com/telegraf/telegraf) — Telegram Bot API
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — база данных
- [express](https://expressjs.com/) — keep-alive HTTP
