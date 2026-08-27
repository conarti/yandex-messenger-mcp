# Yandex Messenger (yandex.ru/chat) - reverse-engineering reference

> Research notes for building an MCP that replaces the web interface.
> Собрано наблюдением собственного трафика + анализом клиентского бандла
> `https://yastatic.net/s3/chat-static/_/0x8b21684/web/app.js` (v `chats-web/3.21.0`).
> Приватный контент переписок в документ не включён - только схемы.

## 1. Архитектура: два транспорта

Веб-клиент работает через **два независимых канала**, оба несут один RPC-протокол
(конверт `{method, params}` / `{RequestId, ...}`):

| Транспорт | URL | Клиент в бандле | Что несёт |
|-----------|-----|-----------------|-----------|
| **WebSocket (Xiva push)** | `wss://push.yandex.ru/v2/subscribe/websocket` | `this.get(conn, "method", params)` | Чтение истории, real-time события, отправка |
| **HTTP registry** | `POST https://yandex.ru/messenger/api/registry/api/` | `this.request("method", params, opts)` | Юзеры, чаты, поиск, файлы, настройки, звонки |

Ключевой факт для MCP: **чтение сообщений (`history`) и отправка (`push`) идут ТОЛЬКО по WebSocket.**
HTTP registry покрывает всё остальное (поиск, метаданные, управление).

---

## 2. WebSocket-транспорт

### 2.1 Подключение

```
wss://push.yandex.ru/v2/subscribe/websocket
  ?service=messenger-prod:version5*common+version5*main
  &session=<4x4hex, напр. 74d0-3c17-7924-9497>
  &client=web_main
  &user=<uid, напр. <numeric-uid>>
```

Авторизация - через cookies домена `.yandex.ru` (см. §4). `user` = числовой uid из `whoami`.

### 2.2 Формат кадра (frame framing) - РАСШИФРОВАН

Кадры бинарные (opcode 2). Точный формат (байты сняты как base64 сырых Blob через
in-page патч `WebSocket.send`):

```
whoami:    01 | 93 00 01 a6 77686f616d69         | 05 00 00 00 00 00 00 00 00 00 00 00 | {json}
history:   01 | 93 00 02 a7 686973746f7279       | 05 …(11×00)…                        | {json}
push:      01 | 93 00 05 a4 70757368             | 05 …(11×00)…                        | {json}
subscribe: 01 | 93 00 09 a9 737562736372696265  | 05 …(11×00)…                        | {json}
```

Структура кадра:

| Часть | Байты | Смысл |
|-------|-------|-------|
| префикс | `0x01` | константа (тип кадра) |
| заголовок | **MessagePack** `0x93 <fixint 0> <fixint seq> <fixstr method>` | массив `[0, seq, method]` |
| разделитель | `0x05` + `0x00`×11 | эмпирически константа (12 байт) |
| тело | UTF-8 JSON | `{RequestId, ...params}` (НЕ messagepack) |

- `0x93` = MessagePack fixarray длины 3.
- `0x00` (элемент 0) - всегда 0.
- `seq` (элемент 1) - счётчик запроса fixint (whoami=1, history=2, push=5, subscribe=9; растёт).
- метод (элемент 2) - MessagePack fixstr: `0xa6`="whoami"(6), `0xa7`="history"(7),
  `0xa4`="push"(4), `0xa9`="subscribe"(9). Для длинных имён будет `str8` (`0xd9 <len>`).

**Реконструкция кадра в MCP** (псевдокод):

```
frame = Buffer.concat([
  Buffer.from([0x01]),
  msgpack.encode([0, seq, method]),        // напр. [0, 3, "history"]
  Buffer.from([0x05, 0,0,0,0,0,0,0,0,0,0,0]),
  Buffer.from(JSON.stringify({RequestId, ...params}), 'utf8')
])
ws.send(frame)                              // как binary
```

**Ответные кадры** (сняты как base64 сырых Blob, только заголовки) - симметричны:

```
whoami   resp: 01 93 00 01 a6 "whoami"    05 00 00 00 10 da a6 0e 00 00 00 00 {json}
history  resp: 01 93 00 02 a7 "history"   05 00 00 00 19 bd 85 69 00 00 00 00 {json}
push     resp: 01 93 00 05 a4 "push"      05 00 00 00 c9 6c 7a a2 00 00 00 00 {json}
subscribe resp:01 93 00 09 a9 "subscribe" 05 00 00 00 8d 99 62 e2 00 00 ...   {json}
```

- **seq эхо-матчится**: элемент 1 msgpack в ответе = seq запроса (whoami→1, history→2,
  push→5, subscribe→9). Значит ответ можно паровать с запросом и по seq, и по `RequestId` в JSON.
- Разделитель после метода: `0x05` + 11 байт `00 00 00 <4-byte value> 00 00 00 00`.
  В **запросах** эти 11 байт - нули (клиент шлёт нули → MCP тоже шлёт нули).
  В **ответах** сервер кладёт 4-байтовое значение (похоже на crc/msg-id; для парсинга неважно -
  тело читается от первого `{`).

**Уточнение заголовка (из wsproto §14):** msgpack-массив = `[serviceIndex, reqId, method]`.
Элемент 0 - `serviceIndex` (this.index транспорта, обычно `0`), элемент 1 - `reqId` (=seq),
элемент 2 - метод. Разделитель `0x05`+11 нулей пишет маршаллер: `setUint8(0,5)` + 11 нулевых байт.

**Типы кадров (msgpack `P.*`):** `DATA=1` (`0x01`, заголовок `[serviceIndex, reqId, method]` + JSON),
`PROXY_STATUS=2` (`0x02`, `[reqId, errorCode]`, транспортная ошибка), `PUSH=3` (`0x03`,
`[uid, service, event, transitId]` + payload - **server-initiated событие**, см. §9). Тот `03 94 ...`
кадр в трафике - это PUSH-событие, не presence. MCP: байт 0 = тип кадра.

> Итог: обёртку MCP генерирует сам (тип `0x01`), без headless-браузера. Декодер: читать байт 0
> (`0x01` метод / `0x03` presence), для `0x01` парсить msgpack-заголовок `[0, seq, method]` и JSON
> от первого `{`. Остаётся вопрос авторизации (§4).

### 2.3 Методы WebSocket (`this.get`)

| method-строка | функция клиента | назначение |
|---------------|-----------------|------------|
| `whoami` | `whoami()` | кто я (uid, guid, профиль) |
| `history` | `history()` | **чтение истории / список чатов** (см. §2.4) |
| `subscribe` | `subscribe()` | подписка на обновления чата |
| `push` | - | heartbeat + **отправка сообщений** (ClientMessage) |
| `message_info` | `messageInfo()` | инфо по конкретному сообщению |
| `edit_history` | `editHistory()` | история правок сообщения |
| `poll_info` | `pollInfo()` | данные опроса |
| `list_reactions` | `userReactions()` | реакции на сообщение |

(`float/int/string/tensor/...` в `this.get` - это флаги экспериментов, не чат.)

### 2.4 `history` - главный метод чтения

Один метод с фильтрами покрывает список чатов, страницы сообщений, треды, встречи.
Наблюдаемые варианты `params`:

```jsonc
// список всех чатов (метаданные)
{ "RequestId": "...", "Limit": 0, "ChatDataFilter": {} }

// страница сообщений чата (пагинация вверх)
{ "RequestId":"...", "ChatId":"<guidA>_<guidB>", "Limit":41,
  "MaxTimestamp":1784117592261029, "Offset":20 }

// диапазон сообщений с фильтром полезной нагрузки
{ "RequestId":"...", "ChatId":"<id>", "MaxTimestamp":..., "MinTimestamp":...,
  "DropPersonalFields":false, "ChatDataFilter":{},
  "MessageDataFilter":{"DropPayload":true}, "Limit":20 }

// групповой чат
{ "RequestId":"...", "ChatId":"0/0/<guid>", "Limit":40, "MaxTimestamp":..., "Offset":0 }

// батч инфы по нескольким чатам
{ "RequestId":"...", "ChatIds":["<id1>","<id2>", ...] }

// треды
{ "RequestId":"...", "Threads":true, "Limit":0,
  "MessageDataFilter":{"DropThreadParentMessage":true} }

// чаты со встречами
{ "RequestId":"...", "Limit":0, "HasMeeting":true }

// синхронизация по таймстемпам (только метки)
{ "RequestId":"...", "MessageDataFilter":{"OnlyTimestamps":true,"DropPayload":true},
  "MinTimestamp":..., "Threads":false, "Limit":0 }
```

Параметры:
- `ChatId` - см. §5 (формат id). `ChatIds` - батч.
- `Limit` - размер страницы (`0` = только метаданные/список, без тел).
- `MaxTimestamp` / `MinTimestamp` - границы диапазона, микросекунды (16 цифр).
- `Offset` - смещение внутри диапазона.
- `MessageDataFilter`: `{ DropPayload, OnlyTimestamps, DropThreadParentMessage }`.
- `ChatDataFilter`: `{}` - что подмешивать из метаданных чата.
- `DropPersonalFields`, `Threads`, `HasMeeting` - флаги режима.

**Схема ответа** `history` (сообщения):

```jsonc
{
  "Chats": [
    {
      "ChatId": "string",
      "Messages": [
        {
          "ServerMessage": {
            "ClientMessage": {
              "Plain": {
                "Text": { "MessageText": "string" },   // текст сообщения
                "ChatId": "string",
                "CustomPayload": "string",              // base64(JSON) клиентской меты
                "PayloadId": "string"
              }
              // другие типы тела: см. §6
            },
            "ServerMessageInfo": {
              "Timestamp": "number",      // мкс
              "PrevTimestamp": "number",
              "SeqNo": "number",
              "Version": "number",
              "From": {
                "Guid": "string",
                "DisplayName": "string",
                "AvatarId": "string",
                "PhoneId": "string",
                "Version": "number"
              }
            },
            "ReadsVersion": "number"
          },
          "Meta": { "Origin": "number" }
        }
      ]
    }
  ],
  "RequestId": "string"
}
```

Другие сигнатуры ответов (по ключам): `{CurrentTime, LastMessage, RequestId}` (элемент
списка чатов), `{CurrentTime, LastMessages, RequestId}`, `{CurrentTime, UserInfo, UserStatusInfo}`
(whoami). Real-time событие нового сообщения приходит как `{ClientMessage, ServerMessageInfo}`.

### 2.5 `whoami` ответ

```jsonc
{
  "UserInfo": {
    "Guid":"string", "Uid":"number", "DisplayName":"string", "PublicName":"string",
    "Nickname":"string", "AvatarId":"string", "PhoneId":"string", "Phone":"string",
    "Gender":"string", "RegistrationStatus":"number", "Version":"number",
    "AccountType":{"Found":"boolean","Value":"string"}, "AccountCategory":"number"
  },
  "UserStatusInfo": { "UserStatus":{}, "Timestamp":"number" },
  "CurrentTime":"number"
}
```

### 2.6 `subscribe` / `push` params

```jsonc
// subscribe - подписка на чат
{ "RequestId":"...", "ClientTransportId":{"XivaSubscriptionId":"<hex40>"},
  "UserAgent":"chats-web/3.21.0", "ToGuid":"<chat-or-user-guid>",
  "TtlMcs":60000000, "MessageBodyType":2, "ClientSupportedFeatures":1 }

// push - heartbeat (и транспорт для отправки ClientMessage)
{ "RequestId":"...", "ClientTransportId":{"XivaSubscriptionId":"<hex40>"},
  "UserAgent":"chats-web/3.21.0",
  "ClientMessage":{ "Heartbeat":{"Type":2}, "LogData":{"YandexUid":"...","UserInterface":1} },
  "Meta":{"Origin":27}, "ClientSupportedFeatures":1 }
```

Отправка текста = `push` с `ClientMessage.Plain.Text.MessageText` (вместо `Heartbeat`),
`XivaSubscriptionId` берётся из ответа на подписку.

---

## 3. HTTP registry-транспорт

### 3.1 Конверт запроса

```
POST https://yandex.ru/messenger/api/registry/api/
Content-Type: multipart/form-data
FormData:
  request = JSON.stringify({ "method": "<method>", "params": { ... } })
```

Ответ: `{ "status": "...", "data": { ... } }`.

CSRF: заголовок `X-CSRF-TOKEN`, токен берётся из
`POST https://yandex.ru/messenger/api/registry/csrf-token/`.
Часть методов вызывается с `enableCSRF:false` (напр. `search`).

### 3.2 Каталог методов (`this.request`)

**Поиск / suggest**
| method | функция | назначение |
|--------|---------|------------|
| `search` | `search()` | **унифицированный поиск** (см. §3.3) |
| `search_chat_members` | `searchChatMembers()` | поиск участников чата |
| `get_suggest` | - | подсказки |
| `get_members_and_contacts_suggest` | `getMembersAndContactsSuggest()` | подсказки участники+контакты |
| `get_organization_chat_suggest` | `getOrganizationChatSuggest()` | подсказки чатов оргов |
| `get_recommended_chats` | `getRecommendedChats` | рекомендованные чаты |
| `get_recommended_users` | `getRecommendedUsers` | рекомендованные юзеры |

**Юзеры / контакты**
| method | функция |
|--------|---------|
| `get_current_user_data` | `getCurrentUser()` |
| `get_users_data` | `getUsers()` |
| `get_user_by_nickname` | `getUserByNickname()` |
| `request_user` / `request_fake_user` | загрузка юзера |
| `staff_proxy` | `getBulkGapUserInfo()` (стафф) |
| `list_contacts` | загрузка контактов |
| `purge_contacts` | `purgeContacts()` |
| `get_organizations` | `getOrganizations()` |

**Чаты**
| method | функция |
|--------|---------|
| `create_chat` | `createChat()` |
| `create_private_chat` | `createPrivateChat()` |
| `activate_chat` | `activateTransientChat()` |
| `get_chats_info` | инфо по чатам (HTTP-аналог метаданных) |
| `get_chat_members` | `getChatMembers()` |
| `get_group_members` | `getGroupMembers()` |
| `get_chat_settings` / `update_chat_settings` | `getChatSettings()` / `setChatSettings()` |
| `set_chat_info` | `setChatInfo()` |
| `change_chat_members` | `changeChatMembers()` |
| `change_chat_role` / `change_chat_admins` | `changeChatAdmins()` / `changeChannelAdmins()` |
| `leave` | `leaveChat()` |
| `invite` / `invite_renew` | `joinByHash()` / `renewInviteHash()` |
| `update_chat_organizations` | `updateChatOrganizations()` |
| `check_alias` | `checkAlias()` |
| `remove_display_restriction` | `removeDisplayRestriction()` |

**Треды**
| method | функция |
|--------|---------|
| `join_to_thread` | `joinToThread()` |
| `leave_thread` | `leaveThread()` |

**Сообщения / медиа / файлы**
| method | функция |
|--------|---------|
| `get_media_messages` | медиа-сообщения чата |
| `add_files` | `createFileByLocation()` |
| `share_file` | шаринг файла |
| `upload_to_disk` | `getDiskUploadUrl()` |
| `upload_remote_image` | `uploadYaPictures()` |
| `get_url_preview` | `getUrlPreview()` |
| `get_bucket` / `get_buckets` / `set_bucket` | KV-хранилище клиента |
| `get_disk_info` | `getUserDiskInfo()` |

**Встречи / звонки (Telemost)**
| method | функция |
|--------|---------|
| `create_meeting` / `meeting_call` | `meetingCall()` |
| `create_personal_meeting` / `end_personal_meeting` | персональная встреча |
| `get_meetings_info` | `getFullMeetingInfo()` / `getReducedMeetingsInfo()` |

**Аккаунт / настройки / сервис**
| method | функция |
|--------|---------|
| `get_settings` / `set_settings` | `getSettings()` / `setSettings()` |
| `set_phone` / `set_phone_confirm` | `bindPhone()` / `confirmPhone()` |
| `send_welcome_sms` | `sendSmsLink()` |
| `create_token` / `resolve_token` | `createToken()` / `resolveOneTimeUserToken()` |
| `set_push_token` | регистрация push-токена |
| `get_experiments` | `getExperiments()` |
| `commit_onboarding_passed` | `onboardCurrentUser()` |
| `team_migration_info` | `getTeamMigrationStatus()` |
| `sync` | `getSupportChatsSyncStatus()` |

### 3.3 `search` - поиск (в т.ч. по сообщениям)

```jsonc
// this.request("search", params, {enableCSRF:false})
params = {
  "query": "текст запроса",
  "limit": 10,                              // default 10
  "entities": ["messages"],                 // "messages" | "users" | "chats" | "contacts"
  "chat_id": "<опц. scope в конкретный чат>",
  "suggest_chat_id": "<опц.>",
  "new_chat": false,
  "invite_hash": "<опц.>"
}
```

`entities` управляет типом результатов - для поиска по переписке `["messages"]`
(можно комбинировать). `chat_id` ограничивает поиск одним чатом.

**Схема ответа** (снята живым вызовом, `{status, data}`):
```jsonc
{ "status": "ok",
  "data": {
    "messages": { "items": [ /* сообщения */ ], "total": 0, "limit": 3, "page": 1, "pages": 1 },
    "users":    { "items": [...], "total":0, "limit":0, "page":1, "pages":1 },  // при entities:["users"]
    "chats":    { ... },
    "warnings": { "users": [] } } }
```
**Пагинация - page-based**: ответ несёт `total / limit / page / pages`. Параметр запроса для
следующей страницы - вероятно `page` (не `offset`); точное имя не добито (нужен запрос с
`total>limit`, т.е. чтение приватного контента - не проверял). Курсора/pivot нет (в отличие от
`get_media_messages`, где `pivot_id`).

---

## 4. Авторизация

Клиент поддерживает **два режима** (в бандле выбор `"cookie"` | `"oauth"`):

### Режим cookie (то, что использует веб)
- **Cookies** домена `.yandex.ru`: сессия Паспорта (`Session_id`, `sessionid2`, `yandexuid`,
  `yp`, `ys`, `i` и т.д.), httpOnly. XHR идут с `withCredentials:true`.
- **CSRF**: `X-CSRF-TOKEN` из `POST /messenger/api/registry/csrf-token/` - для мутирующих
  HTTP-методов (часть read-методов идёт `enableCSRF:false`).
- WS `wss://push.yandex.ru/...` авторизуется теми же cookie (в URL токена нет, только
  случайный `session=`).

### Режим oauth (нативные клиенты / встроенный webview) - **предпочтителен для MCP**
В бандле явно есть OAuth-путь:
```js
setApiAuthorizationHeader(e){ this.setHeader("Authorization", e) }   // e = "OAuth <token>"
// при наличии oauthToken:
t.headers["Authorization"] = "OAuth " + token
t.headers["X-Uid"] = uid
t.withCredentials = false        // cookie не нужны
```
- HTTP registry: заголовки `Authorization: OAuth <token>` + `X-Uid: <uid>`, без cookie/CSRF.
- WS (Xiva): нативный клиент ставит `Authorization: OAuth <token>` **прямо на WS-handshake**.

### Вывод для MCP: удобная auth возможна, копировать cookie НЕ обязательно

| Вариант | Удобство | Надёжность | Комментарий |
|---------|----------|-----------|-------------|
| **OAuth-токен** (рекомендую) | высокое | высокая | HTTP: `Authorization: OAuth <token>` + `X-Uid`. WS: `oauth_token` в первом synchronize-state кадре (НЕ handshake-заголовок - уточнено в §13.5). Без CSRF. |
| **Headless-браузер с профилем** | среднее | высокая | залогиниться один раз (пароль/QR), сессия persists в профиле и сама рефрешится. Тяжелее, тянет Chromium. |
| **Ручное копирование cookie** | низкое | низкая | `Session_id` httpOnly, истекает, часто привязан к IP/устройству. Худший путь. |

**Где взять OAuth-токен:** через Yandex OAuth (`oauth.yandex.ru/authorize?response_type=token&client_id=<...>`).
Нужен `client_id` приложения со scope доступа к мессенджеру. Варианты уточнить:
- зарегистрировать своё приложение в Yandex OAuth и запросить нужный scope (если доступен публично);
- либо использовать `client_id`, которым пользуется официальный мобильный клиент (виден при
  реверсе трафика приложения) - для личного инструмента.
> TODO проверить перед реализацией: какой именно scope/client_id принимает
> `yandex.ru/messenger/api/registry` в oauth-режиме, и формат токена на WS-handshake Xiva.

- **uid** для заголовка `X-Uid` и WS-параметра `user` - из ответа `whoami` (`UserInfo.Uid`).

---

## 5. Форматы идентификаторов

- **uid**: числовой (`<numeric-uid>`).
- **guid** пользователя/сущности: UUID (`<guid-example>`).
- **ChatId приватного чата**: `<guidA>_<guidB>` (два guid через `_`, отсортированные по кодовым единицам UTF-16).
- **ChatId группового чата/канала**: `0/0/<guid>` (напр. `0/0/<guid>-...`).
- **XivaSubscriptionId**: hex40 (`<xiva-subscription-id-hex40>`).
- **Timestamp**: микросекунды, 16 цифр.
- **CustomPayload**: base64(JSON), клиентская мета вида
  `{"service":{"serviceName":"WEB","region":"...","yuid":"...","isHistory":true,"ui":"desktop","ua":"..."}}`.

---

## 6. Типы тела сообщения (`ClientMessage.*`)

Наблюдался `Plain` (`Plain.Text.MessageText`). Из протокола известны также
`Sticker`, `Image`, `File`, `Gallery`, `Voice`, `Poll`, а также ссылки на
пересылку/ответ (`ForwardedMessageRefs`, `Reply`). Точные схемы нетекстовых тел
не захвачены в этой сессии - добираются открытием соответствующих сообщений
(с редактированием контента) либо из бандла.

---

## 7. Params ключевых HTTP-методов (уточнённые из бандла)

```jsonc
get_media_messages: { chat_id, pivot_id, next, prev, types, query, invite_hash }   // enableCSRF:false
get_chats_info:     { chat_id, supported_features:["should_return_alternative_accounts"] }
get_chat_members:   { <chat_id/guid> }                    // -> { users, groups, departments }
get_users_data:     { guids:["<guid>", ...] }             // -> [users]; enableCSRF:false
create_private_chat:{ guid, wait_for_update, onetime_user_token }
create_chat:        { alias, ... }
get_url_preview:    { url, format:"full" }                // enableCSRF:false
search:             { query, limit, entities, chat_id, suggest_chat_id, new_chat, invite_hash }
```

## 8. Статус вопросов перед реализацией MCP

Закрыто в Части 2:
- [x] Бинарная обёртка WS-кадра - §2.2 + §14.9 (MessagePack header + `0x05`+11 нулей + JSON).
- [x] Auth cookie vs OAuth - §13 (OAuth-путь; токен инжектит хост, CSRF skip при токене).
- [x] Схема ответа `push` (commit-status, messageInfo, rate_limit) - §14.4/§14.6.
- [x] Все типы тел `ClientMessage` (17 kinds, схемы) - §11.
- [x] Read-маркеры / typing / presence / reactions (события + отправка) - §9.
- [x] Real-time события (полный каталог + дискриминатор) - §9.
- [x] Формат ошибок (3 слоя + enum) - §14.6.
- [x] Reconnect/ping, RequestId vs seq - §14.7/§14.8.
- [x] Файлы/медиа: upload-флоу, URL-хосты (резолвнуты), схемы - §12.
- [x] Полный каталог 63 HTTP-методов с params - §10.

- [x] **Config-значения** сняты из живой сессии - §15 (apiUrl, csrfTokenUrl, websocketUrl, xivaUrl,
      serviceId=27, apiVersion=5, xivaServiceName, хосты, **uniproxyApiKey**).
- [x] **Пагинация `search`** - page-based `{items,total,limit,page,pages}` - §3.3 (проверено живым вызовом).

Остаётся открытым:
- [ ] **OAuth `client_id`/`scope`** для минта токена (в бандле нет). Единственный по-настоящему
      внешний вопрос - см. разбор ниже (§16).
- [ ] Точное имя параметра страницы `search` (`page`?) - нужен запрос с `total>limit` (приватный контент).
- [ ] **Сборка WS-URL с `secretSign`** (cookie-режим) - вероятно в отдельном worker-чанке.
- [ ] **uid в OAuth-режиме** - принимает ли API запрос без `X-Uid`, если токен идентифицирует юзера.

---

# Часть 2 - доскональный разбор (для реализации MCP)

## 9. Real-time события (server push)

**Транспорт:** WebSocket. Класс `MessengerApi` подписан на `transport.onMessage`, каждый кадр
проходит через `handleTransportMessage(e)`. **Push-кадр - плоский объект**
`{ ClientMessage, ServerMessageInfo, Users?, ... }` (БЕЗ обёртки `ServerMessage` - она только
в HTTP/RPC-ответах `history`).

**Дискриминатор события = какое суб-поле `ClientMessage` присутствует** (длинная цепочка
`if/else if` по `t = e.ClientMessage`):

| `ClientMessage.*` | событие | назначение |
|-------------------|---------|------------|
| `StateSync` | STATE_SYNC | синхр. состояния между устройствами |
| `Plain` | PLAIN | **новое сообщение, а также правка и удаление** |
| `Ephemeral` | EPHEMERAL | исчезающие (feature-flag) |
| `SystemMessage` | SYSTEM | системное сообщение чата |
| `Typing` | TYPING | набор текста |
| `SeenMarker` | SEEN_MARKER | прочтение |
| `BotRequest` | BOT | запрос бота |
| `Heartbeat` | HEARTBEAT | presence (онлайн) |
| `ChatApproval` | APPROVAL | одобрение вступления |
| `Pin` | PIN | закреп сообщения |
| `CallingMessage` | CALLING | звонок |
| `ClearUserHistory` | CLEAR_HISTORY | очистка истории |
| `Reaction` | REACTIONS | реакции |
| `Notification` | NOTIFICATION | уведомление |
| `Vote` | VOTE | голос в опросе |
| `MeetingCallingMessage` | MEETING_CALLING | звонок встречи |
| `TranslationMessage` | TRANSLATION | перевод |
| `UserStatus` | USER_STATUS | статус/availability |

Числовой wire-enum типов: `TYPING=1, HEARTBEAT=2, SEENMARKER=3, PLAIN=4, STATESYNC=5,
SYSTEMMESSAGE=6, BOTREQUEST=7, REACTION=11, UPDATE_MESSAGES=19, TRANSLATION_MESSAGE=25, USER_STATUS=26`.

### 9.1 Общий конверт `ServerMessageInfo` (в каждом push)

```jsonc
"ServerMessageInfo": {
  "From": { "Guid": "..." },      // отправитель; CustomFrom для канала/анонима
  "CustomFrom": {},
  "Timestamp": 1699000000000000,  // микросекунды
  "SeqNo": 12345,                 // порядковый номер в чате
  "Version": 3,                   // растёт при правке/удалении того же сообщения
  "PrevTimestamp": 0,
  "LastEditTimestamp": 0,         // >0 => этот Plain это ПРАВКА
  "Deleted": false,               // true => этот Plain это УДАЛЕНИЕ
  "Views": 0, "ForwardCount": 0,
  "ThreadState": { "LastSeqNo": 0, "MentionTsMcs": [], "HistoryStartTsMcs": 0 }
}
```

### 9.2 Ключевые события (схемы после десериализации клиентом)

**PLAIN** (новое/правка/удаление) - `{ChatId, PayloadId, data:{payload}, forwarded, reactions,
threadState, views, readsCount, readsVersion, recentUserReads, seenByPartnerMcs}`.
- Правка: нет отдельного типа - PLAIN с `ServerMessageInfo.LastEditTimestamp>0` и ↑`Version`.
- Удаление: нет `RemoveMessage` - PLAIN с `ServerMessageInfo.Deleted=true` (пустой payload).

**SEEN_MARKER** (прочтение): `{chat_id, timestamp, seqno, guid(кто прочитал), version,
readsCount, readsVersion, seenByPartnerMcs}`. Плюс read-state едет и внутри PLAIN/REACTION
(`ReadsCount/ReadsVersion/ShowReadsCount/RecentUserReads[]{user,timestamp}/SeenByPartnerMcs`).

**TYPING**: `{guid, chat_id, type, processing:{text}, timeout_seconds}`.
`TypingType`: `TEXT=0, IMAGE=1, FILE=2, STICKER=3, VOICE=4, VIDEO=5, PROCESSING=6`.

**Presence - два механизма:**
- HEARTBEAT: `{guid, lastSeenMs, onlineDuration}`; `onlineUntil = lastSeenMs + onlineDuration*1000`.
  `HeartbeatType: UNKNOWN=0, BACKGROUND=1, FOREGROUND=2`.
- USER_STATUS: `{guid, availability, notificationMode, timestamp, duration,
  customStatus:{emoji,text,localizations,iconName}}`.

**REACTIONS**: `{reactions:[{type,count}], userReactions:[{user,type,timestamp}], version,
chatId, timestamp}`.

**Прочие**: STATE_SYNC `{payload:decode(Data), meta:{from}}` (мультидевайс, напр.
`chat_info_changed`); PIN `{chat_id, pinned_messages:[ts]}`; CLEAR_HISTORY `{chatId, seqNo, timestamp}`;
NOTIFICATION `{chatId, text, destinationGuid, timestamp}`; APPROVAL `{chat_id}`;
VOTE `{chatId, timestamp, choices, results, fromGuid}`; CALLING/MEETING_CALLING/TRANSLATION/BOT.

### 9.3 Как это ОТПРАВЛЯЕТСЯ (всё исходящее - через `push()`)

`push(e)` → `transport.push({ ClientMessage:{...e, LogData}, Meta:{Origin}, ClientSupportedFeatures })`
поверх того же WS.

| действие | отправка |
|----------|----------|
| набор текста | `push({ Typing:{ChatId} })`; расширенно `push({ TypingEnhanced:{...} })`; открытие чата `push({ ChatOpen })` |
| прочтение | `push({ SeenMarker:{ChatId,Timestamp,SeqNo,Version} })`; `push({ UnseenMarker:{...} })`; `push({ ReadMarker:{ChatId,Timestamps[]} })` |
| presence | `push({ Heartbeat:{Type} })` (FOREGROUND=2) |
| реакция | `push({ Reaction:{ChatId,Timestamp,Type,Action} })`; Action `REMOVE=1, REPLACE=2` |
| правка | `push({ Plain: convertMessageToPlain(...) })` (тот же ChatId+Timestamp) |
| удаление | `push({ Plain:{ChatId,Timestamp} })` (пустой Plain) |
| закреп | `push({ Pin:{ChatId,Timestamp?} })` |
| важность | `push({ UpdateFields:{ChatId,Timestamp,ImportanceFlag:1|2} })` |
| очистка истории | `push({ ClearUserHistory:{ChatId} })` |
| голос в опросе | `push({ Vote:{ChatId,Timestamp,Action,Choices} })`; `Action:0`=голосовать (единственное подтверждённое живьём значение), БЕЗ `Results` |

**Отправка текстового сообщения** = `push({ Plain: {ChatId, Text:{MessageText}, PayloadId, ...} })`
(payload-типы - см. §10). Ответ приходит как PLAIN-событие с `ServerMessageInfo`.

> Заметки: нет отдельных типов Remove/Edit (детект по `Deleted`/`LastEditTimestamp`).
> `UPDATE_MESSAGES=19` есть только в enum, рантайм-обработчика в бандле нет. Строковые значения
> `Availability`/`NotificationMode` за lookup-картами (только id enum).

## 10. HTTP registry methods - полный референс (63 метода)

**Контракт (все методы):** `this.request(method, params, opts)` → FormData `request =
JSON.stringify({method, params})` → POST `/messenger/api/registry/api/` → `{status, data}`
(мапперы работают над `data`). **`enableCSRF` по умолчанию true; `enableCSRF:!1` = read-only.**
Прочие opts: `retry:N`, `cancelToken`, `headers`, `url` (override endpoint).
Мапперы: `N.Mn`=deserialize user, `normalizeYambGroupChat`/`normalizeYambPrivateChat`=чаты,
`P.R`=результат мутации чата, `H.deserializeBuckets`, `deserealizeYambMeetingInfo`.

### Users & contacts
| method | fn | params | read | ответ |
|---|---|---|---|---|
| `get_users_data` | getUsers | `{guids}` | ✓ | `(data.users).map(user)` → `{users}` |
| `get_current_user_data` | getCurrentUser | - | | raw current-user |
| `get_user_by_nickname` | getUserByNickname | `{nickname}` | | `{user}` |
| `list_contacts` | getContacts | `{version, without_deleted}` | ✓ retry3 | **голый массив** users |
| `get_recommended_users` | getRecommendedContacts | `{version, limit:20}` | ✓ retry3 | `{users}` |
| `purge_contacts` | purgeContacts | - | | - |
| `request_fake_user` | requestFakeUser | opaque (`bind_phone_number`,`fake`,`guid`) | | - |
| `request_user` | requestRealUser | opaque (`user`) | | - |
| `staff_proxy` | getBulkGapUserInfo | `{guids, staff_method:"export_gaps"}` | | - |
| `remove_display_restriction` | removeDisplayRestriction | - | | `{user}` |

### Search & suggest
| method | fn | params | read | ответ |
|---|---|---|---|---|
| `search` | search | `{query, limit:10, entities, chat_id, suggest_chat_id, new_chat, invite_hash}` | ✓ | `Ae(data, entities)` |
| `get_suggest` | suggest | `{txt, limit:5, chat_id, invite_hash}` | ✓ | `{users}` |
| `get_members_and_contacts_suggest` | getMembersAndContactsSuggest | opaque (`chat_id`) | (cancelToken) | `{users, contacts, warnings}` |
| `get_organization_chat_suggest` | getOrganizationChatSuggest | opaque | (cancelToken) | `{contacts}` |
| `search_chat_members` | searchChatMembers | opaque | (cancelToken) | `{users, groups, departments}` |

### Chat info & members
| method | fn | params | read | ответ |
|---|---|---|---|---|
| `get_chats_info` (private) | getPrivateChatInfo | `{chat_id, supported_features:["should_return_alternative_accounts"]}` | ✓ | `data.chats[0]` |
| `get_chats_info` (group) | getGroupChatInfo | `{chat_id\|invite_hash, supported_features}` | ✓ | `data.chats[0]`; проверяет `errors[0].code` |
| `get_chat_members` | getChatMembers | opaque (`chat_id`, paging) | (cancelToken) | `{users, groups, departments}` |
| `get_group_members` | getGroupMembers | opaque | (cancelToken) | `{users(role="admin"), groups, departments}` |
| `activate_chat` | activateTransientChat | `{chat_id}` | | `{chat}` |

### Chat mutations (optimistic concurrency: retry с bump `version` через handleChatConflict)
| method | fn | params | ответ |
|---|---|---|---|
| `create_chat` | createChat | opaque | `P.R` |
| `create_private_chat` | createPrivateChat | `{guid, wait_for_update, onetime_user_token}` | normalizeCreatePrivateChat |
| `set_chat_info` | setChatInfo | `{chat_id, ...}` +`version` при retry | normalizeGroup |
| `change_chat_members` | changeChatMembers | `{chat_id, ...}` +version | `P.R` |
| `change_chat_role` | changeChatAdmins | `{...}` +version | `{chat, errors}` |
| `change_chat_admins` | changeChannelAdmins | `{...}` +version | `P.R` |
| `leave` | leaveChat | `{chat_id, version}` | - |
| `invite` | joinByHash | `{invite}` | normalizeGroup |
| `invite_renew` | renewInviteHash | `{chat_id, ...}` +version | normalizeGroup |
| `update_chat_organizations` | updateChatOrganizations | opaque | `{chat}` |
| `get_organizations` | getOrganizations | opaque | `{organizations}` |

### Chat settings
| method | fn | params | ответ |
|---|---|---|---|
| `get_chat_settings` | getChatSettings | `{chat_id, invite_hash}` | `ae` |
| `update_chat_settings` | setChatSettings | `{chat_id, member_rights, version}` | `ae` |

### Threads
| method | fn | params | ответ |
|---|---|---|---|
| `join_to_thread` | joinToThread | `{thread_id}` | `{chat_member}` |
| `leave_thread` | leaveThread | `{thread_id}` | `{chat_member}` |

### Messages & media
| method | fn | params | read | ответ |
|---|---|---|---|---|
| `get_media_messages` | getMediaMessages | `{chat_id, pivot_id, next:5, prev:5, types, query, invite_hash}` | ✓ | `{info, messages:map(deserializePlainMessageWrapped), metadata}` |
| `get_url_preview` | getUrlPreview | `{url, format:"full"}` | ✓ retry0 | `fe` |

### Files & disk
| method | fn | params | ответ |
|---|---|---|---|
| `add_files` | createFileByLocation | `{chat_id, files}` | `{file_id: data.files[0].id}` |
| `share_file` | shareFile | `{file_id, share_chat_id, chat_id, invite_hase(sic!)}` | `se` |
| `upload_to_disk` | getDiskUploadUrl | opaque | upload URL |
| `upload_remote_image` | uploadYaPictures | `{doc_id}` (opts `url:yaPicturesUrl`) | - |
| `get_disk_info` | getUserDiskInfo | - | retry3 | disk info |

### Buckets (клиентское sync-состояние)
| method | fn | params | ответ |
|---|---|---|---|
| `get_buckets` | getBuckets | `{version, versions}` | `{buckets}` |
| `get_bucket` | getBucket | `{bucket_name}` | `{buckets:[{version}]}` |
| `set_bucket` | setBucket | `{bucket_name, bucket_value, version}` | retry на version-mismatch |

### Meetings (Telemost)
| method | fn | params | ответ |
|---|---|---|---|
| `get_meetings_info` (reduced) | getReducedMeetingsInfo | `{reduced:true, meeting_ids}` | `{meeting_infos}` |
| `get_meetings_info` (full) | getFullMeetingInfo | `{meeting_ids:[id]}` | `meeting_infos[0]` |
| `create_meeting` | createMeeting | `{chat_id, supported_features}` | deserealizeYambMeetingInfo (hdr `X-Telemost-Env`) |
| `create_personal_meeting` | createPersonalMeeting | `{call_type, user_guid, supported_features}` | `{ringingId, meetingInfo}` |
| `end_personal_meeting` | endPersonalMeeting | `{meeting_id, action, details}` | - |
| `meeting_call` | meetingCall | `{meeting_id, guids, tz_offset_minutes}` | normalizeMeetingCall |

### Settings / experiments / onboarding / auth-tokens
| method | fn | params | ответ |
|---|---|---|---|
| `get_settings` | getSettings | - (opts) | settings |
| `set_settings` | setSettings | `{notifications_enabled, show_notification_text}` | - |
| `get_experiments` | getExperiments | - (opts) | experiments |
| `commit_onboarding_passed` | onboardCurrentUser | opaque | retry0 |
| `get_recommended_chats` | getRecommendedChats | `{limit:10}` | `{reqid, chats}` |
| `team_migration_info` | getTeamMigrationStatus | - | status |
| `create_token` | createToken | `{type:"onetime_user_token"}` | token |
| `resolve_token` | resolveOneTimeUserToken | `{token}` | `{user}` |
| `sync` | getSupportChatsSyncStatus | - (opts `url:supportApiUrl`) | support sync |

### Phone / push / SMS / alias
| method | fn | params | ответ |
|---|---|---|---|
| `set_phone` | bindPhone | `{phone_value}` | - |
| `set_phone_confirm` | confirmPhone | `{track_id, code}` | - |
| `send_welcome_sms` | sendSmsLink | `{}` | - |
| `set_push_token` | setPushToken | `params` + hdr `X-UUID` | - |
| `check_alias` | checkAlias | `{alias}` | - |

### Заметки для MCP
- **Read/write split:** `enableCSRF:!1` = read. `get_chat_members`/`get_group_members`/`*_suggest`
  тоже read, но через `cancelToken` без флага.
- **Optimistic concurrency:** `set_chat_info`, `change_chat_*`, `leave`, `invite_renew`,
  `set_bucket` требуют `version` и авто-ретрятся при конфликте.
- **`params`=undefined** у `get_settings`, `get_experiments`, `get_disk_info`, `sync`,
  `get_current_user_data`, `team_migration_info`, `purge_contacts`, `remove_display_restriction`.
- **Endpoint overrides:** `sync`→supportApiUrl, `upload_remote_image`→yaPicturesUrl.
- **Опечатка в бандле:** `share_file` param называется `invite_hase` (не `invite_hash`) - копировать как есть.

## 11. Типы тел сообщений (`ClientMessage.*`) - полные схемы

Все поля ниже - **точные wire JSON-ключи** (строковые литералы в бандле). Сериализаторы/декодеры
в модуле `normalizeMessage` (~837260). Маршаллер `k` = JSON-сериализатор для `CustomPayload`/`Card`.

**17 kinds** (сиблинги `Plain` внутри `ClientMessage`):
`Plain`, `Ephemeral` (=Plain, исчезающее), `SystemMessage`, `Reaction`, `Vote`, `Pin`,
`SeenMarker`, `Typing`, `Heartbeat`, `StateSync`, `BotRequest`, `ChatApproval`, `Notification`,
`ClearUserHistory`, `CallingMessage`, `MeetingCallingMessage`, `UserStatus`.

**Отсутствуют явно:** `RepliedMessage`/`Reply`/`ReplyMarkup`, отдельные `Location`/`Geo`/`Contact`.
**Ответы (reply) моделируются как форвард с цитатой** (`ForwardedMessageRefs` + `ForwardedMessageStyles.Quote`).

### 11.1 `ClientMessage.Plain` (и `.Ephemeral`)

```jsonc
{
  "ChatId": "",
  "PayloadId": "",                 // client message id
  "Timestamp": 0,                  // только при правке
  "MentionedUserIds": ["guid"],
  "ForwardedMessageRefs": [ { "ChatId": "", "Timestamp": 0 } ],  // форварды И reply
  "ForwardedMessageStyles": [ { "Quote": "<fragment>" } ],       // цитата reply
  "UrlPreviewDisabled": false,
  "IsImportant": false,
  "CustomPayload": "<json>",       // -> inlineButtons(.suggest[]) + customInput(.custom_input)
  "SuggestButtonsHolder": { "SuggestButtons"|"LayoutSuggestButtons": {...} },
  // РОВНО ОДНО content-поле:
  "Text":     { "MessageText": "", "Card": { "Card": "<json>" } },   // Card опционален
  "Sticker":  { "Id": "", "SetId": "" },
  "Image":    { "Width": 0, "Height": 0, "Animated": false, "FileInfo": {/*FileInfo*/} },
  "MiscFile": { "FileInfo": {/*FileInfo*/},
                "PreviewHint": { "VideoPreview": { "Width":0,"Height":0,"DurationMs":0,"BlurHash":"" } } },
  "Card":     { "Card": "<json>" },
  "Gallery":  { "Items": [ { "Image": {/*Image*/} } ], "Text": "" },
  "Voice":    { "FileInfo": {}, "Duration": 0, "Text": "", "WasRecognized": false,
                "Waveform": "", "DisableRecognition": false },
  "Poll":     { "Answers": [], "IsAnonymous": false, "MaxChoices": 0, "Title": "",
                "MyChoices": [], "Results": {/*PollResults*/} }   // MyChoices/Results - только ЧТЕНИЕ (см. ниже)
}
```

**FileInfo** (общий для Image/MiscFile/Voice/Gallery): `{ "Id2": "<mds-doc-id>", "Name": "",
"Size": 0, "Source": 0 }` - `Source` enum `MDS=0, DISK=1`. **На wire только `Id2` (doc id) +
Name/Size/Source; URL/bucket на wire НЕТ** - download/preview-URL строятся app-side из doc id.
Sticker использует `Id`/`SetId` (без FileInfo).

**`Poll` на СОЗДАНИИ (живьём, 2026-07-17):** ровно `{Title, Answers:[string,≥2], IsAnonymous,
MaxChoices}` - `MyChoices`/`Results` клиент не отправляет, сервер их сам заполняет на чтении.
`MaxChoices` кодирует галку «несколько ответов»: `1` - одиночный, `Answers.length` - множественный
(веб-UI даёт только бинарную галку, промежуточные лимиты не проверялись). `IsAnonymous` в ЧТЕНИИ
присутствует только если `true` (у не-анонимного ключа нет).

**PollResults (живьём, 2026-07-17):** `{ Version, VotedCount, Answers:[int] /* счётчики по вариантам,
index-aligned к Poll.Answers[] */, RecentVoters:[UserInfo] /* усечён, ОТСУТСТВУЕТ у анонимного опроса
даже по явному запросу */ }`. До первого голоса - пустой объект `{}`. `VotedCount` - число РАЗЛИЧНЫХ
проголосовавших (не сумма голосов: множественный выбор одного человека даёт несколько `Answers[i]++`,
но `VotedCount` не растёт). `Completed` из более ранней записи живьём не встречался - не подтверждён.
**SuggestButtons**: `{ Buttons:[{Id,Text,CallbackData,Directives}], Persist }` либо
`LayoutSuggestButtons:{ ButtonRows:[{Buttons:[...]}], Persist }`.

### 11.2 Общий конверт (`ServerMessageInfo` + сиблинги)

reads/reactions - **сиблинги `ClientMessage`**, не внутри него:
```jsonc
"ReadsCount":0, "ReadsVersion":0, "ShowReadsCount":false,
"RecentUserReads":[{ "UserInfo":{}, "Timestamp":0 }], "SeenByPartnerMcs":0,
"Reactions":[{ "Type":"👍", "Count":1 }],
"RecentUserReactions":[{ "UserInfo":{}, "Type":"👍", "Timestamp":0 }], "ReactionsVersion":0,
"ForwardedMessages":[{ "Payload":{}, "ServerMessageInfo":{} }], "MentionedUsers":[UserInfo], "Users":[UserInfo]
```
`ClientMessage` common: `{ NotificationBehaviour, IsSilent, PersistentInlineButtons, CustomPayload, LogData }`.

**`ForwardedMessages` - форма элемента наблюдена живьём** (2026-08-28, разбор в
[`docs/spikes/v2/SPIKE-FORWARD-FRAME.md`](spikes/v2/SPIKE-FORWARD-FRAME.md)). Обёртка -
`{Payload, ServerMessageInfo}`, где **`Payload` это САМО ТЕЛО** (`Text.MessageText`, `ChatId`
исходного чата, `PayloadId`, `CustomPayload`). Ключей `ClientMessage` и `Plain` в цепочке нет
вовсе - именно поэтому разбор, ожидавший `{ClientMessage, ServerMessageInfo}`, молча отбрасывал
каждый оригинал. Блок из нескольких пересылок приходит массивом элементов той же формы.
`Payload.ChatId` отличается от чата назначения, то есть адрес оригинала выводится из данных.
У элемента есть сиблинг `Meta:{Origin:int}`, значение не расшифровано. В том же кадре
`ForwardedMessageRefs` и `ForwardedMessageStyles` **не приходят вовсе**, поэтому `context`
у пересылки не строится.

**UserInfo** (`From`): `{ Guid, DisplayName, PublicName, AccountCategory(DOMAIN|INDIVIDUAL),
AvatarId, Version, LocalizationDescriptor:{Version,Default,Langs}, Localization:{<lang>:{DisplayName,AvatarId}},
IsRobot, RobotInfo:{IsSupport,CannotBeBlocked} }`. `CustomFrom` - per-chat override `{DisplayName,AvatarId,Localization}`.

### 11.3 `ClientMessage.SystemMessage` (событие чата, ровно один вариант данных)

```jsonc
{ "ChatId":"", "PayloadId":"",
  "ChatCreatedInfo":        { "InitialInfo": { "Name":"", "Description":"" } },
  "ChatInfoDiff":           { "Name":"", "Description":"", "AvatarUrl":"" },
  "CallInfo":               { "CallGuid":"", "Status":0, "Duration":0 },
  "ParticipantsChangedDiff":{ "AddedUsers":[], "RemovedUsers":[] },
  "ParticipantsChangedDiffV2":{ "AddedUsers":[], "RemovedUsers":[],
        "AddedGroups":[{GroupId,Name,Version,OrganizationId}], "RemovedGroups":[],
        "AddedDepartments":[{DepartmentId,Name,Version,OrganizationId}], "RemovedDepartments":[], "GuestsGuids":[] },
  "UserAction":0,           // LEAVE|ENTER|ENTER_BY_LINK
  "GenericMessage":         { "MessageText":"", "LocKey":"" },
  "MeetingStartedMessage":  { "MeetingId":"" },
  "MeetingEndedMessage":    { "MeetingId":"" },
  "PersonalMeetingEndedMessage":{ "MeetingId":"", "Reason":0, "DurationSeconds":0, "CallType":0 } }
```

### 11.4 Прочие kinds (wire-поля)

```jsonc
"Reaction":  { "Timestamp":0, "ChatId":"" }
"Vote":      { "ChatId":"", "Timestamp":0, "Action":0, "Choices":[] }
"Pin":       { "ChatId":"", "Timestamp":0 }
"SeenMarker":{ "ChatId":"", "Timestamp":0, "SeqNo":0, "Version2":0, "Version":0 }
"Typing":    { "ChatId":"", "Type":0, "TimeoutSeconds":0, "Processing":{ "Text":{ "MessageText":"" } } }
"Heartbeat": { "OnlineUntil":0 }
"StateSync": { "Data":"<serialized>" }
"BotRequest":{ "ChatId":"", "CustomPayload":"<json>", "ActionId":"", "Suggest":{ "Buttons":[...] } }
"ChatApproval":{ "ChatId":"" }
"Notification":{ "ChatId":"", "ToGuid":"", "Text":{ "NotificationText":"" } }
"ClearUserHistory":{ "ChatId":"" }
"CallingMessage":{ "ChatId":"", "CallGuid":"", "IncomingCall":{ "CallType":0 } }  // AUDIO|VIDEO
"MeetingCallingMessage":{ "RingingId":"", "IncomingCall":{MeetingInfo,CallSettings},
   "Ringing":{ToGuid}, "RingingEnded":{}, "NotifyRinging":{}, "EndOutgoingRinging":{}, "EndRinging":{} }
```

**`Vote` (живьём, 2026-07-17, Status:1 FULLY_COMMITTED):** ровно 4 ключа `{ChatId, Timestamp,
Action, Choices}`. Прежняя запись ошибалась в двух местах - отсюда `BACKEND_CALL_ERROR(2)`:
(1) не хватало обязательного `Action` (`0` = отдать голос; без него прокси-слой не парсит запрос,
та же природа ошибки, что у `Reaction` без `Type`, см. §17.12); (2) лишнее поле `Results` - это
read-only агрегат сервера, в исходящем голосе он мусор и слаться не должен. `Choices` - массив
0-based индексов в `Poll.Answers[]` (не id, не строки), причём это ПОЛНЫЙ набор выбора, а не diff:
множественный выбор кладёт все выбранные индексы в один массив за один `push`. **Смена голоса
подтверждена живьём (2026-07-17, третий прогон):** повторная отправка `Vote{Action:0, Choices}` с
другим набором ЗАМЕНЯЕТ прежний выбор целиком - повторный `poll_info` показал `MyChoices`
сменившимся с `[0]` на `[1]`. Отзыв голоса до нуля (пустой `Choices` либо иной `Action`) из
веб-UI по-прежнему недостижим (кнопки нет ни у одиночного, ни у множественного опроса после
голосования) и протоколом не подтверждён.

**CustomPayload** = JSON-строка. `.suggest[]` → inline-кнопки `{title,url,text,callbackData}`;
`.custom_input` → customInput.

## 12. Файлы, медиа, вложения

### 12.1 Загрузка (два способа по `source`)

**A. Disk (крупные файлы/картинки) - 3 шага** (`DiskFileUploader.uploadFiles({file, chatId, normalizedFileName})`):
1. `getDiskUploadUrl({ files:[{ name, upload_id(uuid), size, chat_id }] })` → RPC `upload_to_disk`
   → `{ files:[{ upload_url }] }`. Ошибки: 507/403 quota, 413 size.
2. HTTP **PUT сырых байт** на `upload_url` (`transport.diskHttpPut`) → возвращает заголовок **`Location`**.
3. `createFileByLocation({ chatId, files:[{ location }] })` → RPC `add_files` → `{ file_id: files[0].id }`.

**B. Direct** (`transport.uploadFile(url, file)`) - URL из config по ключу:
`fileUploadUrl` {chatId,messageId,filename}, `fileVoiceUploadUrl` {chatId,wasRecognized},
`chatAvatarUploadUrl` {chatId}, `createChatAvatarUploadUrl`. Плюс `upload_remote_image` `{doc_id}`
(перезалив remote-картинки, opts `url:yaPicturesUrl`).

**Ссылка на файл в сообщении:** после загрузки получаешь `fileId`, дальше обычное сообщение с
`file_info.id = fileId`. Исходящие payload:
- image: `{width,height,preview_url,original_preview_url,animated, file_info:{id,size,name,source}}`
- file: `{file:{file_info:{id,size,name,source}, previewHint:{videoPreview:{width,height,durationMs,blurHash}}}}`
- voice: `{voice:{file_info:{...}, duration, text, was_recognized, waveform, disable_recognition}}`
- gallery: `{gallery:{items:[{...,file_info:{...}}], text}}`

`share_file` (форвард файла): `{ file_id, share_chat_id, chat_id, invite_hase(sic!) }`.

### 12.2 Построение URL скачивания/аватаров - шаблоны в runtime-config

**ВАЖНО:** реальные хосты НЕ в бандле. Каждый media-URL строится `configRegistry.get("<key>", params)` -
шаблоны инжектятся из app-config в рантайме. Бандл даёт только набор ключей + params.
Реальные хосты - из живого config (`tools.messenger.yandex.net/config.json` или bootstrap-config),
не из JS.

Ключи download (пустая строка если нет `file_info.id`):
| ключ | params |
|---|---|
| `imagePreviewUrl` / `imagePublicPreviewUrl` | `{fileId, size}` |
| `voicePlayUrl` | `{fileId}` |
| `fileDownloadUrl` | `{chatId(enc), fileId, filename(enc)}` |
| `videoStreamsUrl` / `videoStreamsPublicUrl` | `{fileId}` |
| `docViewerUrl` / `docViewerPublicUrl` | `{fileId}` |
| `pollDownloadUrl` | `{pollId: "<chatId>_<timestamp>"}` |

Аватар `E(avatarId, {size, isPublic})` - ветвление по regex `avatarId`:
`user_avatar/yapic/(.+)`→`yapicAvatarUrl`; `user_avatar/mssngr/(.+)`→`mssngrAvatarUrl`;
иначе public→`publicAvatarUrl`, private→`privateAvatarUrl`(+`&selectedUid=<puid>`).
`size` enum: SMALL / SMALL48 / MIDDLE2048 / ORIGINAL.

**Шаблоны + резолвнутые хосты (сняты из живого config, для yandex.ru → tld=ru):**
- `filePrivateHost` = `files.messenger.yandex.ru`
- `filePublicHost` = `files.messenger.yandex.net`
- `yapicFileHost` = `avatars.mds.yandex.net`

Итоговые URL:
```
image preview: https://files.messenger.yandex.ru/file_shortterm/{fileId}?size={size}
file download: https://files.messenger.yandex.ru/file_shortterm/{fileId}?attach=true
voice play:    https://files.messenger.yandex.ru/file_shortterm/{fileId}
video streams: https://files.messenger.yandex.ru/video_streams/{fileId}
docviewer:     https://files.messenger.yandex.ru/docviewer_link/{fileId}
file upload:   https://files.messenger.yandex.ru/media_upload/{chatId}/{messageId}/{filename}
voice upload:  https://files.messenger.yandex.ru/voice_upload/{chatId}?recognized={wasRecognized}
private avatar:https://files.messenger.yandex.ru/{avatarId}?size={size}   (+&selectedUid=<puid>)
public avatar: https://files.messenger.yandex.net/{avatarId}?size={size}
yapic avatar:  https://avatars.mds.yandex.net/get-yapic/{avatarId}/{size}
mssngr avatar: https://avatars.mds.yandex.net/get-mssngr/{avatarId}/{size}
```
(доступ к `file_shortterm` требует той же auth-сессии, что и API - §4.)

### 12.3 `get_media_messages` + типы

`{ chat_id, pivot_id, next:5, prev:5, types, query, invite_hash }` (enableCSRF:false).
Ответ `{ info, messages(map deserializePlainMessageWrapped), metadata }`. Пагинация - курсор `pivot_id`
+ симметричные prev/next.
`types` - массив из content-type enum: `card, file, gallery, image, text, sticker, voice, poll` (+`link`).
Точный набор фильтр-строк не выжил в минификации (частичный пробел).

### 12.4 file_info и медиа-схемы (client shapes)

- `file_info = { id, name, size, source(MDS=0|DISK=1) }` - универсальная ссылка на вложение.
- `image = { width, height, file_info, animated }` (+ preview_url/original_preview_url).
- `gallery = { items:[image], text }`; `file = { file_info, previewHint?:{videoPreview} }`.
- `voice = { duration, text, was_recognized, waveform, file_info, disable_recognition }`.
- `sticker = { id, set_id }`; `poll = { answers, isAnonymous, maxChoices, myChoices, results, title }`.
- Wrapper: `type ∈ {plain, system, unknown}`; delivery `∈ {pending, sent, seen, failed}`.

### 12.5 `get_url_preview`

`{ url, format:"full" }` → discriminated union: `preview`(web `{title,description,image.src}`) |
`chat`(`{chat_id,name,member_count}`) | `user`(`{guid,display_name}`) | `message`(цитата +mentioned_users).

> Заметка: `bucket` (get_bucket/set_bucket) - это KV-состояние чата, НЕ объектное хранилище файлов.

## 13. Авторизация - детальный механизм (уточняет §4)

> Этот раздел уточняет §4. Важная поправка: в OAuth-режиме WS авторизуется `oauth_token`
> в **первом synchronize-state кадре**, а НЕ заголовком `Authorization` на WS-handshake.

### 13.1 Выбор режима
Нет единого тернарника. Решают два входа:
- **feature-flag `waitToken`** = реальный OAuth-переключатель. Если `waitToken` true → OAuth-режим:
  клиент НЕ открывает WS и ждёт токен. Иначе → cookie-режим (стартует на браузерных cookie).
- **URL-параметр `authType`** (виджет/passport-путь). `"own"` = просить логин у parent-окна.
Пер-запросный тип - функция `getAuthType(url)` → `"oauth"`/`"cookie"`.

### 13.2 Получение OAuth-токена - инжектится ХОСТОМ, не минтится в бандле
**В бандле НЕТ OAuth authorize-flow** (0 вхождений `client_id`, `response_type`, `oauth.yandex`,
`passport.yandex`, `/authorize`, `scope=`). Токен приходит от встраивающего хоста через `postMessage`:
- `{type:"oauth", payload:"<raw-token>"}` → клиент строит `Authorization: OAuth <raw-token>`.
- `{type:"auth", payload:{token:"<full-header>"}}` → берётся дословно (уже с префиксом `OAuth `).
- channel-регистрация (storage-access widget): `{authToken, authPartition}`.
Применяет токен `ll(t)`: ставит на registry/api-транспорты, на url-preview, на uniproxy WS-config
(`oauthToken`), затем открывает WS и монтирует приложение. Формат токена: `OAuth <value>`.

### 13.3 HTTP-заголовки в OAuth-режиме
`setAuthorizationHeader`: `Authorization = token`, `withCredentials=false`, при partition -
`X-Passp-Partition`. Динамический интерцептор добавляет: `X-Uid:<uid>`, `X-Request-Id:<uuid>`,
опц. `X-Ya-Organization-Id:<orgId>`; при наличии oauthToken **удаляет Cookie и Origin**.
RPC: `POST <apiUrl>`, body `FormData{request: JSON.stringify({method, params})}`, плюс
`X-Request-Attempt`, `X-Origin-Service-ID:<serviceId>`.
**`uid` - отдельное config-значение, НЕ выводится из токена** - MCP должен передать его сам.

### 13.4 CSRF - только cookie-режим
`isCsrfEnabled = csrfTokenEnabled && !oauthToken` - **при наличии OAuth-токена CSRF полностью
пропускается**. В cookie-режиме: `POST <csrfTokenUrl>` (method `csrf_token`), токен в `X-CSRF-TOKEN`
на запросах с флагом `enableCSRF`; на 403 - сброс и ретрай.

### 13.5 WebSocket auth - по режимам (ВАЖНО)
Два WS-транспорта (выбор по флагу `xiva`):
- **uniproxy** `j.$d = new g(config("websocketUrl"), config("uniproxyApiKey"))`.
- **xiva** `j.UZ` (`name=xivaServiceName`, `workspaceId`, random `session`) - это то, что снято в
  живом трафике (`wss://push.yandex.ru/v2/subscribe/websocket`, cookie-режим).

Первый кадр после connect - synchronize-state config:
```jsonc
{ "auth_token": "<uniproxyApiKey>", "oauth_token": "<token>", "uuid": "<random>",
  "Messenger": { "version": "<apiVersion>" } }
```
- **OAuth-режим:** auth = `oauth_token` в этом ПЕРВОМ КАДРЕ (не в URL, не в handshake-заголовке).
- **cookie-режим:** auth в URL-query `user=<puid>` + `secretSign` (secretSign берётся из API
  `request_user`, `setCredentials{user, secretSign}`). Токена в URL нет.

Нюанс: `ll` ставит токен на uniproxy (`j.$d`), а на xiva (`j.UZ`) только флажок `secretSignNeeded`.
Похоже, OAuth-режим развёрнут с uniproxy-транспортом; корректность связки xiva+oauth не подтверждена.

### 13.6 Обновление сессии
`invalid_cookies`/401: **в OAuth-режиме клиент просто ОСТАНАВЛИВАЕТСЯ, ин-клиент рефреша токена
НЕТ** - жизненный цикл токена целиком на хосте. В cookie-режиме - редирект на Passport
(`passportSetSessguardUrl`/`passportAuthUrl`) для перелогина.

### 13.7 Рекомендация для MCP (headless Node)
Чистый OAuth-режим, без cookie/CSRF:
1. Получить Yandex OAuth-токен **вне бандла** (client_id/scope внутри нет) + отдельно **числовой uid**.
2. **HTTP:** `POST <apiUrl>` FormData `{request:JSON({method,params})}`, заголовки
   `Authorization: OAuth <token>`, `X-Uid:<uid>`, `X-Request-Id:<uuid>`, `X-Origin-Service-ID:<serviceId>`,
   опц. `X-Ya-Organization-Id`. Без Cookie, без CSRF.
3. **WS:** открыть uniproxy-сокет, первым кадром synchronize-state
   `{auth_token:<uniproxyApiKey>, oauth_token:<token>, uuid:<random>, Messenger:{version:<apiVersion>}}`.

### 13.8 Открытые вопросы (критично перед реализацией)
1. **Минт токена** - как получить валидный Yandex OAuth-токен + scope для мессенджера
   (client_id/scope не в бандле; вероятно регистрация OAuth-приложения на oauth.yandex.ru,
   либо тот же токен, что инжектит нативный webview).
2. **Config-значения** - реальные `apiUrl`, `websocketUrl`/`xivaUrl`, `uniproxyApiKey`,
   `xivaServiceName`, `serviceId`, `apiVersion`, `workspaceId` инжектятся сервером (SSR + `/config.json`).
   Снять из задеплоенного config (часть уже известна из живого трафика, см. §2/§12).
3. **uid в OAuth-режиме** - подтвердить, что за uid передаёт хост; принимает ли API запрос без uid.
4. **uniproxy frame envelope** - точная обёртка synchronize-state и событий (см. §2.2 и wsproto).

## 14. WebSocket-протокол - deep dive

WS-транспорт = класс `ye` (тонкие обёртки над `this.get(payload, method, opts)` и `this.push`).
Параметры строит сервисный класс `x` (webpack 19553). `chatHistory`/`chatsHistory` - алиасы, оба
шлют WS-метод `history`.

### 14.1 Пайплайн запроса
```
service.requestX(params) -> transport.history(body,opts) -> ye.get(body,"history",opts)
  -> get: r = {RequestId: uuid(), ...body}   // RequestId впрыскивается в КАЖДЫЙ payload
  -> serialize(r) + xiva.sendRequest(blob, index, "history", ...)
```
- `push(e)`: `{RequestId, ClientTransportId:createClientTransportId(), UserAgent, ...e}`.
- `subscribe(e)`: `{ClientTransportId:{XivaSubscriptionId}, UserAgent, ...e}`.
- `XivaSubscriptionId` = `this.subscriptionId` из operation-кадра `subscribed` (`subscription-id`).

### 14.2 `history` - все варианты параметров
Superset полей по всем call-site:
```jsonc
{ "ChatId":"", "ChatIds":[""], "Limit":0, "Offset":0,
  "MaxTimestamp":123, "MinTimestamp":123,       // callers: ts+1 (excl. upper), ts-1
  "InviteHash":"", "DropPersonalFields":true, "HasMeeting":true, "Threads":true,
  "ChatDataFilter":{},                           // на практике всегда пустой флаг-объект
  "MessageDataFilter":{ "DropPayload":true, "OnlyTimestamps":true, "DropThreadParentMessage":true },
  "TranslationDataFilter":{ "LanguageCode":"ru", "TranslationFor":["<guid>"] } }
```
Конкретные builders:
- `getChat`: `{ChatId, InviteHash, Limit:0, ChatDataFilter:{}}` → getChatFromHistoryResponse
- fetchMessages: `{ChatId, InviteHash, Limit:i+(offset?1:0), MaxTimestamp:n?n+1:undefined, Offset, MinTimestamp}`
- requestMessage: `{ChatId, MaxTimestamp:n+1, Limit:1, InviteHash, MessageDataFilter:dropPayload?{DropPayload:true}:undefined}`
- requestMeetings: `{Limit:0, HasMeeting:true}` → deserializeMeetings
- requestCounters: `{ChatId, MaxTimestamp:r+1, MinTimestamp:i-1, DropPersonalFields, InviteHash, ChatDataFilter:{}, MessageDataFilter:{DropPayload:true}, Limit, TranslationDataFilter}` → normalizeCounters
- requestThreadsParentMessages: `{Threads:true, ChatIds:e, ChatDataFilter:{}, Limit:0}`
- getUndeliveredThreads: `{MessageDataFilter:{OnlyTimestamps:true,DropPayload:true,DropThreadParentMessage:r}, MinTimestamp, Threads:true, Limit:0}`
- requestLastMessages: `{MessageDataFilter:{OnlyTimestamps:true,DropPayload:true}, MinTimestamp, Threads, Limit:0}`

Ответ: `normalizeHistory` → `{histories:[{chat, messages:[…]}]}`. Per-chat partial errors: chat-entry
может нести свой `Status`. `Reverse`/`Inverse` - НЕ поля history.

### 14.3 Остальные WS-методы
```jsonc
message_info: { ChatId, Timestamp, InviteHash }  -> { Message, MyReactions:[…] }
edit_history: { ChatId, InviteHash, MinTimestamp, Limit:50 }  -> normalizeEditHistory
poll_info:    { ChatId, Timestamp, Limit:50, AnswerFilter:{AnswerId,MaxTimestamp}?,
                ForwardedMessageRef:{ChatId,Timestamp}?, ReturnResults:true }
              -> без голосов:        { Results:{} }
              -> с голосами, не-анон: { Results:{Version,VotedCount,Answers:[int],RecentVoters:[UserInfo]},
                 MyChoices:[int],
                 AnswerVotes:[{AnswerId?(0-based,опущен при 0), TotalCount:int, Votes:[{Timestamp,UserInfo}]}] }
              -> с голосами, аноним:  { Results:{Version,VotedCount,Answers:[int]}, MyChoices:[int] }
                 // аноним: AnswerVotes и Results.RecentVoters сервер НЕ отдаёт даже по ReturnResults:true
list_reactions:{ ChatId, Timestamp, InviteHash, Limit:50, MaxTimestamp:<cursor>, Mode }
              -> { UserReactions:[…], UserReads:[…] }
whoami:       { Guid }  -> { UserInfo, UserStatusInfo, CurrentTime }
                          -> {avatar_id, display_name, guid, uid, nickname, gender, phone_id,
                              registration_status, is_onboarded, organizations}
subscribe:    { ChatId, InviteHash, TtlMcs, MessageBodyType, TranslationDataFilter,
                ClientSupportedFeatures, ClientTransportId:{XivaSubscriptionId}, UserAgent }
              // presence: { ToGuid, TtlMcs, MessageBodyType:HEARTBEAT, ClientSupportedFeatures }
              // статусы:  { ToGuids:[guid], TtlMcs, MessageBodyTypes:[USER_STATUS], ClientSupportedFeatures }
```
`TtlMcs` = длительность подписки в мкс. `ClientSupportedFeatures` - **integer-битмаска** (не массив):
сейчас только `EPHEMERICAL=1` → значение `0` или `1` при включённом флаге.

### 14.4 `push` - все мутации через один метод
`push(e)` → `createMessage(e)` = `{ClientMessage:{...e, LogData:{YandexUid, UserInterface?}},
Meta:{Origin:serviceId||0}, ClientSupportedFeatures}` + транспорт добавляет `{RequestId,
ClientTransportId, UserAgent}`. Варианты `ClientMessage` - см. §9.3/§11.

Полный список push-вариантов (доп. к §9.3): `{Plain,NotificationBehaviour}`(send),
`{Plain:{ChatId,Timestamp}}`(delete), `Heartbeat`, `Typing`, `TypingEnhanced`, `ChatOpen`,
`SeenMarker`, `UnseenMarker`, `ReadMarker`, `Reaction`, `UpdateFields`(importance), `Vote`,
`Pin`, `ClearUserHistory`, **`Report:{MessageRef|ChatId|UserId, Reason}}`** (жалоба на спам/абьюз),
`BotRequest`, `CallingMessage`, `MeetingCallingMessage`, `UserStatus`, `ChatApproval`.

**Ответ на push** (`deserializePushResponse`):
```jsonc
{ "status": <commit-status>,
  "messageInfo": { "version", "prevTimestamp":PrevTimestampMcs, "timestamp":TimestampMcs, "seqno":SeqNo },
  "rate_limit": { "wait_for": RateLimit.WaitFor }? }   // при троттлинге
```
Успех = `status FULLY_COMMITTED(1)`; дубликат = `DUPLICATE(8)`.

### 14.5 Credentials (не в кадрах данных)
Живут в Xiva connection-config (класс `E`), участвуют в handshake/URL, НЕ в per-request JSON.
Форма: `{ user:{uid, guid}, secretSign }` (нужен `uid` ИЛИ `guid` ИЛИ `secretSign`). В кадры идут
только `ClientTransportId:{XivaSubscriptionId}` + `UserAgent` (на subscribe/push) и `Meta.Origin`
(=serviceId) внутри ClientMessage. Close-reasons сброса креды: `bad sign`, `cookie auth failed`,
`no credentials` → `clearCredentials()` + `secretSignNeeded=true`.

### 14.6 Формат ошибок - три слоя
1. **Transport** - кадр `PROXY_STATUS`, header `[reqId, errorCode]`. errorCode:
   `SUCCESS=0, PROTOCOL_ERROR=1, BACKEND_CALL_ERROR=2, INTERNAL_ERROR=3, CORRUPTED_DATA_HEADER=4,
   BACKEND_NOT_FOUND=5, SERVICE_UNAVAILABLE=6, TOO_MANY_REQUESTS=7, FRAME_TOO_LARGE=8`.
2. **Application** - DATA-кадр с ненулевым `Status` в JSON. `ResponseStatus`:
   `SUCCESS=0, INTERNAL_ERROR=1, ACCESS_DENIED=2, MISCONFIGURATION=3, ENTITY_NOT_FOUND=4,
   OVERLOAD=5, UNAUTHORIZED=6`. Error-объект читает `response.Details`, `response.RequestId`.
3. **Push commit status** (`pt.status`):
   `UNCOMMMITED=0, FULLY_COMMITTED=1, UNIPROXY_COMMITTED=2, FAILED=3, NO_SUCH_CHAT=4, NOT_LEADING=5,
   FOREIGN_PARTITION=6, SENDER_NOT_IN_CHAT=7, DUPLICATE=8, POSTPROC_COMMITTED=9, KIKIMR_WRITE_FAILED=10,
   MESSAGE_NOT_FOUND=11, DEQUEUED_AFTER_ERROR=12, BAD_REQUEST=13, FILESHARE_FAILED=14, NO_PERMISSION=15,
   CONFLICT=16, NO_SUCH_USER=17, THROTTLED=18, BANNED=19, BLACKLISTED=20, NOT_FOUND=21, SPAM_DETECTED=22,
   RATE_LIMIT_EXCEEDED=23, BLOCKED_BY_PRIVACY_SETTINGS=24, PUSH_UNAUTHORIZED=25`.
Поля `Retriable` НЕТ - ретрай решается по close-code/типу ошибки.

### 14.7 Reconnect / ping
- **Transport ping** (server-initiated): сервер шлёт operation-кадр `{operation:"ping",
  "server-interval-sec":N}`. На open ждёт первый ping ≤5с; на ping сбрасывает таймаут на `1.3×interval`
  (default 60→78с) и переводит соединение в OPEN. На таймаут - close, reconnect делает внешний
  контроллер (`open()` переподписывается). Клиент НЕ шлёт ping/pong.
- Прочие operation-кадры: `subscribed` (ставит subscriptionId), `unsubscribe` (close+clearCredentials),
  `xivaws-error`.
- **App-level heartbeat** (presence) - `push({Heartbeat:{Type}})`, отдельно от WS-ping.

### 14.8 RequestId vs seq - два разных ID
- **seq/reqId** (msgpack-заголовок, корреляция транспорта): per-connection счётчик, старт `1`,
  +1 на запрос; **на reconnect сбрасывается в 1** (`drop()`→`seqNo=1`). Матчинг ответа - по `reqId`
  в заголовке входящего DATA/PROXY_STATUS.
- **RequestId** (JSON, backend-корреляция): `M8("xxxxxxxx-xxxx-xxxx-xxxxxxxx")` - random hex 8-4-4-8
  (26 hex + 3 дефиса), **НЕ канонический uuid v4**. Впрыскивается в каждый get/push payload.

### 14.9 Frame encoding - подтверждение
- Data section (маршаллер `X`): `ArrayBuffer(12); setUint8(0,5)` → `0x05`+11 нулей + utf8(JSON).
  deserialize срезает первые 12 байт и парсит JSON.
- Header `He(reqId, serviceIndex, method, blob)`: msgpack `DATA(1)`=`0x01`, fixarray[3]=`0x93`,
  `serviceIndex`(uint), `reqId`(uint), `method`(str).
- **Полный исходящий кадр** = `0x01` + `MessagePack([serviceIndex, reqId, method])` + `0x05` + 11×`0x00` + JSON.
- Входящие схемы: `DATA(1)` `[serviceIndex, reqId, path]`+payload; `PROXY_STATUS(2)` `[reqId, errorCode]`;
  `PUSH(3)` `[uid, service, event, transitId]`+payload (server-initiated → onPush).

> Заметка: сам WS-URL и сборка URL с `secretSign` - не в этом бандле (URL из config `websocketUrl`,
> низкоуровневый Xiva-connect вероятно в отдельном worker-чанке). Есть параллельный HTTP-транспорт
> uniproxy (маршаллер `K.U`), который разворачивает `e.ServerMessage`; WS-путь (`ye`) - не разворачивает.

## 15. Config-значения (сняты из живой сессии yandex.ru, резолвнуты)

`yandexDomain=yandex, tld=ru, apiHost=yandex.ru`:

| config-ключ | значение |
|---|---|
| `apiPrefix` | `https://yandex.ru/messenger/api/registry` |
| **`apiUrl`** (HTTP RPC) | `https://yandex.ru/messenger/api/registry/api/` |
| **`csrfTokenUrl`** | `https://yandex.ru/messenger/api/registry/csrf-token/` |
| `supportApiUrl` | `https://yandex.ru/messenger/api/registry/support/` |
| `yaPicturesUrl` | `https://files.messenger.yandex.ru/api/` |
| **`websocketUrl`** (uniproxy) | `wss://uniproxy.messenger.yandex.ru/uni.ws` |
| **`xivaUrl`** | `wss://push.yandex.ru/v2/subscribe/websocket{query}` |
| `xivaServiceName` | `messenger-prod` |
| **`serviceId`** (X-Origin-Service-ID) | `27` |
| **`apiVersion`** (Messenger version) | `5` |
| `client` | `1000` |
| `filePrivateHost` | `files.messenger.yandex.ru` |
| `filePublicHost` | `files.messenger.yandex.net` |
| `yapicFileHost` | `avatars.mds.yandex.net` |
| `workspaceId` | не снят → дефолт `"main"` (из бандла) |
| **`uniproxyApiKey`** (`auth_token` WS sync-state) | `069b6659-984b-4c5f-880e-aaedcfd84102` |

`uniproxyApiKey` - **статический клиентский ключ уни-прокси, одинаковый для всех** (не личный
секрет; вшит в веб-клиент). Идёт как `auth_token` в первом synchronize-state кадре (§13.5).

**Xiva `{query}`** (из живого трафика):
`?service=messenger-prod:version5*common+version5*main&session=<random>&client=web_main&user=<uid>`.

## 16. OAuth: какое приложение нужно (разбор)

Короткий ответ: **чистого «зарегистрируй OAuth-приложение со scope X» пути, скорее всего, НЕТ** -
registry messenger это внутренний API Яндекса, публичного OAuth-scope для него в кабинете
oauth.yandex.ru не выдаётся. Разбор по путям:

### Факт: сам веб работает в cookie-режиме
В снятом трафике WS-URL нёс `session=`+`user=` (без `oauth_token`), а HTTP шёл с CSRF - значит
**веб-клиент авторизуется cookie, не OAuth**. OAuth-режим (`waitToken`) включается только когда
мессенджер встроен как webview в нативное приложение, и токен ему передаёт хост. То есть OAuth -
не «более правильный» путь, а путь для встраивания.

### Пути для MCP (по надёжности)

**1. Cookie-режим - проще всего, гарантированно работает (это делает сам веб).**
Никакого OAuth-приложения. Нужно:
- Cookie Паспорта (`Session_id`, `sessionid2`, ...) - один раз залогиниться (headless-браузер/QR),
  дальше сессия живёт и рефрешится.
- CSRF-токен из `csrf-token` (§15) для мутирующих HTTP.
- Для WS (xiva, cookie-режим): `user=<puid>` + `secretSign` из метода `request_user`
  (`setCredentials{user, secretSign}`, §14.5). Токен `oauth_token` не нужен.
Минус: cookie истекают/привязаны к устройству. Плюс: работает сегодня, без регистрации чего-либо.

**2. OAuth-токен нативного клиента - долгоживущий, но нужен чужой client_id.**
Мобильные приложения Яндекса (Мессенджер / Яндекс Go / Яндекс с Алисой) ходят в тот же API с
`Authorization: OAuth <token>`. API принимает токены, выданные на **их** `client_id` со внутренним
messenger-scope. Достаётся реверсом трафика мобильного приложения (перехватить его OAuth-токен либо
его `client_id` и повторить flow `oauth.yandex.ru/authorize?response_type=token&client_id=<...>`).
Это стандартный способ для внутренних API Яндекса. Токен потом идёт в §13.7 (HTTP-заголовки + WS sync-state).

**3. Своё приложение на oauth.yandex.ru - скорее всего НЕ подойдёт.**
Создать app можно (тип «Веб-сервисы» с redirect URI, implicit `response_type=token`), но в списке
scope мессенджера нет - доступные scope (`login:info`, Диск, Почта, 360 и т.п.) не дают доступа к
registry-мессенджеру. Токен со стандартным scope API, вероятно, отклонит. Проверять эмпирически, но
рассчитывать не стоит.

### Рекомендация
Для личного MCP начинать с **пути 1 (cookie)** - он доказанно рабочий и не требует OAuth-приложения.
Если нужна долгоживущая безбраузерная auth - **путь 2** (client_id мобильного клиента). Путь 3
(своя регистрация) держать как эксперимент, не как план.

## Приложение: как это собиралось

1. headed Playwright (`playwright-cli`) с залогиненной сессией yandex.ru/chat.
2. `page.addInitScript` с перехватчиком `fetch`/`XMLHttpRequest`/`WebSocket` до скриптов
   страницы + reload - чтобы поймать WS-хендшейк и все кадры.
3. Клики по чатам/скролл для триггера `history`; выгрузка `window.__cap` в файл.
4. Скачивание и grep клиентского бандла `app.js` для полного каталога методов и схем.

Приватный контент переписок в захвате редактировался; в документ вошли только структуры.

## 17. Поправки из живого захвата (2026-07-16/17, spike для MCP)

Headed-Playwright захваты (клиент `chats-web/3.22.0`). Секреты не приводятся, только структура. Артефакты: `.omc/spikes/yandex-mcp/`.

> ⚠️ **Читать §17.1 внимательно: первая редакция этого раздела была ОШИБОЧНОЙ.** Захват 2026-07-16 сняли с **гостевой** (незалогиненной) сессии и приняли за норму. Перезахват 2026-07-17 на залогиненной сессии опроверг. Ниже — исправленная версия.

**17.1 Гость vs залогиненный: два разных handshake (ПОДТВЕРЖДАЕТ §2.1/§4/§15, отменяет прежнюю «поправку»).**

Залогиненная сессия (реальный аккаунт), query:
```
?service=messenger-prod:version5*common+version5*main&session=<4x4hex>&client=web_main&user=<числовой uid>
```
- **Ни `sign`, ни `ts` в URL НЕТ. Cookie-only handshake работает** — WS открывается и качает трафик. То есть §2.1/§4/§15 («в URL токена нет, только случайный session»; «user = числовой uid») **верны**.
- **`user=` — числовой uid** (наблюдался ровно тот же `<numeric-uid>`, что в примере §2.1).

Гостевая (незалогиненная) сессия, query:
```
...&client=web_main&sign=<32-hex>&ts=<unix-sec>&user=<GUID>
```
- У гостя появляются `sign`+`ts`, а `user` вырождается в GUID.
- Объяснение из бандла: `this.uid = uid?.toString() || n.guid` — у гостя нет числового uid, отсюда фоллбэк на guid. `secretSignNeeded` взводится только на close-reason `COOKIE_AUTH_FAILED`/`NO_CREDENTIALS` либо под OAuth.
- **Вывод: `secretSign` — это фоллбэк для гостя / заблокированной cookie-авторизации, а НЕ нормальный путь.** Для MCP на залогиненном аккаунте он не нужен.

**17.2 Отправка (`push`) использует Xiva subscription-id, app-level `subscribe` НЕ нужен (правит/уточняет §2.6 vs §14.1). ПОДТВЕРЖДЕНО на залогиненной сессии.** На connect Xiva присылает операционный текст-кадр `{operation:"subscribed", subscription-id:<40hex>, uid, service, event}`. Наблюдаемый `push.ClientTransportId.XivaSubscriptionId` **точно равен** этому `subscription-id`. Heartbeat-push вернул `Status:1` (FULLY_COMMITTED). Вывод: `createClientTransportId()` (§14.1) оборачивает subscription-id из операционного кадра; отдельный app-level chat-`subscribe` (§2.6) нужен только для LIVE-подписки на чат, не для отправки.

Нюанс залогиненной сессии: веб-клиент шлёт **много** app-level `subscribe` (по одному на чат — их у гостя просто не было). Но порядок доказывает независимость: первый `push` ушёл **раньше** первого app-level `subscribe` (позиции 3 и 6 в потоке sent) и получил `Status:1`. Также в recv наблюдался метод `delivery` (в каталоге §2.3 отсутствует).

**17.3 Подтверждено без изменений:** frame codec §2.2/§14.9 (энкод даёт точные байты, декод по длине заголовка игнорирует коллизию `0x05` при seq=5 — валидировано оффлайн, 13/13); server-ping `{operation:"ping", server-interval-sec:60}` (§14.7).

**17.4 `request_user` — что он реально отдаёт (правит §10; отменяет прежнюю «поправку» про sign).**

Живой вызов на **залогиненной** сессии: `{status:"ok", data:{user:{guid, uid, ...}}}` — **никаких `secret_sign`/`sign`/`ts` в ответе нет**. (Прежняя редакция §17.4 утверждала обратное — она снята с гостевой сессии, где secretSign действительно выдаётся как фоллбэк, см. §17.1.)

- **Params: `{bind_phone_number: false}`** (снято с веб-клиента; §10 числил их opaque).
- **Требует CSRF**: без `X-CSRF-TOKEN` → 403 `bad_csrf_token`. Это единственное известное исключение из «read-методы идут без CSRF» — прочие read (напр. `list_contacts`) на голой cookie работают.
- Клиент троттлит вызов через localStorage-ключ `requestUserLastTime`.
- **Зачем он нужен MCP:** отдаёт **числовой uid**, без которого не собрать WS-URL (`user=<uid>`), а `whoami` живёт ЗА WS — курица-яйцо. То есть `request_user` = HTTP-источник uid до открытия сокета, а не источник подписи.
- Маппинг веток из бандла: `("user" in e) ? {user:a(e.user), secretSign:e.secret_sign} : {user:c(e), secretSign:{sign:e.sign, ts:e.ts}}` — вторая ветка (sign/ts) и есть гостевой путь.

**17.5 В `search` НЕТ page-based пагинации (правит §3.3).** Свип `limit` на живом аккаунте (bucket `users`, query `"а"`):
`limit=1→total=1`, `limit=5→total=5`, `limit=10/20/50/100→total=7` (плато), `count`=`total`, **`pages`=1 всегда**.
- **`total` = число возвращённых элементов** (`min(limit, реальное)`), а НЕ общее число совпадений. Реальное количество ищется поднятием `limit` до плато.
- **`page`/`pages` вестигиальны** (всегда 1). Параметры `page`/`offset`/`from`/`skip`/`page_number` сервер **игнорирует** (проверены все пять: `respPage` остаётся 1, элемент не меняется).
- **Дефолтный `limit` = 5** (§3.3 говорит 10).
- Пагинация делается **через `limit`**: если `total == limit` — возможно есть ещё, поднять `limit`; `total < limit` = найдено всё. Серверный потолок `limit` не установлен.
- Поиск требует нормальных термов: односимвольные/стоп-слова дают 0-1.

**17.7 WS-URL: `service` обязан быть PERCENT-ENCODED (правит §2.1/§15 — там URL записан декодированным).**
Живая строка веб-клиента:
```
?service=messenger-prod%3Aversion5*common%2Bversion5*main&session=...&client=web_main&user=<uid>
```
`:` → `%3A`, `+` → `%2B`, `*` остаётся литералом. **Слать литеральный `+` НЕЛЬЗЯ** — в query это пробел, и сервер закрывает сокет с `4400 invalid argument "service"`. Во всех прежних записях (§2.1, §15, §17.1) URL приведён в ДЕКОДИРОВАННОМ виде, потому что снимался через `URL.searchParams`, который показывает `%2B` как `+`. Собирать query через `URLSearchParams` (правила x-www-form-urlencoded) — совпадает байт-в-байт, включая порядок `service/session/client/user`. Проверять регрессией на **сырую** строку: assert по декодированной эту ошибку не ловит.

**17.8 Мелкие поправки, найденные при реализации.**
- **§14.8 «26 hex» — арифметическая описка.** В самом шаблоне `xxxxxxxx-xxxx-xxxx-xxxxxxxx` ровно 8+4+4+8 = **24** hex (общая длина 27). Шаблон снят с кода и первичен.
- **Баг в артефакте спайка `spike4-framecodec.mjs`** (не в протоколе): в `decStr` для str16 (`0xda`) стоял `start = off + 2`, должно `off + 3` (тег + 2 байта длины). Латентный — имена методов короче 256 байт, ветка не выполнялась. В репо-версии `frameCodec.ts` исправлено и покрыто тестом.
- Xiva шлёт операционный `subscribed` **сразу** после апгрейда: слушатели надо вешать ДО ожидания open, иначе кадр теряется.

**17.9 Вложения: скачивание — три поправки к §12.2 (сняты живьём при реализации).**
- **`FileInfo.Id2` СОДЕРЖИТ `/`**: реальная форма `<bucket>/<uuid>` (напр. `aaaa/999a9a9a-...`, длина 41). **Нельзя гнать его через `encodeURIComponent` целиком** — `/` станет `%2F` и запрос даст **404**. Валидировать/кодировать посегментно.
- **`file_shortterm` отвечает `302`, а не байтами** — редирект на storage-хост, скачивание обязано следовать за ним (дефолт `fetch`).
- **Таблица параметров `fileDownloadUrl` в §12.2 неверна** (`{chatId, fileId, filename}`). Живой шаблон из app-config: `https://{filePrivateHost}/file_shortterm/{fileId}?attach=true` — **только `{fileId}`**. `chatId`/`filename` на провод не идут.
- `Content-Disposition` присутствует всегда, RFC 5987 (`filename*=UTF-8''`). Его имя **не всегда** равно `FileInfo.Name` (наблюдался файл, где они разошлись: кириллица vs латиница) — авторитетным считать `FileInfo.Name`, C-D только фоллбэк.
- `?size=MIDDLE2048` вернул **байт-в-байт то же**, что оригинал (294561). Либо картинка меньше кэпа, либо size здесь игнорируется — **не проверено**, ресайз превью не подтверждён.

**17.10 Треды: серверного создания НЕТ (закрывает пробел §2.4/§10).** Снято анализом бандла (актуальный хеш `0x421b6bd`; UI-логика живёт в чанках `ui`/`quick-access-panel`, в `app.js` её нет).
- Кнопка «Обсудить» (`write_in_thread`, scope `btn_go_to_thread` — не «create») **не ходит в сеть**. `thread_id` выводится чистой строковой функцией из `ChatId` родителя + `Timestamp` сообщения:
  `группа 0/0/<uuid>` → `100/0/<uuid>_<ts>`; `канал 1/…` → `101/…`; `приватный <guid>_<guid>` → `110/0/<guid>_<guid>_<ts>`.
- **Тред = чат, `thread_id` = `ChatId`.** Открытие треда = обычный `history {ChatId:<thread_id>, ChatDataFilter:{}}`. Пустой тред → сервер отдаёт `ENTITY_NOT_FOUND`, клиент **синтезирует его локально**. На сервере тред материализуется **первым `push({Plain:{ChatId:<thread_id>}})`**; `convertMessageToPlain` не несёт ни одного тред-поля.
- `join_to_thread`/`leave_thread` (§10) — это **подписка**, а не создание (внутри названы `subscribeToThread`, отдают `{chat_member}`).
- Ответ `history` треда несёт `ThreadParentMessage` **внутри** — отдельный запрос родителя не нужен.
- ⚠️ В бандле `parseInt(prefix, 2)` (**radix 2**): бизнес-чат `2/…` даёт `NaN` → тред недоступен. Обратный парсер использует radix 10 — **пара несимметрична**. Для реализации брать `100+parseInt(prefix,10)`, radix 2 не копировать.

**17.11 Join-ссылка: `<message_id>` — это `Timestamp` (закрывает вопрос резолва).** Найден и парсер, и билдер ссылок.
- Маршруты: `/join/:hash/:timestamp?` и `/join/:hash/:timestamp/:threadMessageTimestamp`.
- **Отдельного message-id в протоколе НЕТ**: хвост ссылки = `Timestamp` (мкс, 16 цифр), тот же, что уходит в `message_info {ChatId, Timestamp}`.
- `<hash>` = `invite_hash` чата (с провода `ChatInfo.InviteHash`), прогнан через `encodeURIComponent`.
- Резолв: HTTP `get_chats_info` **без CSRF**, params строго один из трёх: `{chat_ids:[…]}` ЛИБО `{alias}` ЛИБО `{invite_hash}`.
- Трёхсегментная ссылка = сообщение в треде: 2-й сегмент → построить `thread_id` (§17.10), 3-й → `Timestamp` внутри треда. У треда `alias` гасится — адресуется только через `invite_hash` родителя.

**17.12 Реакции и прочтения (правит §9.3 и §14.3). Снято живыми вызовами.**
- **`Reaction.Type` — INT, а не emoji** (§9.3 показывает `Type:"👍"` — неверно). Свип: `"👍"` → `BACKEND_CALL_ERROR(2)`; `"1"` → то же; **`1` (int)** → `Status:1`. Без `Type` сервер: `"Reaction Type is required for ADD/REPLACE actions"`. **Таблицы `int → emoji` в исследовании нет** — нужна отдельная выемка из бандла.
- **`list_reactions` НЕ отдаёт `{UserReactions, UserReads}` вместе** (§14.3 неверна). `Mode` — дискриминатор: дефолт/`0`/`2` → `UserReactions`; **`Mode:1` → `UserReads` + `ReadsCount`**; `3` → ошибка. Без `Mode:1` прочтения не придут никогда.
- Формы: `UserReactions[] = {Type:int, Timestamp:int(мкс, время постановки), UserInfo{...}}`; `UserReads[] = {Timestamp:int(мкс, время прочтения), UserInfo{...}}`.
- **Сиблинги `history` обрезаны**: живьём `ReadsCount:10` при `RecentUserReads` длиной **3**. Полный список — только `list_reactions Mode:1`. Сиблингов для полной картины НЕ хватает.
- `message_info` → `{Message, ErrorInfo, MyReactions?:[int], ChatInfo}`. `ErrorInfo`/`ChatInfo` в §14.3 отсутствуют; **`MyReactions` исчезает как ключ**, когда своей реакции нет.
- Семантика: отсутствие `UserReads` = «прочтения не отслеживаются», а НЕ «никто не читал».

**17.13 `DropPayload:true` срезает и `ServerMessageInfo.From`.** Под этим фильтром автор сообщения неопределим — не принимать отсутствие `From` за «сообщение не моё». Не описано в §2.4/§14.2.

**17.14 Форматирование: entities НЕТ, подтверждено живьём (§11.1 верна).** Отправлены `**bold**`, `` `code` ``, блок кода, `>quote`, `[link](url)` — **строка вернулась байт-в-байт той же**, markdown-символы как есть. `Text` несёт ровно один ключ `MessageText`; `Card` не появился; ranges/entities/spans нет ни в `Plain`, ни в сиблингах. Разметку рисует клиент.

**17.6 Ошибки каталога методов (правит §10).**
- **`get_current_user_data` НЕ СУЩЕСТВУЕТ**: `{code:"No such path", source:"yamb"}` даже с валидным CSRF. Идентичность брать из WS `whoami` (§2.5).
- **`get_organizations` требует `organization_ids`**: без него `{code:"bad_request", text:"organization_ids is required"}`.
- **`csrf-token` возвращает `{token}` голым**, без обёртки `{status,data}` (уточняет §3.1).
- **entity `contacts` невалиден** для `search` (`status:"error"`); валидны `messages`/`users`/`chats`. Уточнение живого прогона 2026-07-17: сервер отвечает конкретно `{code:"bad_request", text:"entities are required"}` — он выбрасывает невалидную entity из списка и падает на «списке без валидных entity». Текст о настоящей причине не говорит, поэтому клиент обязан отвергать `contacts` **на входе**.

**17.9 Форма ответа `history` на реальном профиле (правит §2.4; снято при реализации Phase 4, 13 чатов).**

Ключи элемента `Chats[]`: `ChatId, ChatInfo?, PartnerInfo?, PrivateChatInfo?, Counters, LastSeqNo, LastTsMcs, LastSeenByMeSeqNo, LastSeenByMeTsMcs, LastSeenSeqNo, LastSeenTsMcs, LastEditTsMcs?, Muted?, MyRole, ApprovedByMe?, ApproximateOnlineUserCount, LastModeratedRange?`.

- **`LastMessage` в элементе чата НЕТ** — ни при `Limit:0`, ни вообще. Сигнатура `{CurrentTime, LastMessage, RequestId}` из §2.4 к ответу `history` на список чатов отношения не имеет. Последнее сообщение даёт **`Limit:1`**: тогда каждый чат несёт `Messages[1]`, и метка этого сообщения совпала с `LastTsMcs` у **13/13** чатов — то есть это ровно последнее сообщение, одним вызовом на весь список. Для `list_chats` правильный вызов — `{Limit:1, ChatDataFilter:{}}`, а не `Limit:0`.
- **ИСТОЧНИК НЕПРОЧИТАННОГО — сам `history`**: `LastSeqNo - LastSeenByMeSeqNo`. **Отдельный counters-вызов (§14.2 `requestCounters` → `normalizeCounters`) НЕ НУЖЕН.**
- **ЛОВУШКА ИМЕНИ:** поле `Counters` в ответе на роль непрочитанного **НЕ годится** — живьём оно несёт `{HiddenMessageCount, TotalMessageCount}`, то есть объём чата, а не непрочитанное.
- Имя чата: приватный — `PartnerInfo.DisplayName` (10/13), групповой — `ChatInfo.Name` (3/13). Признак приватного — наличие `PrivateChatInfo`.
- **`MaxTimestamp` — ИСКЛЮЧАЮЩАЯ верхняя граница** (эмпирически): `MaxTimestamp = newest+1` возвращает сообщение с меткой newest, `MaxTimestamp = newest` возвращает уже предыдущее. Согласуется с §14.2 (`requestMessage` адресует метку n через `MaxTimestamp: n+1`). Следствие для пагинации: курсор «дальше» = метка самого старого сообщения страницы, **без правки на -1**.
- Страница приходит **от старых к новым** (`Messages[0]` — самое старое).
- Ключи `ServerMessageInfo` живьём: `Deleted, From, LastEditTimestamp, PrevTimestamp, SeqNo, ThreadState, Timestamp, Version`. Ключи `Plain` текстового сообщения: `ChatId, CustomPayload, PayloadId, Text`. Набор ключей `FileInfo` — ровно `{Id2, Name, Size, Source}` (§11.1 подтверждён).
- **Элементы бакета `messages` в HTTP-поиске имеют форму `{ClientMessage, ServerMessageInfo}`** — ту же, что `Messages[].ServerMessage` в `history`, но без обёртки `ServerMessage`. Один нормализатор покрывает оба источника.
- Элемент бакета `chats`: `{data:{chat_id, name, members_count, ...}, entity, matches, member_count, type:"chats"}` — даёт ChatId напрямую. Элемент бакета `users`: `{data:{guid, display_name, uid, ...}, entity, matches, type:"users_pvp"}`.
- **Серверный потолок `limit` в `search` не обнаружен**: `limit=500` и `limit=1000` отвечают штатно. Свип §17.5 воспроизведён точно (`1→1`, `5→5`, `10/20/50/100→7`, `pages`=1 всегда).

**17.15 `poll_info` отдаёт только `Results`, вопрос/варианты/лимит выбора лежат в теле сообщения (правит §14.3, живьём: 2026-07-17).** Прежняя запись §14.3 утверждала, что `poll_info` возвращает `{answerVotes, myChoices, results}` - это была доко-выведенная догадка, живой прогон её опроверг.

- **Живой `poll_info {ChatId, Timestamp, Limit:50, ReturnResults:true}` ответил РОВНО `{Results:{}}`** (пусто до первого голоса), ключей `answerVotes`/`myChoices` в ответе нет вообще.
- **Вопрос, варианты и лимит выбора читаются из тела сообщения**: `message_info {ChatId, Timestamp}` даёт `Message.ServerMessage.ClientMessage.Plain.Poll = {Title, Answers:[string], MaxChoices:int, Results:{}}`. `Answers` - массив СТРОК (не объектов); индекс элемента в массиве - адрес варианта для `Vote.Choices` (§11.4).
- `Poll.Results` в теле - тот же агрегат, что и верхний `poll_info.Results`, просто снятый до похода за ним отдельным вызовом; тоже пуст до голосов.
- Как выглядит `Results` с голосами и как он мапится на конкретный вариант (по индексу? по объекту с полем-именем варианта?), живьём НЕ снято: первый голос не сделан (создание/голос в опросе за пределами self-чата не проверялись). Форма «мой выбор» (`myChoices`/`MyChoices`) до голосования тоже не наблюдалась ни в одном из двух ответов, уточняется после живого голоса.
- **Уточнение (живьём, 2026-07-17, второй прогон - после первого голоса и после создания опроса вне self-чата):** пустой `{Results:{}}` - это состояние «голосов ещё нет», а НЕ поломка метода и НЕ признак «это не опрос» (признак опроса - только `Plain.Poll` в теле, см. выше). Метод рабочий: с появлением первого голоса `poll_info` начинает возвращать содержательный `Results`/`MyChoices`/`AnswerVotes` - полный разбор в §17.16.

**17.16 `poll_info` с голосами: `AnswerVotes`/`Results`/`MyChoices`, и как сервер прячет голосующих в анонимном опросе (правит/дополняет §11.1/§11.4/§14.3/§17.15, живьём: 2026-07-17, второй прогон в чате "mcp test" - клик по реальному UI, кадры перехвачены патчем `WebSocket.prototype.send`).**

- **Голос (`Vote`) - см. правку §11.4/§9.3.** Клик «Проголосовать» дал `Status:1 FULLY_COMMITTED`; тело - ровно `{ChatId, Timestamp, Action:0, Choices}`, без `Results`.
- **Смена голоса подтверждена живьём (третий прогон):** повторная отправка `Vote{Action:0, Choices}` с другим набором индексов дала `commit_status:1 FULLY_COMMITTED`; последующий `poll_info` показал `MyChoices` сменившимся с `[0]` на `[1]` - повторная отправка ЗАМЕНЯЕТ прежний выбор целиком, а не добавляет к нему. Отзыв голоса до нуля (пустой `Choices` или иной `Action`) по-прежнему не проверен - кнопки в UI нет.
- **`poll_info` с голосами (не-анонимный опрос)** отдаёт:
  ```jsonc
  {
    "Results": { "Version": …, "VotedCount": 1, "Answers": [1,1], "RecentVoters": [ {UserInfo} ] },
    "MyChoices": [0, 1],
    "AnswerVotes": [
      { /*AnswerId:0 опущен*/ "TotalCount": 1, "Votes": [ { "Timestamp": …, "UserInfo": {…} } ] },
      { "AnswerId": 1,        "TotalCount": 1, "Votes": [ { "Timestamp": …, "UserInfo": {…} } ] }
    ]
  }
  ```
  `AnswerVotes[]` - детальный разбор «кто и когда»: один элемент на каждый вариант, у которого ЕСТЬ голоса. `AnswerId` - 0-based индекс варианта, **опущен, когда индекс = 0** (дальше `1`, `2`, …). `Votes[].Timestamp` - мкс, время конкретного голоса; `UserInfo` = `{Guid, DisplayName, AvatarId, Version, Uid}`. `Results.Answers[i]` - счётчик голосов по позиции варианта (index-aligned к `Poll.Answers[]`); `VotedCount` - число РАЗЛИЧНЫХ проголосовавших, а не сумма `Answers[]` (во множественном один человек с `Choices:[0,1]` даёт `Answers:[1,1]`, но `VotedCount:1`). Та же тройка `Results`/`MyChoices` едет и в теле сообщения (`Plain.Poll`), кроме `AnswerVotes` - он только в `poll_info`.
- **Анонимный опрос - сервер СКРЫВАЕТ голосующих, не только в UI.** Тот же запрос `poll_info {…, ReturnResults:true}` против опроса с `Plain.Poll.IsAnonymous:true` (признак анонимности в теле; ключ присутствует только при `true`) вернул:
  ```jsonc
  { "Results": { "Version": …, "VotedCount": 1, "Answers": [1,0] },   // ← НЕТ RecentVoters
    "MyChoices": [0] }                                                // ← свой голос виден
  // ← ключа AnswerVotes НЕТ ВООБЩЕ
  ```
  Отличия от не-анонимного: `Results.RecentVoters[]` и `poll_info.AnswerVotes[]` отсутствуют как ключи (не пустые массивы - ОТСУТСТВУЮТ); агрегат по вариантам (`Results.Answers[]`, `VotedCount`) и свой выбор (`MyChoices`) видны всегда. **Узнать, кто голосовал в анонимном опросе, невозможно** - `poll_info` вырезает эти поля даже по явному запросу; вызывать его за списком голосующих анонимного опроса бессмысленно, вернётся голый агрегат.
- **`Limit`** веб слал `10` (не `50`) - похоже, это пагинация голосующих на вариант; для длинных списков курсор - `AnswerFilter:{AnswerId, MaxTimestamp}` (§14.3), живьём не прогонялся (порог обрезки не достигнут при 1 голосе).
- **Осталось неясным:** значение `Action` для отзыва голоса до нуля (веб-UI не предлагает эту кнопку; смена голоса подтверждена - см. выше и §11.4, повторная отправка заменяет выбор); порог усечения `RecentVoters`/пагинация `AnswerVotes` (не проявились при 1 голосе); закрытие/удаление опроса (в меню создания таких опций нет); точное wire-поле «отправить без звука» (не в `Poll`, кандидат - `ClientMessage.NotificationBehaviour` из §11.2, отдельно не сверено).
