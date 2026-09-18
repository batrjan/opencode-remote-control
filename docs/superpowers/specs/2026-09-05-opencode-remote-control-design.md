# Дизайн: opencode-remote-control

## Обзор
Веб-зеркало сессии OpenCode через публичный relay-сервер с коротким кодом доступа. Позволяет пользователю поделиться интерактивной сессией OpenCode с любым человеком по 6-значному коду.

## Цели
- Пользователь может запустить `/remote-control start` в TUI и получить код + URL для веб-доступа.
- Веб-пользователь вводит код и получает официальный интерфейс OpenCode с полным взаимодействием.
- Сессия живёт до `/remote-control stop` или закрытия OpenCode.
- Защита от перебора короткого кода.
- Горизонтальное масштабирование relay-сервера.

## Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│                         Пользовательский ПК                       │
│  ┌─────────────┐         ┌─────────────┐         ┌───────────┐  │
│  │  OpenCode   │◄────────│   Bridge    │◄────────│   Skill   │  │
│  │  (TUI+server)│ SSE/REST │  (Node.js)  │  WS     │ (commands)│  │
│  │  127.0.0.1:PORT      │             │         │           │  │
│  └─────────────┘         └─────────────┘         └───────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                    │
                                    │ WSS
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                Relay-сервер (opencode.b4tr.net)                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Docker container: relay (Node.js + TypeScript)         │    │
│  │  - API: POST /api/sessions, DELETE /api/sessions/:id    │    │
│  │  - API: POST /api/activate (code → viewer_token)        │    │
│  │  - Proxy: /api/opencode/* → bridge (WS) → opencode     │    │
│  │  - Static: /join, /terminal (opencode web UI)          │    │
│  │  - WS: /bridge (bridge client)                         │    │
│  │  - In-memory store: sessions, codes, tokens, limits   │    │
│  └─────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  nginx (host) → proxy_pass 127.0.0.1:8080              │    │
│  │  certbot → TLS, auto-renew                              │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTPS
                                    ▼
                          ┌─────────────────┐
                          │   Веб-браузер   │
                          │  (viewer UI)    │
                          └─────────────────┘
```

## Компоненты

### 1. Relay-сервер (`relay/`)
Node.js + TypeScript, Express + ws.

**API для skill/bridge:**
- `POST /api/sessions` — создать сессию. Тело: `{ session_id, directory, title }`. Ответ: `{ session_id, access_code, bridge_token, viewer_url }`.
- `DELETE /api/sessions/:id` — завершить сессию. Требует `x-api-key`.

**API для веб-пользователя:**
- `POST /api/activate` — `{ code }` → `{ session_id, viewer_token }`. Устанавливает HttpOnly cookie.
- `GET /join` — страница ввода кода (HTML).
- `GET /terminal` — официальный opencode web UI (статика из `packages/app/dist`).
- `GET /health` — health check.

**WebSocket:**
- `/bridge?session_id=<id>&token=<bridge_token>` — для bridge-клиента.
- `/viewer?session_id=<id>&token=<viewer_token>` — для браузера (если нужен realtime).

**Прокси-адаптер:**
- `GET /api/opencode/session/:id/message?limit=N` → bridge → opencode `GET /session/:id/message`.
- `POST /api/opencode/session/:id/prompt_async` → bridge → opencode `POST /session/:id/prompt_async`.
- `GET /api/opencode/session/:id/todo` → bridge → opencode `GET /session/:id/todo`.
- `GET /api/opencode/session/:id/status` → bridge → opencode `GET /session/:id/status`.
- `GET /api/opencode/agent` → bridge → opencode `GET /agent`.
- `GET /api/opencode/config` → bridge → opencode `GET /config`.
- `GET /api/opencode/event` → bridge → opencode SSE `GET /event` (relay транслирует как SSE или WS).

**Безопасность прокси:**
- Allowlist эндпоинтов (только вышеуказанные).
- Принудительная подмена `:id` на session_id из viewer_token.
- Запрет на `/file*`, `/find*`, `/auth`, `/instance/*`, `/tui/*`, `/experimental/*`, `/config PATCH`.

**Хранение:**
- In-memory `SessionStore` с интерфейсом для будущей замены на Redis.
- Сессия: `{ id, directory, title, code_hash, code_salt, bridge_token_hash, viewer_tokens[], created_at, last_seen, status }`.
- Rate limiter: per-IP (5/мин, 50/час), per-code (10 неудачных → блок).

### 2. Bridge-клиент (`bridge/`)
Node.js + TypeScript, запускается как фоновый процесс скиллом.

**Функции:**
- Автодетект порта OpenCode: найти процесс opencode → LISTEN-порты → проверить `GET /global/health` с `OPENCODE_SERVER_PASSWORD`.
- Автовыбор сессии: `GET /session` → фильтр по `directory` (cwd) → самая свежая.
- Регистрация на relay: `POST /api/sessions` → получить `access_code`, `bridge_token`.
- Подключение к relay: `wss://relay/bridge?session_id=<id>&token=<bridge_token>`.
- SSE-подписка на `http://127.0.0.1:<port>/event` → пересылка в relay.
- Прокси-выполнение: получить от relay `{ type: "proxy", request_id, method, path, body }` → выполнить HTTP к opencode → вернуть `{ type: "proxy_response", request_id, status, headers, body }`.
- Watchdog: если opencode недоступен (health check fail или процесс умер) → завершить bridge.

**CLI:**
- `bridge start --relay <url> --api-key <key> [--port <opencode_port>] [--session-id <id>]`
- `bridge stop --relay <url> --session-id <id> --api-key <key>`
- `bridge status --relay <url> --session-id <id> --api-key <key>`

### 3. Skill и команды (`skill/`, `.opencode/commands/remote-control/`)

**Skill (`skill/SKILL.md`):**
- Инструкции агенту: как запустить bridge, как остановить, как проверить статус.
- Автоматический запуск при `/remote-control start`.
- Автоматическая остановка при `/remote-control stop`.

**Команды:**
- `.opencode/commands/remote-control/start.md` — шаблон: "Запусти remote control для этой сессии. Выполни: bridge start ... Сообщи пользователю код и URL."
- `.opencode/commands/remote-control/stop.md` — шаблон: "Останови remote control. Выполни: bridge stop ..."

## Безопасность

### Короткий код
- Формат: 6 символов из `[a-z0-9]` без `0`, `o`, `1`, `l` (32 символа, 32^6 ≈ 1 млрд комбинаций).
- Хранение: SHA-256 хэш с per-code солью.
- Генерация: криптографически стойкий генератор (crypto.randomBytes).

### Rate limiting
- Per-IP: 5 попыток/мин, 50 попыток/час.
- Per-code: 10 неудачных попыток глобально → код блокируется навсегда.
- Задержка: 1–2 секунды на неверный код.
- Ответ: единый для "код не найден" и "код заблокирован".

### Токены
- `bridge_token`: случайная строка 32 байта (base64url), хранится хэш.
- `viewer_token`: случайная строка 32 байта (base64url), хранится хэш.
- `viewer_token` передаётся в HttpOnly cookie (`Secure; SameSite=Strict`) и/или в теле ответа для сохранения в localStorage.

### Изоляция
- Все прокси-запросы жёстко привязаны к session_id из токена.
- Проверка принадлежности на каждом запросе.

### Транспорт
- HTTPS (TLS 1.2+) для всех HTTP-запросов.
- WSS для WebSocket.

## Жизненный цикл сессии

1. **Старт** (`/remote-control start`):
   - Агент запускает bridge с параметрами relay.
   - Bridge находит opencode, регистрирует сессию, получает код.
   - Bridge выводит код в stdout → агент сообщает пользователю.
   - Bridge подключается к relay и начинает трансляцию SSE.

2. **Подключение viewer**:
   - Пользователь открывает `https://opencode.b4tr.net/join`.
   - Вводит код → `POST /api/activate` → получает `viewer_token` и `session_id`.
   - Редирект на `/terminal` (официальный UI).
   - UI стучится на `location.origin/api/opencode/*` → relay проксирует через bridge → opencode.
   - UI подключается к SSE через relay.

3. **Стоп** (`/remote-control stop`):
   - Агент запускает bridge stop.
   - Bridge вызывает `DELETE /api/sessions/:id` на relay.
   - Relay отключает bridge, отзывает код и токены.
   - Viewers получают `session_closed`.

4. **Закрытие opencode**:
   - Watchdog bridge обнаруживает недоступность opencode.
   - Bridge завершается и уведомляет relay.
   - Relay помечает сессию как `closed` и отзывает код.

## Масштабирование

- Relay-сервер: stateless (кроме in-memory store), можно запускать несколько экземпляров за балансировщиком.
- In-memory store можно заменить на Redis (интерфейс `SessionStore` предусмотрен).
- nginx: sticky sessions для WebSocket (по cookie или IP hash).
- Оценка для 3000–5000 сессий: 4 vCPU / 8 GB RAM / 500 Мбит/с.

## Тестирование

### Unit-тесты (vitest)
- Генерация и хэширование кодов.
- Rate limiter (per-IP, per-code, блокировка).
- TTL и очистка сессий.
- Allowlist и session binding прокси-адаптера.
- Автодетект порта (мок процессов).

### Интеграционные тесты
- Запуск реального `opencode serve --port 0`.
- Запуск bridge → регистрация → активация кода.
- Проксирование `GET /session/:id/message`, `POST prompt_async`.
- SSE-трансляция.

### E2E-тесты
- Сборка и деплой официального UI.
- Открытие `/join`, ввод кода, редирект на `/terminal`.
- Проверка, что UI загружает данные через прокси.

## CI/CD

### GitHub Actions (`/.github/workflows/deploy.yml`)
- Триггер: push в `main`.
- Шаги:
  1. Сборка relay (TypeScript → Docker image).
  2. Сборка opencode web UI (bun install → bun run build → dist → в Docker image).
  3. Push в GHCR.
  4. SSH на сервер → `docker compose pull && docker compose up -d --force-recreate relay`.

### Docker (`relay/Dockerfile`)
- Multi-stage:
  - Stage 1: Node.js + bun для сборки UI.
  - Stage 2: Node.js + TypeScript для сборки сервера.
  - Stage 3: Node.js runtime + скопированные dist + node_modules.
- Health check: `curl -f http://localhost:8080/health`.

### docker-compose (`relay/docker-compose.yml`)
- `relay`: image из GHCR, порт 8080, env из `.env`.
- `nginx`: host network или bridge, конфиг из `nginx/opencode.b4tr.net.conf`.
- `certbot`: volumes для webroot, cron для renew.

## Риски и ограничения

- **Официальный UI может меняться** — при обновлении opencode нужно пересобрать UI. Решение: версионирование образа relay, привязка к конкретной версии opencode.
- **Большой бандл UI** (~2.7MB gzip) — приемлемо для первого захода, можно добавить code splitting позже.
- **SSE через прокси** — nginx должен поддерживать SSE (proxy_buffering off). Решение: конфиг nginx с `proxy_buffering off` для `/api/opencode/event`.
- **In-memory store не переживает рестарт** — для MVP приемлемо, для продакшена нужен Redis. Интерфейс предусмотрен.
- **Один bridge на одну сессию** — если пользователь хочет поделиться несколькими сессиями, нужно запускать несколько bridge. Skill должен поддерживать это.

## Открытые вопросы (для будущих версий)

- Поддержка нескольких сессий на один код (выбор из списка).
- WebRTC для прямого подключения viewer ↔ opencode (минуя relay для трафика, relay только для сигналинга).
- Redis для store и pub/sub между relay-нодами.
- Метрики и алертинг (Prometheus + Grafana).
