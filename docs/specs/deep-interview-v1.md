# Deep Interview Spec: Yandex Messenger MCP (v1)

## Metadata
- Interview ID: yandex-messenger-mcp-2026-07-16
- Rounds: 11
- Final Ambiguity Score: 11%
- Type: brownfield-interview → greenfield outcome (отдельный репозиторий)
- Generated: 2026-07-16
- Threshold: 0.2
- Threshold Source: default
- Initial Context Summarized: no (research doc read in full: yandex-messenger-api-research.md)
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.90 | 0.35 | 0.315 |
| Constraint Clarity | 0.87 | 0.25 | 0.218 |
| Success Criteria | 0.88 | 0.25 | 0.220 |
| Context Clarity | 0.87 | 0.15 | 0.131 |
| **Total Clarity** | | | **0.884** |
| **Ambiguity** | | | **0.116 (11%)** |

## Topology
| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| Auth и сессия | active | Bootstrap авторизации + рефреш | Гибрид: Playwright persist-профиль как провайдер cookie + рефреш; транспорт auth-agnostic (принимает `{cookies+userUid}` ИЛИ `{oauth_token+uid}`) |
| Транспорт-клиент | active | HTTP registry POST + WebSocket кодек кадров | Node undici + ws; кодек кадров по §2.2/§14.9; WS нужен для history и push даже без подписок |
| MCP tool surface | active | Инструменты v1 + чтение вложений | list_chats, get_history, search, send_message (confirm), download_attachment (по требованию, в папку, TTL-cleanup) |
| Real-time события | **deferred** | Live push (subscribe + поток событий), бот/автоответы | Отложено пользователем в Round 3. WS-подписки и обработка событий §9 — не в v1 |

## Goal
Построить **отдельный (standalone) MCP-сервер** для Яндекс Мессенджера, дающий агенту читать переписку и отправлять текст от имени пользователя, с обязательным чтением вложений (картинки и файлы). Протокол уже реверс-инжинирен в `yandex-messenger-api-research.md`. v1 покрывает основной поток: посмотреть список чатов, прочитать историю конкретного чата, найти по переписке/юзерам/чатам, скачать вложения на диск, отправить текстовое сообщение с явным подтверждением. Real-time/бот отложены.

## Constraints
- **Отдельный репозиторий**, вне монорепо devflow. Своё окружение, свой конфиг, свои зависимости. НЕ зависит от `@devflow/core`.
- Стек: Node.js + TypeScript; `@modelcontextprotocol/sdk` (stdio-транспорт), `playwright` (auth), `ws` (WebSocket), undici/встроенный fetch (HTTP), msgpack-кодек для заголовков WS-кадров.
- **Auth = гибрид**: Playwright с persist-профилем логинится раз (QR/пароль), профиль хранит и рефрешит cookie Паспорта. Обычный Node-клиент гоняет протокол на извлечённых cookie. Браузер поднимается только для логина и рефреша при 401. Транспорт auth-agnostic: слой авторизации абстрагирован, чтобы OAuth-путь (§13.7) подключился позже без переписывания.
- **WebSocket обязателен для v1**: чтение `history` и отправка `push` идут ТОЛЬКО по WS (§1). HTTP registry — для search, метаданных, юзеров, файлов, чатов.
- **Cookie-режим WS** (установлено перезахватом на залогиненной сессии, research §17.1/§17.4): WS-URL = `?service=...&session=<4x4hex>&client=web_main&user=<числовой uid>`. **Cookie-only handshake достаточен**: ни `sign`, ни `ts` в URL нет, `secretSign` на этом пути НЕ нужен (он — фоллбэк гостя / заблокированной cookie-авторизации). Числовой `uid` для сборки URL берётся из HTTP-метода `request_user` до открытия сокета (`whoami` живёт ЗА WS — курица-яйцо); `request_user` требует CSRF-токен из `csrf-token` (единственный read-метод с таким требованием) и отдаёт `{status:"ok", data:{user:{guid, uid, ...}}}`. CSRF-токен также нужен для мутирующих HTTP (§3.1, §13.4).
- **Один аккаунт на инстанс сервера** (один persist-профиль + один конфиг). Мульти-аккаунт → v2.
- **Адресация чата**: инструменты чтения/отправки принимают `ChatId` напрямую ЛИБО текстовый запрос (резолвится через `search`; при нескольких совпадениях инструмент возвращает список кандидатов для уточнения, а не гадает).
- **send_message с явным подтверждением**: двухшаговый протокол. Первый вызов = draft: возвращает превью (текст + разрешённый чат: имя/ChatId), НЕ отправляет. Реальная отправка только при `confirm:true` (или отдельным вызовом), после проверки что чат тот же.
- **Вложения — скачивание по требованию**: `get_history` возвращает рефы вложений (`file_info.id`, имя, тип, размер), НЕ качает. Отдельный `download_attachment(ref)` скачивает в локальную папку загрузок (путь в конфиге) и возвращает локальный путь. Единый формат для картинок и файлов (агент читает по пути).
- **Автоочистка загрузок по TTL**: настраиваемый TTL (дефолт 7 дней). Sweep старых файлов при старте сервера и периодически (или перед каждым скачиванием). Система не замусоривается.
- **First-run auth — авто при первом вызове**: если валидной сессии нет, инструмент возвращает ошибку «нужен логин» и поднимает headed-браузер Playwright, ждёт входа (QR/пароль), затем продолжает. Отдельная команда login не обязательна.
- **Артефакты по умолчанию** в `~/.config/yandex-messenger-mcp/`: `config.json`, `profile/` (Playwright persist), `downloads/` (вложения). Пути переопределяются в конфиге.
- **list_chats**: по умолчанию все чаты, сортировка по последнему сообщению (свежие сверху), с флагом непрочитанных; параметры `limit` (дефолт 50) и опц. `unread_only`.
- **Форма сообщения** (`get_history`): id, время (ISO + сырые мкс), отправитель (имя + guid), текст, рефы вложений (id/имя/тип/размер), контекст reply/forward (цитата если есть), флаги edited/deleted.
- **search — полноценный, но пагинации по страницам НЕ существует** (установлено спайком 2, см. research §17.5; прежнее прочтение §3.3 неверно). Факты: `total` = число возвращённых элементов (`min(limit, реальное)`), `page`/`pages` всегда 1 и вестигиальны, параметры `page`/`offset`/`from`/`skip`/`page_number` сервер игнорирует, дефолтный `limit` = 5.
  **Реализация «полноценности» — эскалация `limit`:** запросить с `limit`; если `total == limit`, возможно есть ещё → поднять `limit` и перезапросить; `total < limit` = найдено всё. Инструмент делает это прозрачно для агента и возвращает полный набор. Серверный потолок `limit` не установлен — если обнаружится, деградировать явно (вернуть найденное + пометку об усечении, не молча).
- **Rate limits / ошибки**: уважать `rate_limit.wait_for` из push-ответа (§14.4); маппить 3 слоя ошибок (transport PROXY_STATUS, application Status, push commit-status — §14.6) в понятные MCP-ошибки.
- Config-значения известны из живой сессии (§15): apiUrl, csrfTokenUrl, xivaUrl, serviceId=27, apiVersion=5, uniproxyApiKey, хосты файлов.

## Non-Goals (v1)
- Real-time подписки, обработка live-событий (typing/seen/presence), бот-логика и автоответы (отложено, §9).
- Отправка файлов/картинок/голосовых (v1 отправляет только текст; чтение вложений — да).
- Реакции, правка/удаление сообщений, read-маркеры, закреп, опросы, звонки/встречи (Telemost).
- Управление чатами (создание, участники, роли, настройки, инвайты).
- Мульти-аккаунт.
- Чистый OAuth-режим без браузера (архитектурно подготовлен, но не реализуется в v1 из-за нерешённого client_id/scope — §16).

## Acceptance Criteria
- [ ] `list_chats` возвращает метаданные чатов (последнее сообщение, непрочитанные) через WS `history` с **`Limit:1`** (ИСПРАВЛЕНО живым прогоном: при `Limit:0` элемент чата НЕ несёт `LastMessage`, критерий «последнее сообщение» невыполним; `Limit` — это лимит сообщений внутри чата, не число чатов). Непрочитанное считается тут же: `LastSeqNo - LastSeenByMeSeqNo` — отдельный `requestCounters` НЕ нужен. Осторожно: поле `Counters` в ответе — это НЕ непрочитанное, там `{HiddenMessageCount, TotalMessageCount}`.
- [ ] `get_history(chat: ChatId|query, ...)` возвращает страницу сообщений конкретного чата с пагинацией по `MaxTimestamp`/`Offset`; при query резолвит чат, при неоднозначности возвращает кандидатов.
- [ ] `search(query, entities)` ищет по `messages`/`users`/`chats` через HTTP registry и возвращает **полный набор** через эскалацию `limit` (поднимать, пока `total == limit`; остановиться на `total < limit`). Проверяемо: на запросе с известным числом совпадений N инструмент возвращает все N при стартовом `limit < N`. Entity `contacts` не поддерживается (сервер отвечает error).
- [ ] `send_message` шаг 1 (draft) возвращает превью и НЕ отправляет; шаг 2 (`confirm:true`) отправляет `push` Plain.Text и возвращает статус коммита (`FULLY_COMMITTED`).
- [ ] `download_attachment(ref)`: для рефа с `file_info.id` строится download URL (§12.2), файл скачивается той же auth-сессией в папку загрузок, возвращается локальный путь; работает для картинок и произвольных файлов. `get_history` вложения НЕ качает — только рефы.
- [ ] Автоочистка: файлы старше TTL удаляются (проверяемо: положить старый файл → запустить sweep → файла нет).
- [ ] Auth bootstrap: при отсутствии сессии первый вызов инструмента поднимает headed-браузер для логина и продолжает; последующие — работают на сохранённом профиле без ручного входа; при 401 профиль рефрешится.
- [ ] `list_chats`: все чаты, сортировка по свежести, флаг непрочитанных; `limit` (дефолт 50) и `unread_only` работают.
- [ ] `get_history` возвращает сообщение с полями: id, время (ISO+мкс), отправитель (имя+guid), текст, рефы вложений, reply/forward-контекст, флаги edited/deleted.
- [ ] WS-кадры кодируются/декодируются корректно: `0x01` + MessagePack `[serviceIndex, reqId, method]` + `0x05`+11×`0x00` + JSON; ответы парсятся, seq/RequestId матчатся.
- [ ] Сервер поднимается как MCP stdio-сервер и все инструменты видны MCP-клиенту (Claude).
- [ ] Ошибки протокола (3 слоя) маппятся в осмысленные сообщения инструментов.

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| «Замена веб-интерфейса» = полный клиент | Round 4 contrarian: нужна ли широкая поверхность? | v1 = 4 сфокусированных инструмента + чтение вложений |
| Бот/автоматизация в v1 | Round 3: MCP request-response, «реакция на входящие» требует механизма | Real-time и бот отложены в v2 |
| Real-time отложен ⇒ WS не нужен | Проверка по §1 | WS всё равно нужен: history+push только по WS |
| OAuth — «более правильный» auth | §16 разбор | Гибрид Playwright+cookie — доказанно рабочий; OAuth как расширение |
| Живёт в монорепо devflow | Round 5 → правка пользователя | Отдельный репозиторий, без core |
| Вложения = v2 | Правка на лету | Чтение вложений — must-have v1 |
| Отправка — сразу | Round 8: почти необратимо | Явный confirm-параметр (draft → confirm) |
| Скачанные файлы остаются | Правка на лету | Автоочистка по TTL (дефолт 7 дней) |
| get_history качает вложения | Round 9: диск пухнет | По требованию: get_history даёт рефы, download_attachment качает |
| Логин отдельной командой | Round 10 | Авто при первом вызове (headed-браузер по требованию) |

## Technical Context
Источник истины по протоколу — `yandex-messenger-api-research.md` (исчерпывающий реверс web-клиента `chats-web/3.21.0`). Ключевое для реализации:
- **Два транспорта**: WS (Xiva push `wss://push.yandex.ru/v2/subscribe/websocket`, cookie-режим) для history/push; HTTP registry `POST https://yandex.ru/messenger/api/registry/api/` (multipart FormData `request=JSON({method,params})`) для остального.
- **WS-кадр** (§2.2, §14.9): `0x01` + MessagePack `[serviceIndex, reqId, method]` + `0x05` + 11 нулевых байт + UTF-8 JSON `{RequestId, ...params}`. Ответы симметричны; типы кадров DATA=1/PROXY_STATUS=2/PUSH=3.
- **history** (§2.4, §14.2) — один метод-суперсет: список чатов (`Limit:0`), страницы сообщений, батчи, треды.
- **push** (§14.4) — все мутации, включая отправку `Plain.Text`; ответ `deserializePushResponse` со `status` (FULLY_COMMITTED=1).
- **search** (§3.3, уточнено §17.5/§17.6) — HTTP, `entities:["messages"|"users"|"chats"]` (`contacts` невалиден). Пагинации по страницам НЕТ: `total` = число возвращённых (`min(limit, реальное)`), `page`/`pages` всегда 1. Полнота — через эскалацию `limit`.
- **Файлы** (§12): `file_info.id` → download URL `https://files.messenger.yandex.ru/file_shortterm/{fileId}` (+ шаблоны для image preview/voice/video/avatar); доступ той же auth-сессией.
- **Auth** (§4, §13, §17.1/§17.4): cookie-режим (Session_id; CSRF для `request_user` и мутаций; **secretSign НЕ нужен** — гостевой фоллбэк) — путь 1 из §16, рекомендованный.
- **Config** (§15): apiUrl, csrfTokenUrl, xivaUrl, serviceId=27, apiVersion=5, uniproxyApiKey=`069b6659-984b-4c5f-880e-aaedcfd84102`, хосты файлов.

Открытые внешние вопросы (не блокируют v1 в cookie-режиме): OAuth client_id/scope (§16).

**Спайки закрыты (2026-07-16; auth-выводы перезахвачены и исправлены 2026-07-17 — см. `.omc/spikes/yandex-mcp/SPIKE-RESULTS.md` и research §17):**
- Frame codec — валидирован оффлайн (13/13), ручной кодек с разбором по длине заголовка.
- WS-handshake — **cookie-only handshake работает**: URL = `?service&session=<4x4hex>&client=web_main&user=<числовой uid>`, без `sign` и `ts`. Исходные §2.1/§4/§15 подтверждены. Прежний вывод («URL подписан, `user`=guid») — артефакт ГОСТЕВОЙ сессии, отменён.
- `secretSign` — **фоллбэк гостя / заблокированной cookie-авторизации, не нормальный путь** (`secretSignNeeded` взводится только на close-reason `COOKIE_AUTH_FAILED`/`NO_CREDENTIALS` либо под OAuth). На cookie-пути не нужен.
- `request_user` — **sign НЕ отдаёт**; возвращает `{status:"ok", data:{user:{guid, uid, ...}}}`, params `{bind_phone_number:false}`, **требует CSRF** (без `X-CSRF-TOKEN` → 403 `bad_csrf_token`). Нужен как HTTP-источник **числового uid** для сборки WS-URL до открытия сокета.
- push↔subscribe — `XivaSubscriptionId` берётся из операционного Xiva-кадра `subscribed` (приходит на connect); app-level chat-`subscribe` для отправки НЕ нужен (подтверждено и на залогиненной сессии: первый push ушёл раньше первого app-level subscribe и получил `Status:1`; app-level subscribe = LIVE-подписка на чаты, v2).
- search — пагинации по страницам нет; полнота через эскалацию `limit`.
- Поправки каталога: `get_current_user_data` не существует («No such path»); `get_organizations` требует `organization_ids`; `csrf-token` отдаёт `{token}` голым; entity `contacts` невалиден.

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| Chat | core domain | ChatId, тип (private `guidA_guidB` / group `0/0/guid`), lastMessage, unread | has many Message; has many User |
| Message | core domain | Timestamp(мкс), SeqNo, From, Text, Attachments, Version | belongs to Chat; has many Attachment |
| User | core domain | Guid, Uid, DisplayName, Nickname, AvatarId | member of Chat |
| Session | supporting | cookies, csrfToken, userUid (числовой, в `user=` WS-URL), userGuid, yandexUid, secretSign? (опц., гостевой фоллбэк) | authenticates transport |
| Attachment | core domain | file_info.id, name, size, source(MDS/DISK), тип(image/file/voice) | belongs to Message; → DownloadedFile |
| DownloadedFile | supporting | localPath, downloadedAt, TTL | локальная копия Attachment; подлежит cleanup |
| MCP-Tool | interface | name, params, result | оперирует Chat/Message/Attachment |
| ChatId | value | private/group формат | идентифицирует Chat |
| Event/Subscription | deferred | — | v2 (real-time) |

## Ontology Convergence
| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 6 | 6 | - | - | N/A |
| 2 | 8 | 2 (SecretSign, Subscription) | - | 6 | 75% |
| 3 | 6 active | 0 | - | 6 | 100% |
| 4 | 6 | 0 | - | 6 | 100% |
| 5 | 7 | 1 (Attachment) | - | 6 | 88% |
| 6 | 8 | 1 (ChatId выделен) | - | 7 | 90% |
| 7 | 8 | 0 | - | 8 | 100% |
| 8 | 9 | 1 (DownloadedFile) | - | 8 | 90% |
| 9 | 9 | 0 | - | 9 | 100% |
| 10 | 9 | 0 | - | 9 | 100% |
| 11 | 9 | 0 | - | 9 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (8 rounds + Round 0)</summary>

### Round 0 — Topology
**Q:** 4 верхнеуровневых компонента (Auth, Транспорт, MCP tool surface, Real-time)?
**A:** Всё верно, 4 компонента.

### Round 1 — Goal (mcp-tool-surface)
**Q:** Главный сценарий использования?
**A:** Чтение и триаж + Отправка и ответы + Автоматизация/бот.
**Ambiguity:** 71%

### Round 2 — Constraints (auth-session)
**Q:** Как аутентифицироваться (cookie/browser/OAuth)?
**A:** Не решил, нужен совет → рекомендован гибрид → принят гибрид (Playwright persist + Node, auth-agnostic).
**Ambiguity:** 62%

### Round 3 — Goal (realtime-events)
**Q:** Как работает бот/автоматизация через MCP (request-response)?
**A:** Автоматизацию отложить.
**Ambiguity:** 51%

### Round 4 — Success Criteria (contrarian, mcp-tool-surface)
**Q:** v1 = 4-5 сфокусированных инструмента? Что must-have?
**A:** list_chats, get_history, search, send_message (все 4).
**Ambiguity:** 39%

### Round 5 — Context (placement)
**Q:** Где живёт MCP и как берёт конфиг?
**A (изменён на лету):** Отдельный репозиторий. + Требование на лету: чтение вложений (картинки+файлы) — must-have v1.
**Ambiguity:** 35%

### Round 6 — Success Criteria (simplifier, вложения)
**Q:** Как отдавать прочитанное вложение?
**A:** Всё на диск, вернуть пути.
**Ambiguity:** 28%

### Round 7 — Constraints (адресация чата)
**Q:** Как агент адресует чат (ChatId непрозрачный)?
**A:** Оба: ChatId или запрос.
**Ambiguity:** 22%

### Round 8 — Constraints (безопасность send)
**Q:** Поведение send_message (необратимо)?
**A:** Явный confirm-параметр. + Требование на лету: автоочистка скачанных файлов по TTL.
**Ambiguity:** 17% ✓

### Round 9 — Success Criteria (стратегия вложений)
**Q:** Когда скачивать вложения?
**A:** По требованию (get_history → рефы, отдельный download_attachment).
**Ambiguity:** 14%

### Round 10 — Constraints (first-run auth)
**Q:** Как выполняется первичный логин Playwright?
**A:** Авто при первом вызове (headed-браузер по требованию).
**Ambiguity:** 12%

### Round 11 — Финализация (полировка)
**Q:** Принять дефолты list_chats / формы сообщения / search-пагинации?
**A:** Принять всё, финал.
**Ambiguity:** 11% ✓

### Round 11b — Коррекция (search)
**Q/уточнение пользователя:** «поиск нам нужен полноценный».
**Resolution:** search в v1 — с полной пагинацией по всем страницам, не только первая; имя параметра страницы (§3.3) переведено из опционального в обязательный v1-спайк.
</details>
