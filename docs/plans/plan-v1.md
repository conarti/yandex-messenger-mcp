# Work Plan: Yandex Messenger MCP (v1, standalone)

Status: pending approval
Mode: RALPLAN-DR DELIBERATE (ревизия после Architect SOUND_WITH_CONCERNS + Critic REJECTED)
Source spec: `.omc/specs/deep-interview-yandex-messenger-mcp.md` (ambiguity 11%, PASSED)
Protocol source of truth: `yandex-messenger-api-research.md` (reverse of `chats-web/3.21.0`; живые поправки - §17, снято с `chats-web/3.22.0`)
Spike source of truth: `.omc/spikes/yandex-mcp/SPIKE-RESULTS.md` (все 5 спайков закрыты 2026-07-16; auth-выводы перезахвачены и исправлены 2026-07-17 - прежние сняты с ГОСТЕВОЙ сессии; при расхождении со старыми §-утверждениями приоритет у §17 + SPIKE-RESULTS)
Target: отдельный репозиторий, вне монорепо devflow, без зависимости от `@devflow/core`

> Ревизия: применены обязательные правки Critic (подтверждены Architect). Сводка в конце файла — секция `## Changelog`.

---

## Requirements Summary

Построить standalone MCP-сервер (Node.js + TypeScript, stdio-транспорт) для Яндекс Мессенджера, дающий агенту читать переписку, искать, читать вложения и отправлять текст от имени пользователя.

Инструменты v1 (ровно пять):
1. `list_chats` - список чатов, сортировка по свежести, флаг непрочитанных, `limit` (дефолт 50), опц. `unread_only`. Через WS `history` с `Limit:0` (§2.4). **Источник флага непрочитанных подтверждается спайком/фикстурой** (§14.2 requestCounters, строка 1030) - см. SPIKE-проверку в Phase 4; если `Limit:0` не несёт unread, добавляется отдельный вызов counters.
2. `get_history` - страница сообщений чата с пагинацией по `MaxTimestamp`/`Offset`; принимает `ChatId` или текстовый запрос; при неоднозначности возвращает кандидатов, не гадает. Вложения не качает, отдаёт только рефы. Курсор-таймстемпы (мкс, 16 цифр) обрабатываются как string/BigInt, арифметика `MaxTimestamp=n+1` / `MinTimestamp=i-1` (§14.2 строки 1019/1027-1030) идёт по BigInt, не по float.
3. `search` - полноценный поиск по `messages`/`users`/`chats` через HTTP registry (`enableCSRF:false`). **Page-based пагинации в API НЕТ** (SPIKE 2, отрицательный результат; §17.5): `page`/`pages` вестигиальны (всегда 1), параметры `page`/`offset`/`from`/`skip`/`page_number` сервером игнорируются, `total` = число ВОЗВРАЩЁННЫХ элементов = `min(limit, реальное)`. Полнота достигается **эскалацией `limit`**: `total == limit` то возможно есть ещё, поднять `limit` и перезапросить; `total < limit` (плато) = найдено всё. Дефолтный `limit` сервера = 5 (не 10, как утверждает §3.3). Entity `contacts` НЕ поддерживается (§17.6).
4. `send_message` - двухшаговый draft то confirm: первый вызов возвращает превью и не отправляет; отправка только при `confirm:true` после ре-верификации чата. Через WS `push` `Plain.Text` (§14.4). **Механизм `ClientTransportId` разрешён спайком push↔subscribe (§17.2):** app-level chat-`subscribe` для отправки НЕ нужен; `XivaSubscriptionId` берётся из операционного текст-кадра `{operation:"subscribed", subscription-id:<40hex>}`, который Xiva шлёт автоматически на connect.
5. `download_attachment` - по требованию скачивает вложение по рефу в папку загрузок, возвращает локальный путь; работает для картинок и произвольных файлов (§12.2).

Auth = cookie-режим (путь 1 из §16): Playwright с persist-профилем логинится раз (headed, QR/пароль), профиль хранит и рефрешит cookie Паспорта. Node-клиент (undici + ws) гоняет протокол на извлечённых cookie. Браузер поднимается только для логина и рефреша при 401. **v1 - единый xiva/cookie транспорт.** Слой авторизации абстрагирован тонким швом (одна функция инъекции `AuthContext` = `{cookieHeader, userUid, userGuid, yandexUid, secretSign?}`), но сборку WS-URL выполняет сам WS-клиент.

> **Правка по спайкам (§17.1/§17.4, перезахват на залогиненной сессии 2026-07-17):** **cookie-only handshake РАБОТАЕТ.** Реальный URL залогиненной сессии: `wss://push.yandex.ru/v2/subscribe/websocket?service=messenger-prod:version5*common+version5*main&session=<4x4hex>&client=web_main&user=<числовой uid>` - **ни `sign`, ни `ts` в URL НЕТ**. Исходные §2.1/§4/§15 («в URL токена нет, только случайный session»; «user = числовой uid») **подтверждены**; прежние «поправки» плана (подписанный URL, `user`=GUID) были сняты с **ГОСТЕВОЙ** сессии и отменены.
> **`secretSign` - фоллбэк ГОСТЯ / заблокированной cookie-авторизации, а НЕ нормальный путь** (`secretSignNeeded` взводится только на close-reason `COOKIE_AUTH_FAILED`/`NO_CREDENTIALS` либо под OAuth; у гостя нет числового uid, фоллбэк `uid?.toString() || n.guid` даёт GUID - отсюда гостевые sign+ts). В `AuthContext` поле `secretSign?` **опционально** и в v1 на cookie-пути не заполняется.
> **`request_user` НЕ отдаёт sign**: ответ `{status:"ok", data:{user:{guid, uid, ...}}}`, params `{bind_phone_number:false}`, **требует CSRF** (без `X-CSRF-TOKEN` то 403 `bad_csrf_token`) - единственное исключение среди read-методов. Он нужен как HTTP-источник **числового uid** для сборки WS-URL до открытия сокета: `whoami` живёт ЗА WS (курица-яйцо).
> Роли идентификаторов: `userUid` (числовой) то `user=` в WS-URL; `userGuid` то конструирование приватного ChatId (§5). Флоу: cookie то CSRF то POST `request_user` то `uid` то сборка WS-URL. OAuth - НЕ бесплатное расширение через порт: это ОТДЕЛЬНЫЙ транспорт uniproxy с иным frame envelope (см. Принцип 2, ADR, Fork(a)); в v1 не реализуется и явно потребует нового WS-клиента.

WebSocket обязателен: `history` и `push` идут ТОЛЬКО по WS (§1), даже без real-time подписок. HTTP registry покрывает search, метаданные, файлы.

Артефакты в `~/.config/yandex-messenger-mcp/`: `config.json`, `profile/` (Playwright persist), `downloads/` (вложения). Автоочистка загрузок по TTL (дефолт 7 дней). First-run auth авто при первом вызове.

Non-goals v1 (§9 отложены): real-time подписки на LIVE-события и обработка потока событий (typing/seen/presence/новые сообщения), бот/автоответы, отправка файлов/голосовых, реакции/правка/удаление/read-маркеры/закреп/опросы, звонки (Telemost), управление чатами, мульти-аккаунт, чистый OAuth без браузера.

> **Важно (правка Non-goals, РАЗРЕШЕНО спайком push↔subscribe, §17.2):** app-level chat-`subscribe` для отправки НЕ нужен - он остаётся отложенным (только для LIVE-событий). Но в scope v1 входит **чтение транспортного операционного кадра** `{operation:"subscribed", subscription-id:"<40hex>", uid, service, event}`, который Xiva присылает автоматически после connect: из него берётся `XivaSubscriptionId` для `push`. Это транспортная механика WS-клиента, а не подписка на чат.

---

## RALPLAN-DR (Deliberate)

### Principles

1. **Protocol fidelity.** `yandex-messenger-api-research.md` - источник истины по wire-протоколу, где §17 (поправки из живого захвата) + `.omc/spikes/yandex-mcp/SPIKE-RESULTS.md` **имеют приоритет над старыми §-утверждениями**. Никаких выдуманных хостов, полей, значений. Расхождения в доке закрыты спайками, а не догадкой: `user=` это **числовой uid** (§17.1 ПОДТВЕРЖДАЕТ §2.1/§15; гостевой GUID - фоллбэк); WS-URL **не подписан**, cookie-only handshake достаточен (§17.1 подтверждает §4/§15); `request_user` даёт uid, а не sign (§17.4); `ClientTransportId` оборачивает Xiva subscription-id из операционного кадра (§17.2 разрешает §14.1 vs §2.6).
   **Дисциплина захвата (урок ревизии 3):** протокольный вывод принимается только с сессии, **доказанно залогиненной по данным** (`Session_id` + непустой список чатов в трафике), а не по косвенным признакам. Гостевая сессия не падает - она тихо уходит в фоллбэк-ветку и выдаёт правдоподобный, но чужой протокол. Ревизия 2 приняла ровно этот артефакт за истину.
2. **Cookie-only transport в v1; auth-инъекция за тонким швом.** Транспорты не ветвятся по режиму: v1 - единый xiva/cookie WS + HTTP (CSRF только для `request_user`, §17.4). Слой авторизации абстрагирован ОДНОЙ функцией инъекции `AuthContext` = `{cookieHeader, userUid, userGuid, yandexUid, secretSign?}` (+ fake для тестов). `secretSign` **опционален и в v1 не заполняется**: на cookie-пути WS-URL не подписан, а secretSign - гостевой фоллбэк (§17.1/§17.4). Обязательное из HTTP до сокета - **числовой `userUid`** через `request_user`. **OAuth - НЕ второй адаптер за тем же портом.** OAuth в бандле - это ДРУГОЙ транспорт: uniproxy `wss://uniproxy.messenger.yandex.ru/uni.ws` (§15 строка 1139) с auth `oauth_token` в ПЕРВОМ synchronize-state кадре (§13.5 строка 968, §13.7 строки 986-987) и с НЕИЗВЕСТНЫМ frame envelope (§13.8 п.4 строка 997). Порт даёт единый способ инжектить auth, но НЕ даёт «OAuth без правок транспорта»: OAuth потребует нового `UniproxyWsClient` с иной обёрткой кадров. Поэтому в v1 OAuth-скаффолдинг (`getWsSyncState`, `websocketUrl`, `uniproxyApiKey`) не тащим - YAGNI.
3. **Safety-first на необратимом.** `send_message` только draft то confirm с ре-верификацией ChatId; push никогда не ретраится вслепую; `DUPLICATE(8)` трактуется как идемпотентный успех (§14.4/§14.6).
4. **Spike-before-build - ВЫПОЛНЕНО (2026-07-16; auth-часть перезахвачена 2026-07-17).** Все 5 спайков закрыты живыми экспериментами ДО основной реализации; артефакты в `.omc/spikes/yandex-mcp/`, сводка в `SPIKE-RESULTS.md`, поправки к протоколу в §17. Итог:
   - **Подтверждено:** ручной frame codec (§2.2/§14.9, 13/13 оффлайн, декод по длине msgpack-заголовка, не сканом `0x05`); **cookie-only WS-handshake работает, `user=` несёт числовой uid** (подтверждает §2.1/§4/§15); `push` даёт `FULLY_COMMITTED(1)` с `XivaSubscriptionId` из операционного кадра `subscribed` (устояло на залогиненной сессии); server-ping `{operation:"ping", server-interval-sec:60}` (§14.7).
   - **Опровергнуто:** «page-based пагинация в search» (§3.3) - её нет, `page`/`pages` вестигиальны, дефолтный `limit`=5, а не 10; `get_current_user_data` (§10) не существует; «read-методы всегда без CSRF» - `request_user` требует CSRF (§17.4).
   - **Отменено как ГОСТЕВОЙ артефакт (ревизия 3, 2026-07-17):** «WS-URL подписан `sign`+`ts`», «cookie-only недостаточен», «`user=` это GUID», «`sign` приходит из `request_user`», «secretSign обязателен». Всё это - поведение незалогиненной сессии; перезахват на реальном аккаунте опроверг. `request_user` остаётся в v1, но как источник **числового uid**, не подписи.
   - **Остаточных auth-проверок нет.** Вопрос «приходит ли `ts` из `request_user`» снят как беспредметный: на cookie-пути ни `sign`, ни `ts` не существуют.
5. **Bounded surface, устойчивость к ротации.** Пять инструментов, чтение вложений по требованию, LIVE-события отложены. Все протокольные константы и frame codec изолированы в отдельные модули и покрыты fixture-тестами, чтобы смена версии `chats-web` не растекалась по коду.

### Decision Drivers (top 3)

1. **WS - единая точка отказа для чтения и отправки.** И `history`, и `push` идут только по WS (§1). Значит корректность frame codec (§2.2/§14.9) и корреляции ответов (reqId + RequestId, §14.8) - критичнее всего остального. Ошибка тут ломает весь продукт.
2. **Cookie-handshake WS - параметры добиты эмпирически (SPIKE 3 + 1b, перезахват 2026-07-17).** Развилки закрыты живым захватом залогиненной сессии (Playwright init-script, §Приложение строки 1198-1204): **cookie-only handshake работает**, URL не подписан (ни `sign`, ни `ts`); `user=` несёт **числовой uid** (наблюдался `<numeric-uid>` - тот же, что в примере §2.1). Cookie - корень доверия и практически единственный ингредиент handshake; вторая половина - числовой uid, который добывается HTTP-методом `request_user` (с CSRF) до открытия сокета, потому что `whoami` доступен только ЗА WS. Драйвер: риск не в подписи URL (её нет), а в **протухании самой cookie-сессии** то headless-рефреш профиля.
3. **Отправка необратима.** Сообщение уходит живому собеседнику. Двухшаговое подтверждение и идемпотентность обязательны, ошибка здесь дороже любой другой.

### Viable Options

#### Fork (a): структура транспортного слоя и абстракция auth

- **A1 (выбран): Cookie-only транспорт + тонкий шов auth-инъекции.** Порт `AuthProvider` (интерфейс) с ОДНОЙ функцией инъекции `getAuthContext()` то `{cookieHeader, userUid, userGuid, yandexUid, secretSign?}` (+ `getWhoami()` то `{uid, guid}`, `onAuthFailure()`). Адаптер `CookieAuthProvider` (Playwright-backed) сейчас; он же владеет вызовом `request_user` за **числовым uid** (§17.4). **Сборку WS-URL делает сам `MessengerWsClient`** из `AuthContext` (единый xiva/cookie транспорт); `buildWsUrl`/`getWsSyncState` из порта УБРАНЫ. `fake`-провайдер даёт `AuthContext` в тестах без сети и браузера.
  - Pros: минимальная абстракция ровно под v1 (cookie); WS-клиент владеет сборкой xiva-URL, а не порт; тестируется fake-инъекцией; нет мёртвого OAuth-скаффолдинга.
  - Cons: OAuth в будущем не «подключается адаптером» - он потребует нового `UniproxyWsClient` (иной транспорт, иной frame envelope §13.8 п.4). Это осознанный размен: v1 не платит за неопределённость OAuth.
- **A2 (инвалидирован): Ports-and-adapters с обещанием «OAuth без правок транспорта».** Порт с `buildWsUrl`/`getWsSyncState`, транспорт mode-agnostic, OAuth якобы вторым адаптером.
  - Invalidation rationale: обещание ложно. OAuth-WS в бандле - ДРУГОЙ сокет (uniproxy `uni.ws` §15 строка 1139), auth в первом synchronize-state кадре (§13.5 строка 968), frame envelope НЕ снят (§13.8 п.4 строка 997). Общий порт не спасёт от переписывания WS-клиента. `getWsSyncState`/`websocketUrl`/`uniproxyApiKey` в v1 - скаффолдинг под фичу, которую всё равно нельзя добить без нового транспорта. YAGNI. Отклонён.
- **A3 (инвалидирован): Mode-branching transport.** Транспорты принимают `authMode` и ветвятся внутри.
  - Invalidation rationale: в v1 один режим (cookie) - ветвление не нужно; для OAuth ветвление внутри одного WS-клиента невозможно (другой сокет). Отклонён.

#### Fork (b): msgpack-кодек WS-кадров

Кадр (§2.2/§14.9): `0x01` + MessagePack `[serviceIndex, reqId, method]` + `0x05` + 11×`0x00` + UTF-8 JSON. msgpack нужен ТОЛЬКО для заголовка-массива; тело - обычный JSON. Заголовок бывает трёх арностей: DATA `0x93` `[serviceIndex, reqId, method]`, PROXY_STATUS `0x92` `[reqId, errorCode]`, PUSH `0x94` `[uid, service, event, transitId]` (§14.9 строка 1121, §2.2 строки 96-99).

- **B1: готовая либа (msgpackr) на энкод и декод.**
  - Pros: varint-safe из коробки (seq>127 то uint8/uint16, длинные имена метода то str8/str16); ноль ручной битовой арифметики.
  - Cons: на декоде нужен точный байтовый offset конца заголовка, чтобы найти разделитель `0x05`; получить «сколько байт съедено» из частичного буфера у msgpackr неудобно; тянет зависимость ради короткого массива.
- **B2 (выбран): ручной `frameCodec` на энкод и декод, с исчерпывающим round-trip тестом.**
  - Pros: точный контроль offset на декоде. Разделитель `0x05` НЕЛЬЗЯ искать сканированием, потому что `seq=5` кодируется как fixint `0x05` и даст ложное совпадение; корректно только распарсить msgpack-заголовок и узнать его конец. Формы заголовка фиксированы (три арности), энкод/декод тривиальны. Ноль зависимостей на горячем пути.
  - Cons: ручная varint-логика для seq (граница 127/255/65535) и для длины имени метода (fixstr то str8) - маленькая, но реальная поверхность корректности.
  - Mitigation: `msgpackr` подключается как test-only cross-check (энкодим тем же массивом обеими реализациями, сверяем байты); матрица round-trip тестов покрывает границы seq, str8-имена и **все три арности заголовка** (`0x92`/`0x93`/`0x94`).
  - **Статус: подтверждено SPIKE 4 (2026-07-16, 13/13 PASSED, оффлайн).** Энкод даёт побайтово точные заголовки §2.2 на реальных захваченных DATA-кадрах; декод по разбору длины msgpack-заголовка (НЕ сканом `0x05`) корректно берёт push с `seq=5` - подтверждает ключевой довод B2 о ложном совпадении `0x05`/fixint-5; синтетические `0x92`/`0x94` декодируются; str8-путь работает. Артефакт `.omc/spikes/yandex-mcp/spike4-framecodec.mjs` **переносится в репо как есть** (основа `src/transport/ws/frameCodec.ts` + матрица unit-тестов). Fork B2 закрыт (§17.3).

#### Fork (c): как получить cookie из Playwright-профиля в Node-клиент

- **C1 (выбран): extract cookies.** `launchPersistentContext(profileDir)` то `context.cookies()` то отфильтровать домен `.yandex.ru` то собрать `Cookie`-заголовок для undici и `headers.Cookie` для `ws`. Браузер закрывается, протокол гоняется чисто в Node. Браузер поднимается только на логин (headed) и рефреш (headless) при 401.
  - Pros: прямо реализует constraint спека; лёгкий рантайм (Chromium не держится постоянно); WS-бинарь гоняется нативным `ws`.
  - Cons: cookie истекают/привязаны к устройству (см. Risks); нужен цикл рефреша.
- **C2 (инвалидирован): браузер как request-прокси.** Держать `launchPersistentContext` живым и ходить через `context.request` (Playwright APIRequestContext).
  - Invalidation rationale: Playwright request API не прогоняет наш произвольный бинарный WS-протокол (opcode 2, кастомные кадры) - а WS обязателен для history+push (§1). Единственный способ пустить WS через браузер - выполнять его in-page через `page.evaluate`, что означает переписать веб-клиент внутри Chromium и противоречит constraint «Node-клиент гоняет протокол». Плюс постоянный Chromium на инстанс тяжёл. Отклонён.
  - Sub-decision внутри C1 (рефреш cookie): при `401`/`invalid_cookies` перезапускаем persistent context headless, даём Паспорту рефрешнуть сессию, ре-экстрактим cookie; если рефреш не помог (нужен ре-логин) - эскалация в headed. Детали в Risks и Phase 2.

### Pre-mortem: сценарии провала

1. **Frame codec / seq-корреляция уехали в проде.** Ответы матчатся не к тем запросам: `get_history` возвращает сообщения чужого чата либо висит в ожидании. Корень: не учтён сброс seq в 1 на reconnect (§14.8) либо переполнение fixint при seq>127; либо перепутаны арности заголовка (DATA `0x93` vs PROXY_STATUS `0x92` vs PUSH `0x94`). Профилактика: исчерпывающие round-trip тесты (границы seq, str8-имена, все три арности); integration-тест против mock-WS с принудительным reconnect; корреляция по ОБОИМ - reqId в заголовке и RequestId в JSON; декодер читает тип кадра из байта 0 (`0x01` DATA / `0x02` PROXY_STATUS / `0x03` PUSH).
2. **Handshake не собирается: нет числового uid / cookie-сессия протухла.** Мёртв весь history+send (WS обязателен для обоих). Развилки `user=` и secretSign СНЯТЫ перезахватом (§17.1/§17.4): `user=<числовой uid>`, URL не подписан, secretSign не нужен. Остаточные корни: (а) `request_user` не отдал uid - забыт `X-CSRF-TOKEN` (то 403 `bad_csrf_token`) либо cookie протухла; (б) **cookie-сессия протухла** то close-reason `COOKIE_AUTH_FAILED`/`NO_CREDENTIALS` (§14.5); (в) **тихое сползание в гостевую ветку**: без валидной cookie клиент не падает, а строит гостевой URL (`uid?.toString() || n.guid` то GUID + sign/ts) - и мы снова окажемся в ревизии 2. Профилактика: `request_user` вызывается с CSRF, пустой/нечисловой `uid` = жёсткая ошибка авторизации, а НЕ повод подставить guid; close-reason `COOKIE_AUTH_FAILED`/`NO_CREDENTIALS` то 401-путь headless-рефреша профиля то ретрай; **гостевой фоллбэк в v1 не реализуется** - если числового uid нет, это баг авторизации, и он сюрфейсится наверх.
3. **send_message: двойная отправка или отправка не в тот чат.** Необратимое сообщение уходит не туда. Корень: состояние draft то confirm не привязано к резолвнутому ChatId; либо логика ретрая на `DUPLICATE(8)` пере-шлёт. Профилактика: confirm-токен несёт точный резолвнутый `ChatId` и хэш нормализованного текста; перед push повторно сверяем идентичность чата; `DUPLICATE(8)` - идемпотентный успех, push НИКОГДА не ретраится вслепую; авто-confirm запрещён.
4. **push отправка проваливается: гонка за операционным кадром `subscribed`.** Текст уходит в никуда или push возвращает не `FULLY_COMMITTED`. Противоречие §14.1 vs §2.6 СНЯТО (§17.2): `createClientTransportId()` оборачивает Xiva subscription-id из операционного кадра, app-level chat-`subscribe` не нужен. Остаточный корень: кадр `subscribed` приходит **асинхронно после connect**, поэтому push, отправленный до его получения, не будет иметь валидного `XivaSubscriptionId`; на реконнекте приходит НОВЫЙ subscription-id, и закэшированный старый протухает. Профилактика: WS-клиент не считает соединение готовым к push, пока не получен `subscribed`; `XivaSubscriptionId` хранится как per-connection состояние и **обнуляется на reconnect** (как и seq, §14.8); push ждёт свежий id, а не шлёт со старым; тест «connect то subscribed то push то `FULLY_COMMITTED`» + тест «reconnect то новый id» в integration/e2e.

### Expanded Test Plan

- **Unit.**
  - `frameCodec`: round-trip энкод/декод, границы seq (1, 127, 128, 255, 256, 65535, 65536), str8-имена метода; декод входящих по **всем трём арностям заголовка**: `DATA` (`0x93` `[serviceIndex, reqId, method]`), `PROXY_STATUS` (`0x92` `[reqId, errorCode]`), `PUSH` (`0x94` `[uid, service, event, transitId]`) (§14.9 строка 1121, §2.2 строки 96-99); cross-check против msgpackr. Синтетические фикстуры PROXY_STATUS/PUSH помечены `synthetic`.
  - `messageShape`: маппинг ServerMessage то MCP-сообщение (текст, рефы вложений из `FileInfo.Id2`, reply/forward-цитата через `ForwardedMessageRefs`+`ForwardedMessageStyles.Quote`, edited через `LastEditTimestamp>0`, deleted через `Deleted=true`).
  - `search` limit-эскалация (§17.5): `total == limit` то следующий запрос с поднятым `limit`; `total < limit` (плато) то терминация, лишних запросов нет; стартовый `limit` явно задаётся клиентом (не полагаться на серверный дефолт 5); `page`/`pages` из ответа игнорируются; при упоре в потолок `limit` (если он найдётся) - результат помечается как усечённый, а не молча обрезается; entity `contacts` отвергается на входе (§17.6).
  - `resolveChat`: одно совпадение то ChatId; несколько то кандидаты; ноль то понятная ошибка; **конструирование приватного ChatId** `<собеседникGuid>_<мойGuid>` (порядок собеседник+я, §5 строка 428) из guid юзера (search users) + мой guid (whoami).
  - `cleanup`: старый файл удалён, свежий сохранён; sweep на старте и перед скачиванием.
  - `errors`: маппинг трёх слоёв (PROXY_STATUS errorCode, application `Status`, push commit-status §14.6) в осмысленные MCP-ошибки.
  - `timestamps`: мкс то ISO и обратно (16 цифр); **арифметика курсора `n+1`/`i-1` (§14.2 строки 1019/1027-1030) через BigInt/string, не float** - тест на 16-значных значениях без потери точности.
- **Integration.**
  - `RegistryHttpClient` против записанных fixtures: multipart FormData `request=JSON({method,params})`, `enableCSRF:false` для read-методов v1, **исключение `request_user` - с `X-CSRF-TOKEN`** (§17.4), разбор `{status, data}`; `csrf-token` парсится как голый `{token}` (§17.6).
  - `MessengerWsClient` против локального mock-WS, проигрывающего захваченные бинарные кадры (§2.2): connect то whoami то history `Limit:0` то страница history то push то commit-status; reconnect сбрасывает seq в 1 и заново корректно коррелирует; server-initiated ping (§14.7) не рвёт соединение.
  - `errors` против **синтетических PROXY_STATUS/PUSH-фикстур** (§14.6): PROXY_STATUS errorCode (`TOO_MANY_REQUESTS=7` и т.д.), application `Status`, push commit-status то теги слоёв.
  - **push↔subscribe** (форма зафиксирована SPIKE, §17.2): тест «connect то операционный кадр `subscribed` то `XivaSubscriptionId` то push с ним то `FULLY_COMMITTED(1)`»; тест «push до прихода `subscribed` не отправляется, а ждёт»; тест «reconnect то новый subscription-id, старый не переиспользуется».
  - **list_chats unread source**: фикстура ответа `history Limit:0` - проверить, несёт ли она флаг непрочитанных; если нет - тест отдельного counters-вызова (§14.2 requestCounters то normalizeCounters, строка 1030).
  - `CookieAuthProvider` с fake persistent context: экстракт cookie, `request_user` **с CSRF** то `{status:"ok", data:{user:{guid, uid}}}` (фикстура ответа), `getAuthContext()` то `{cookieHeader, userUid, userGuid, yandexUid}` (`secretSign` не заполняется), ре-экстракт после 401; тест «`request_user` без CSRF то 403 `bad_csrf_token`»; тест «нечисловой/пустой uid то ошибка авторизации, а не фоллбэк на guid».
- **E2E (гейтится env-флагом + реальный аккаунт).**
  - first-run headed-логин бутстрапит сессию; повторные вызовы работают на сохранённом профиле без ручного входа.
  - `list_chats` возвращает реальные чаты, свежие сверху, с флагом непрочитанных (из подтверждённого источника).
  - `get_history` пагинирует реальный чат по `MaxTimestamp`/`Offset`.
  - `search` по терму с известным числом совпадений N при стартовом `limit < N` эскалирует `limit` и возвращает все N (плато `total < limit`); терм берётся нормальный, не односимвольный/стоп-слово (§17.5).
  - `send_message` draft возвращает превью; confirm доставляет `FULLY_COMMITTED` в тестовый чат (saved messages / собственный чат) - по подтверждённому механизму push↔subscribe.
  - `download_attachment` качает реальную картинку и произвольный файл в папку; TTL-sweep удаляет состаренный файл.
  - 401 то headless-рефреш профиля то продолжение.
- **Observability.**
  - Структурированный лог в stderr (stdout зарезервирован под MCP stdio) с корреляцией reqId+RequestId.
  - Лайфцикл WS: connect / server-ping / reconnect / close-reason (`cookie auth failed`, `no credentials` §14.5).
  - Auth-события: login / refresh / 401.
  - Rate-limit: `rate_limit.wait_for` (§14.4), backoff.
  - Трёхслойные ошибки с тегом слоя.
  - Debug-режим захвата сырых кадров (base64) для диагностики дрейфа протокола.
  - Редакция текста сообщений, cookie, uid/guid и csrf-токена в логах.

---

## Package Structure

```
yandex-messenger-mcp/                 # standalone repo, вне devflow
├── package.json                      # type:module; bin: yandex-messenger-mcp; deps: @modelcontextprotocol/sdk, playwright, ws, undici
├── tsconfig.json                     # strict, NodeNext, target ES2022
├── vitest.config.ts
├── .gitignore                        # node_modules, dist, *.local
├── README.md                         # setup, first-run auth, config, tools
├── config.example.json               # пример ~/.config/yandex-messenger-mcp/config.json
├── src/
│   ├── index.ts                      # entrypoint: старт MCP stdio-сервера
│   ├── server.ts                     # регистрация 5 инструментов, DI (auth/transport/protocol)
│   ├── config/
│   │   ├── defaults.ts               # константы §15 (apiUrl, xivaUrl, serviceId=27, apiVersion=5, client=1000, file hosts). БЕЗ websocketUrl/uniproxyApiKey в v1 (OAuth-скаффолдинг, YAGNI)
│   │   ├── loadConfig.ts             # чтение config.json, мерж с defaults, резолв путей (~/.config/...)
│   │   └── types.ts                  # тип Config (paths, ttlDays, limits)
│   ├── auth/
│   │   ├── AuthProvider.ts           # ПОРТ: getAuthContext() -> {cookieHeader, userUid, userGuid, yandexUid, secretSign?}; getWhoami() -> {uid, guid}; onAuthFailure(). БЕЗ buildWsUrl/getWsSyncState
│   │   ├── CookieAuthProvider.ts     # адаптер cookie-режима (extract cookie, yandexuid, числовой uid через request_user, refresh)
│   │   ├── PlaywrightProfile.ts      # persistent context: login (headed), refresh (headless), extract cookies
│   │   ├── requestUser.ts            # POST request_user (params {bind_phone_number:false}, ТРЕБУЕТ X-CSRF-TOKEN, §17.4) -> {user:{uid, guid}}; источник ЧИСЛОВОГО uid для user= WS-URL (whoami живёт за WS). sign НЕ отдаёт
│   │   └── csrf.ts                   # НУЖЕН в v1 (§17.4): GET csrf-token -> {token} голым (§17.6); единственный потребитель - request_user. Прочие read v1 идут без CSRF (§3.3/§13.4)
│   │   # secretSign.ts НЕ СОЗДАЁТСЯ (§17.1): secretSign - гостевой фоллбэк, на cookie-пути WS-URL не подписан
│   ├── transport/
│   │   ├── RegistryHttpClient.ts     # undici POST apiUrl, multipart request=JSON({method,params}), {status,data}; read-методы enableCSRF:false, исключение request_user -> с X-CSRF-TOKEN (§17.4)
│   │   └── ws/
│   │       ├── MessengerWsClient.ts  # ws connect: САМ строит xiva WS-URL (?service&session=<4x4hex>&client=web_main&user=<числовой uid>, §17.1 - без sign/ts) из AuthContext; ловит операционный `subscribed` -> per-connection XivaSubscriptionId (§17.2); корреляция, reconnect/ping (§14.7/§14.8)
│   │       ├── frameCodec.ts         # encode/decode кадров, арности 0x92/0x93/0x94 (SPIKE 4 PASSED: порт spike4-framecodec.mjs)
│   │       ├── requestId.ts          # генератор RequestId (не канонический hex, §14.8)
│   │       └── frameTypes.ts         # enums DATA/PROXY_STATUS/PUSH + error-code enums (§14.6)
│   ├── protocol/
│   │   ├── whoami.ts                 # whoami -> uid/guid (§2.5/§14.3); ЗА WS, поэтому в user= WS-URL идёт uid из request_user (§17.1/§17.4); guid нужен для приватного ChatId (§5); puid не нужен
│   │   ├── history.ts                # билд params history, нормализация ответа (§2.4/§14.2); BigInt-курсоры
│   │   │                             # subscribe.ts НЕ НУЖЕН в v1 (§17.2): app-level chat-subscribe только для LIVE (v2);
│   │   │                             # операционный кадр `subscribed` разбирает MessengerWsClient (транспортный уровень)
│   │   ├── push.ts                   # билд push Plain.Text (+ LogData.YandexUid §14.4 строка 1059), ClientTransportId.XivaSubscriptionId = subscription-id из `subscribed` (§17.2), разбор commit-status
│   │   ├── search.ts                 # HTTP search с limit-эскалацией: total==limit -> поднять limit и перезапросить; total<limit -> всё найдено (§17.5, page-based пагинации НЕТ); валидные entities: messages/users/chats (не contacts, §17.6)
│   │   ├── counters.ts              # УСЛОВНЫЙ (по SPIKE unread-source): requestCounters -> normalizeCounters (§14.2 строка 1030), если Limit:0 не несёт unread
│   │   ├── chatShape.ts              # history(Limit:0) -> метаданные Chat (lastMessage, unread)
│   │   ├── messageShape.ts           # ServerMessage -> MCP Message (id, время ISO+мкс, from, text, рефы, reply/forward, edited/deleted)
│   │   ├── attachmentRefs.ts         # извлечение FileInfo (Id2/Name/Size/Source) из payload (§11.1/§12.4)
│   │   └── errors.ts                 # 3 слоя ошибок -> MCP-ошибка (§14.6)
│   ├── attachments/
│   │   ├── downloadUrl.ts            # билд file_shortterm/{fileId} URL (§12.2)
│   │   ├── downloader.ts             # fetch файла той же auth-сессией -> downloads dir -> локальный путь
│   │   └── cleanup.ts               # TTL-sweep (дефолт 7 дней): на старте + перед скачиванием
│   ├── chat/
│   │   └── resolveChat.ts           # ChatId | query -> резолв: search chats (прямой ChatId) ИЛИ search users -> конструирование <собеседникGuid>_<мойGuid> (§5); multi -> кандидаты
│   ├── mcp/
│   │   └── tools/
│   │       ├── listChats.ts
│   │       ├── getHistory.ts
│   │       ├── search.ts
│   │       ├── sendMessage.ts        # draft -> confirm
│   │       └── downloadAttachment.ts
│   └── util/
│       ├── logger.ts                 # структурный лог в stderr (stdout под MCP)
│       └── timestamps.ts             # мкс <-> ISO; BigInt-арифметика курсоров (n+1/i-1)
├── tests/
│   ├── unit/                         # frameCodec (3 арности), messageShape, search.limitEscalation, errors, cleanup, resolveChat, timestamps(BigInt)
│   ├── integration/                  # registryHttp (fixtures), wsClient (mock-WS), errors (synthetic PROXY_STATUS/PUSH), pushSubscribe, unreadSource
│   ├── e2e/                          # liveSmoke (env-gated, реальный аккаунт)
│   └── fixtures/
│       ├── frames/                   # захваченные DATA-кадры base64 (§2.2) + synthetic PROXY_STATUS/PUSH
│       └── responses/                # захваченные JSON-ответы
└── spikes/                           # ВЫПОЛНЕНЫ 2026-07-16; исходные артефакты остаются в devflow `.omc/spikes/yandex-mcp/`
    ├── 04-frame-codec-roundtrip.mjs  # PASSED 13/13 <- порт spike4-framecodec.mjs (переносится как есть, основа frameCodec.ts)
    ├── 03-ws-url-cookie.mjs          # PASSED <- capture-handshake.mjs (Playwright init-script capture)
    ├── 05-push-subscribe.mjs         # PASSED <- зафиксирован в capture-handshake.mjs (операционный `subscribed` + heartbeat push Status:1)
    ├── 01-secret-sign.mjs            # PASSED <- spike-1b-2-http.mjs (+ spike-1b-2-findings.json): sign из request_user
    └── 02-search-page-param.mjs      # PASSED (отрицательный) <- spike2-limit-sweep.mjs (+ spike-2-diag.mjs, spike2-final.mjs, spike2-users-pagination.mjs)
```

---

## Spikes - ВЫПОЛНЕНЫ (2026-07-16, все 5 закрыты живыми экспериментами)

**Статус: Phase 0 завершена.** Все спайки прошли; блокеров основной реализации не осталось. Артефакты: `.omc/spikes/yandex-mcp/`, сводка `.omc/spikes/yandex-mcp/SPIKE-RESULTS.md`, поправки к протоколу - §17 в `yandex-messenger-api-research.md`. Захват снят с `chats-web/3.22.0` (research собирался с 3.21.0; протокол стабилен).

Фактический порядок: SPIKE 4 (оффлайн) то SPIKE 3 (live capture) то push↔subscribe (из того же захвата) то SPIKE 1/1b (live HTTP) то SPIKE 2 (live sweep). SPIKE 1 оказался НЕ условным, а обязательным: cookie-only handshake не прошёл по структуре URL.

### SPIKE 4 - WS frame codec round-trip (оффлайн) - ✅ PASSED (13/13)
- Цель: подтвердить энкод/декод кадра `0x01` + msgpack-заголовок + `0x05` + 11×`0x00` + JSON (§2.2/§14.9) для всех трёх арностей заголовка.
- **Результат:** ручной кодек (Fork B2) подтверждён полностью. Энкод даёт **побайтово точные** заголовки §2.2 (whoami/history/push/subscribe). Декод по **разбору длины msgpack-заголовка** (а НЕ сканированием `0x05`) корректно берёт push с `seq=5` - эмпирически подтверждает ключевой довод B2: fixint-5 неотличим от разделителя `0x05` при сканировании. Синтетические `0x92` (PROXY_STATUS) / `0x94` (PUSH) декодируются; str8-путь для длинных имён метода работает.
- **Артефакт:** `.omc/spikes/yandex-mcp/spike4-framecodec.mjs` - **переносится в репо как есть** и становится основой `src/transport/ws/frameCodec.ts` + матрицы unit-тестов (границы seq 127/128/255/256/65535/65536, 3 арности, msgpackr cross-check). Синтетические фикстуры сохраняют пометку `synthetic fixture, не captured`.
- Ссылка: §17.3, SPIKE-RESULTS «SPIKE 4».

### SPIKE 3 - WS handshake + `user=` резолв (live capture) - ✅ PASSED (перезахват 2026-07-17; ПОДТВЕРЖДАЕТ research)
- Цель: подтвердить, как поднимается xiva-WS `wss://push.yandex.ru/v2/subscribe/websocket` (§2.1); разрешить `user=`=uid vs puid и «нужен ли secretSign в URL».
- Метод: headed Playwright + init-script WS-патч (§Приложение строки 1198-1204). Артефакт: `.omc/spikes/yandex-mcp/capture-handshake.mjs`.
- **Результат - реальный handshake-URL ЗАЛОГИНЕННОЙ сессии (структура, секреты вычищены):**
  ```
  wss://push.yandex.ru/v2/subscribe/websocket
    ?service=messenger-prod:version5*common+version5*main
    &session=<4x4hex random>
    &client=web_main
    &user=<числовой uid>   ← ЧИСЛОВОЙ uid (наблюдался <numeric-uid> - тот же, что в примере §2.1)
  ```
  **Ни `sign`, ни `ts` НЕТ. Cookie-only handshake РАБОТАЕТ.**
- **ПОДТВЕРЖДЕНО:** §2.1/§4/§15 «в URL токена нет, только service/session/client/user» - **верно**; «`user` = числовой uid» - **верно**. Вопрос uid/puid закрыт: в `user=` идёт числовой uid, puid искать не нужно.
- **Гостевая ветка (что дал захват 2026-07-16 и что было ошибочно принято за норму):** `...&client=web_main&sign=<32-hex>&ts=<unix-sec>&user=<GUID>`. У гостя нет числового uid, поэтому бандловый фоллбэк `this.uid = uid?.toString() || n.guid` подставляет GUID и включает подпись. `secretSignNeeded` взводится только на close-reason `COOKIE_AUTH_FAILED`/`NO_CREDENTIALS` либо под OAuth. **secretSign = фоллбэк гостя / заблокированной cookie-авторизации, не нормальный путь.**
- Также подтверждено: server-ping `{operation:"ping", server-interval-sec:60}` (§14.7); наблюдался server PUSH(3)-кадр.
- Ссылка: §17.1, SPIKE-RESULTS «SPIKE 3».

### SPIKE push↔subscribe - зависимость отправки - ✅ PASSED (критический)
- Цель: определить, требует ли `push` subscribe-derived `XivaSubscriptionId` (§2.6 строка 243) или `createClientTransportId()` минтит собственный (§14.1 строка 1011).
- **Результат - противоречие разрешено (устояло на залогиненной сессии):** app-level chat-`subscribe` для отправки **НЕ нужен**. Наблюдённый порядок sent-кадров у гостя: `whoami, history, push(heartbeat), history` - метода `subscribe` среди них нет. На реальном аккаунте клиент шлёт **много** app-level `subscribe` (по одному на чат - это LIVE-подписка, v2), но порядок доказывает независимость: первый `push` ушёл **раньше** первого app-level `subscribe` (позиции 3 и 6 в потоке sent) и получил `Status:1`. Также в recv наблюдался метод `delivery` (в каталоге §2.3 отсутствует). Xiva **сама** присылает операционный текст-кадр `{operation:"subscribed", subscription-id:"<40hex>", uid, service, event}` автоматически после connect. Наблюдаемый `push.ClientTransportId.XivaSubscriptionId` **точно равен** этому `subscription-id`. Heartbeat-push вернул `Status:1` (FULLY_COMMITTED). Вывод: `createClientTransportId()` (§14.1) **оборачивает** subscription-id из операционного кадра; §2.6 описывает app-level подписку на чат для LIVE-событий, а не путь отправки.
- **Флоу send_message (зафиксирован):** connect WS то дождаться операционного кадра `subscribed` то взять `subscription-id` то положить в `push.ClientTransportId.XivaSubscriptionId` то отправить `push` с `Plain.Text`.
- **Scope-impact (правка Non-goals):** в v1 входит **чтение операционного `subscribed`** - транспортная, автоматическая механика WS-клиента. Отложенным остаётся только app-level chat-`subscribe` для LIVE-событий. Модуль `protocol/subscribe.ts` в v1 НЕ нужен.
- Ссылка: §17.2, SPIKE-RESULTS «push↔subscribe».

### SPIKE 1 / 1b - secretSign - ✅ PASSED, ОТРИЦАТЕЛЬНЫЙ РЕЗУЛЬТАТ (на cookie-пути не нужен)
- **Прежний вывод («sign обязателен и приходит из `request_user`») ОТМЕНЁН как гостевой артефакт** (ревизия 3): он опирался на гостевой захват SPIKE 3, где sign действительно выдаётся фоллбэком. Вердикт харнесса `SIGN_FROM_HTTP_RESPONSE` (hit на `rpcMethod:"request_user"`) валиден только внутри гостевой ветки.
- **Истина (залогиненная сессия, перезахват 2026-07-17):** `secretSign` в WS-URL не участвует - handshake не подписан. **`request_user` sign НЕ отдаёт**: живой ответ `{status:"ok", data:{user:{guid, uid, ...}}}`, никаких `secret_sign`/`sign`/`ts`.
- **Что `request_user` даёт и почему остаётся в v1:** он единственный HTTP-источник **числового uid** до открытия сокета (`whoami` живёт ЗА WS - курица-яйцо). Params: `{bind_phone_number:false}` (§10 числил opaque). **Требует CSRF**: без `X-CSRF-TOKEN` то 403 `bad_csrf_token` - единственное известное исключение из «read-методы идут без CSRF». Клиент троттлит вызов через localStorage-ключ `requestUserLastTime`.
- Маппинг веток из бандла: `("user" in e) ? {user:a(e.user), secretSign:e.secret_sign} : {user:c(e), secretSign:{sign:e.sign, ts:e.ts}}` - вторая ветка (sign/ts) и есть гостевой путь.
- **Флоу для headless Node:** cookie то GET `csrf-token` то POST registry `request_user` (с `X-CSRF-TOKEN`) то взять числовой `uid` (+ `guid`) то собрать WS-URL `?service&session&client=web_main&user=<uid>`.
- **Артефакты:** `.omc/spikes/yandex-mcp/spike-1b-2-http.mjs`, `spike-1b-2-findings.json` (гостевые, вердикт вне гостевой ветки невалиден).
- Ссылка: §17.4, SPIKE-RESULTS «SPIKE 1 / 1b».

### SPIKE 2 - пагинация search - ✅ PASSED, ОТРИЦАТЕЛЬНЫЙ РЕЗУЛЬТАТ (главная правка плана)
- Цель: добить имя параметра следующей страницы у `search` (§3.3).
- **Результат: page-based пагинации в `search` НЕТ. §3.3 был прочитан неверно.** Свип `limit` на bucket `users`, query `"а"`, живой залогиненный аккаунт:

  | reqLimit | total | count | pages |
  |---|---|---|---|
  | 1 | 1 | 1 | 1 |
  | 5 | 5 | 5 | 1 |
  | 10 / 20 / 50 / 100 | **7** (плато) | 7 | **1** |
  | без параметра | 5 | 5 | 1 |

- Выводы:
  1. **`total` = число ВОЗВРАЩЁННЫХ элементов** (`min(limit, реальное)`), а НЕ общее число совпадений. Плато на 7 = реальное количество. `count == total` всегда.
  2. **`pages` всегда 1, `page` всегда 1** - поля **вестигиальны**, пагинацию не описывают.
  3. **Дефолтный `limit` = 5** (§3.3 утверждает 10) - клиент задаёт `limit` явно, на дефолт не полагается.
  4. Все кандидаты параметра страницы **игнорируются сервером**: `page`/`offset`/`from`/`skip`/`page_number`=2 то `respPage:1`, `itemChanged:false`, `works:false` для всех пяти.
- **Стратегия вместо пагинации - эскалация `limit`:** если `total == limit` то возможно есть ещё, поднять `limit` и перезапросить; плато `total < limit` то найдено всё. Серверный потолок `limit` **не установлен** (на 7 совпадениях не проверить); если найдётся - деградировать **явно** (вернуть найденное + пометка об усечении), не молча.
- **Влияние на спек:** требование «поиск полноценный» остаётся выполнимым, но реализуется через limit-эскалацию, а НЕ через обход страниц. AC «проходит все страницы» переписан.
- **Артефакты:** `.omc/spikes/yandex-mcp/spike2-limit-sweep.mjs` (решающий), `spike-2-diag.mjs`, `spike2-final.mjs`, `spike2-users-pagination.mjs`, `spike-2-findings.json`.
- Ссылка: §17.5, SPIKE-RESULTS «SPIKE 2».

### Поправки каталога методов, найденные попутно (правят §10/§3.1/§3.3)
- **`get_current_user_data` НЕ СУЩЕСТВУЕТ:** `{code:"No such path", source:"yamb"}` даже с валидным CSRF - §10 его перечисляет ошибочно. Идентичность берётся из WS `whoami` (§2.5). Если план/код где-то на него опирался - только whoami.
- **`get_organizations` требует `organization_ids`:** без него `{code:"bad_request", text:"organization_ids is required"}` (§10 числит params как opaque).
- **`csrf-token` возвращает `{token}` голым**, без обёртки `{status,data}` (уточняет §3.1). CSRF-флоу рабочий и **в v1 используется** - ровно под `request_user`, который единственный из read-методов требует `X-CSRF-TOKEN` (§17.4).
- **entity `contacts` невалиден** для `search` (`status:"error"`); валидны `messages`/`users`/`chats` - `search` отвергает `contacts` на входе.
- Поиск требует нормальных термов: односимвольные и стоп-слова дают 0-1 (учитывать при подборе e2e-термов).
- Ссылка: §17.6, SPIKE-RESULTS «Поправки к research».

### ⚠️ Остаточная проверка ревизии 2 - ВЫПОЛНЕНА, ОПРОВЕРГЛА (2026-07-17)
Оговорка ревизии 2 («SPIKE 3/1b сняты на сессии, которая могла быть гостевой; перепроверить при первом реальном коннекте») **сработала**. Перезахват на залогиненной сессии опроверг оба «протокольных факта»: `sign`/`ts` отсутствуют, `user=` несёт числовой uid, `request_user` sign не отдаёт. Сессия действительно была гостевой; наличие кук (`Session_id`/`sessionid2`/`yandexuid`, 17 штук) и отрисовка UI были прочитаны как доказательство логина ошибочно.

**Урок (вошёл в Принцип 1):** протокольные выводы принимать только с сессии, залогиненность которой доказана ПО ДАННЫМ - минимум `Session_id` **и** непустой список чатов. Гостевая сессия не падает, а тихо уходит в фоллбэк-ветку и выдаёт правдоподобный чужой протокол.

Остаточных auth-проверок не осталось. Вопрос «приходит ли `ts` из `request_user`» снят как беспредметный.

---

## Implementation Steps

### Phase 0 - Spikes - ✅ ВЫПОЛНЕНА (2026-07-16; auth-часть перезахвачена 2026-07-17)
Все 5 спайков PASSED, включая SPIKE 1 (отрицательный: secretSign на cookie-пути не нужен) и SPIKE 2 (отрицательный). Открытые вопросы по handshake / `user=` / push↔subscribe / codec / search-пагинации / secretSign закрыты; поправки зафиксированы в §17 и `.omc/spikes/yandex-mcp/SPIKE-RESULTS.md`.
Acceptance: ВЫПОЛНЕН. Подтверждённые значения/байты идут константами и fixtures в код; `spike4-framecodec.mjs` переносится в репо как основа `frameCodec.ts`.
Остаточных auth-проверок нет: перепроверка на залогиненной сессии выполнена и переписала выводы SPIKE 3/1b (см. «Остаточная проверка ревизии 2»).

### Phase 1 - Scaffold + config
Создать репозиторий, `package.json` (ESM, bin), `tsconfig` (strict/NodeNext), vitest. MCP stdio-сервер-скелет (`index.ts`/`server.ts`) регистрирует пять инструментов заглушками, поднимается и виден MCP-клиенту. `config/defaults.ts` с §15-значениями (БЕЗ `websocketUrl`/`uniproxyApiKey`); `loadConfig.ts` читает `~/.config/yandex-messenger-mcp/config.json`, мержит дефолты, резолвит `profile/`, `downloads/`, `ttlDays=7`.
Acceptance: `list tools` у MCP-клиента показывает пять инструментов; конфиг грузится с дефолтами при отсутствии файла; пути резолвятся в `~/.config/yandex-messenger-mcp/`.

### Phase 2 - Auth (cookie-режим)
`AuthProvider` порт (`getAuthContext`/`getWhoami`/`onAuthFailure`, БЕЗ buildWsUrl/getWsSyncState). `PlaywrightProfile`: headed-логин при первом вызове (QR/пароль), extract `.yandex.ru` cookie (в т.ч. `yandexuid` для push LogData §14.4 строка 1059) из persistent context, headless-рефреш при 401. **`csrf.ts` + `requestUser.ts` - ОБЯЗАТЕЛЬНЫЕ** (§17.4): GET `csrf-token` то `{token}` голым (§17.6) то POST registry `request_user` с `X-CSRF-TOKEN` и params `{bind_phone_number:false}` то `{status:"ok", data:{user:{guid, uid}}}`. Оттуда берётся **числовой uid** - без него не собрать WS-URL, а `whoami` живёт за WS. `CookieAuthProvider.getAuthContext()` собирает `{cookieHeader, userUid, userGuid, yandexUid}`; `secretSign?` в v1 не заполняется (гостевой фоллбэк, §17.1). **`secretSign.ts` НЕ создаётся.** Прочие read-методы v1 идут без CSRF.
Acceptance: first-run поднимает headed-браузер и получает валидную сессию; `request_user` с CSRF на извлечённых cookie возвращает **числовой** `uid` (пустой/нечисловой uid = ошибка авторизации, НЕ фоллбэк на guid); `request_user` без CSRF даёт 403 `bad_csrf_token` (зафиксировано тестом); `whoami` через транспорт возвращает `uid`/`guid` (puid НЕ нужен; в `user=` идёт числовой uid, guid нужен для приватного ChatId §5); 401 триггерит headless-рефреш без ручного входа; fake-провайдер отдаёт `AuthContext` в unit-тестах.

### Phase 3 - Transport
`RegistryHttpClient` (undici POST apiUrl, multipart `request=JSON({method,params})`, `{status,data}`; read-методы v1 - `enableCSRF:false`, исключение `request_user` шлётся с `X-CSRF-TOKEN`, §17.4; `csrf-token` отдаёт `{token}` голым - §17.6). `frameCodec` - **порт `spike4-framecodec.mjs` как есть** (арности 0x92/0x93/0x94, декод по длине заголовка). `MessengerWsClient`: САМ строит xiva WS-URL из `AuthContext` - `?service=messenger-prod:version5*common+version5*main&session=<4x4hex>&client=web_main&user=<числовой uid>` (§17.1, **без sign/ts - URL не подписан**); **ловит операционный текст-кадр `subscribed` и держит `subscription-id` как per-connection состояние** (§17.2), обнуляя его на reconnect вместе с seq (§14.8); корреляция ответов по reqId+RequestId, server-ping/reconnect (§14.7); close-reason `COOKIE_AUTH_FAILED`/`NO_CREDENTIALS` то 401-путь headless-рефреша профиля то ретрай (гостевой secretSign-фоллбэк НЕ реализуется). `whoami` end-to-end.
Acceptance: HTTP-вызов метаданных возвращает распарсенный `data`; **WS открывается на живой залогиненной сессии cookie-only URL без sign/ts** (воспроизводит перезахват 2026-07-17); операционный `subscribed` получен, `subscription-id` извлечён; `whoami` и `history(Limit:0)` проходят по WS; reconnect восстанавливает корреляцию и даёт новый subscription-id (integration-тест против mock-WS).

### Phase 4 - Read tools (list_chats, get_history, search)
`history.ts`/`chatShape.ts`/`messageShape.ts`/`attachmentRefs.ts`/`timestamps.ts` (BigInt-курсоры). `list_chats` (WS `history` `Limit:0`, сортировка по свежести, unread-флаг, `limit`/`unread_only`). **Проверить источник unread:** несёт ли `history Limit:0` флаг непрочитанных; если нет - добавить `counters.ts` (§14.2 requestCounters то normalizeCounters, строка 1030) и подмешать. `get_history` (пагинация `MaxTimestamp`/`Offset` по BigInt; `resolveChat` для query то ChatId: search chats то прямой ChatId, иначе search users то конструирование `<собеседникGuid>_<мойGuid>` §5 строка 428; форма сообщения: id, время ISO+мкс, from имя+guid, текст, рефы вложений, reply/forward-контекст, edited/deleted). `search.ts` - **limit-эскалация** (§17.5, SPIKE 2): стартовый `limit` задаётся явно; если `total == limit` то поднять `limit` и перезапросить; `total < limit` (плато) то всё найдено; поля `page`/`pages` из ответа игнорируются как вестигиальные; entity `contacts` отвергается на входе, валидны `messages`/`users`/`chats` (§17.6).
Acceptance: все три AC чтения из спека выполняются на реальном аккаунте (см. Acceptance Criteria ниже); `list_chats` unread берётся из подтверждённого источника; `search` возвращает полный набор через эскалацию `limit` (проверяемо на терме с известным N при стартовом `limit < N`); вложения отдаются только рефами, не качаются.

### Phase 5 - send_message (draft то confirm)
`push.ts` (WS `push` `Plain.Text`, `LogData.YandexUid` из cookie §14.4 строка 1059, разбор `deserializePushResponse` §14.4). **`ClientTransportId.XivaSubscriptionId` = `subscription-id` из операционного кадра `subscribed`, который `MessengerWsClient` получил на connect** (§17.2) - `protocol/subscribe.ts` НЕ создаётся, app-level chat-subscribe в v1 не нужен. Push не отправляется, пока `subscribed` не получен. Инструмент: шаг 1 draft то превью (текст + разрешённый чат имя/ChatId), не отправляет; confirm-токен несёт резолвнутый ChatId + хэш текста. Шаг 2 `confirm:true` то ре-верификация чата то push то commit-status `FULLY_COMMITTED(1)`. `DUPLICATE(8)` то идемпотентный успех; без авто-ретрая.
Acceptance: draft не шлёт; confirm с другим/несходящимся чатом отклоняется; успешный confirm возвращает `FULLY_COMMITTED(1)` (воспроизводит heartbeat-push из спайка); повторный confirm не создаёт второе сообщение; push со stale/пустым `XivaSubscriptionId` не уходит.

### Phase 6 - Attachments (download_attachment + TTL cleanup)
`downloadUrl.ts` (§12.2: `https://files.messenger.yandex.ru/file_shortterm/{fileId}`; `?size=` превью картинки, `?attach=true` файл). `downloader.ts` (fetch той же auth-сессией то downloads dir то путь; единый формат для картинок и файлов). `cleanup.ts` (TTL-sweep на старте и перед скачиванием, дефолт 7 дней).
Acceptance: скачивание картинки и произвольного файла в папку возвращает валидный локальный путь; sweep удаляет состаренный файл (положить старый то sweep то нет файла); свежий сохранён.

### Phase 7 - Error mapping + rate-limit + hardening
`errors.ts`: три слоя (PROXY_STATUS errorCode, application `Status`, push commit-status §14.6) то осмысленные MCP-ошибки. Уважать `rate_limit.wait_for` (§14.4), backoff на `TOO_MANY_REQUESTS(7)`/`THROTTLED(18)`/`RATE_LIMIT_EXCEEDED(23)`. Логирование/редакция (Observability).
Acceptance: каждая из трёх категорий ошибок маппится в понятное сообщение с тегом слоя; `wait_for` соблюдается; секреты редактируются в логах.

### Phase 8 - Tests + docs + verification
Добить unit/integration/e2e по Expanded Test Plan. README (setup, first-run auth, config, инструменты, TTL). Прогон верификации (см. Verification Steps).
Acceptance: unit+integration зелёные; e2e-smoke на реальном аккаунте PASSED под env-флагом; README покрывает бутстрап и конфиг.

---

## ADR (ключевые решения)

- **Decision:** Auth = cookie-режим (Playwright persist то extract cookie то `csrf-token` то `request_user` за **числовым uid** то Node undici+ws). v1 - ЕДИНЫЙ xiva/cookie транспорт. Слой авторизации абстрагирован ТОНКИМ ШВОМ: порт `AuthProvider.getAuthContext()` то `{cookieHeader, userUid, userGuid, yandexUid, secretSign?}`; сборку **неподписанного cookie-only** WS-URL делает сам `MessengerWsClient`. Frame codec ручной, покрывает арности `0x92`/`0x93`/`0x94`. CSRF реализуется в v1 в минимальном объёме - ровно под `request_user` (§17.4); прочие read-методы идут без CSRF.
- **Drivers:** WS - единая точка отказа (§1); cookie-handshake доказанно рабочий (§16 путь 1) и **эмпирически подтверждён перезахватом 2026-07-17**: `user=<числовой uid>`, URL не подписан, secretSign не нужен (§17.1/§17.4); отправка необратима, её механизм `ClientTransportId` **разрешён** - Xiva subscription-id из операционного кадра `subscribed` (§17.2).
- **Что спайки изменили в решении:** `protocol/subscribe.ts` вычеркнут из v1 (для отправки не нужен), взамен транспортное чтение `subscribed`; `search` перестроен с обхода страниц на **limit-эскалацию** (page-based пагинации в API нет); в v1 добавлен минимальный CSRF ровно под `request_user`. Решения A1/B2/C1 спайками ПОДТВЕРЖДЕНЫ, не пересматриваются.
- **Что откатила ревизия 3 (2026-07-17):** правки ревизии 2 по auth были сняты с **ГОСТЕВОЙ** сессии и отменены. Откачено: «cookie-only handshake недостаточен» (он достаточен), «`sign`+`ts` обязательны в URL» (их там нет), «`user=` это GUID» (это числовой uid), «`sign` server-issued из `request_user`» (`request_user` sign не отдаёт), «`secretSign` - обязательное поле `AuthContext`» (опциональное, гостевой фоллбэк), «ре-минт `sign`/`ts` перед каждым (ре)коннектом» (беспредметно - нечему истекать). `request_user` остаётся в v1, но с другой ролью: источник **числового uid** для сборки WS-URL до открытия сокета.
- **Alternatives considered:**
  - OAuth-режим (§13.7) - отложен. Это НЕ адаптер за тем же портом: другой транспорт uniproxy `uni.ws` (§15 строка 1139), auth в первом synchronize-state кадре (§13.5 строка 968), frame envelope НЕ снят (§13.8 п.4 строка 997), плюс нет публичного client_id/scope (§16 путь 3). Потребует НОВОГО `UniproxyWsClient`.
  - Ports-and-adapters с `buildWsUrl`/`getWsSyncState` в порту (A2) - отклонён: обещание «OAuth без правок транспорта» ложно; скаффолдинг под недобиваемую фичу = YAGNI.
  - Mode-branching transport (A3) - отклонён: в v1 один режим, для OAuth ветвление внутри одного WS-клиента невозможно.
  - Браузер-request-прокси (C2) - отклонён: не прогоняет бинарный WS.
  - msgpackr-кодек (B1) - отклонён: неудобен offset-контроль на декоде.
- **Why chosen:** cookie-only + тонкий шов инъекции даёт ровно то, что нужно v1, без мёртвого OAuth-кода; extract cookies выполняет constraint и держит рантайм лёгким; ручной codec даёт точный offset (нельзя сканировать `0x05`, seq может равняться 5) и явно кодирует три арности; спайки закрывают все живые развилки до старта.
- **Consequences:** cookie-хрупкость требует цикла рефреша - и это **единственный** канал auth-хрупкости: подписи в URL нет, истекать нечему, протухает сама cookie-сессия то headless-рефреш; **`request_user` (с CSRF) становится обязательным предусловием коннекта** - без числового uid WS не собрать; ручной codec требует исчерпывающих round-trip тестов (3 арности, подтверждён 13/13); OAuth в v2 - это отдельный транспорт, а не адаптер; **push зависит от per-connection `subscription-id` из операционного кадра - готовность к отправке наступает не на open, а на `subscribed`**; **полнота `search` ограничена неизвестным потолком `limit` - при упоре деградируем явно, с пометкой об усечении**; источник unread может потребовать отдельный counters-вызов.
- **Follow-ups (v2):** OAuth через новый `UniproxyWsClient` (после §13.8 п.4 + §16), расширение CSRF-модуля на HTTP-мутации (в v1 он покрывает только `request_user`), real-time подписки и обработка LIVE-событий (§9, app-level chat-`subscribe`), отправка файлов, мульти-аккаунт. Гостевая ветка (secretSign-фоллбэк) в roadmap не входит - нужна только для незалогиненного доступа, который продукту не требуется.

---

## Risks and Mitigations

| Риск | Источник | Митигация |
|------|----------|-----------|
| Хрупкость cookie (истечение, привязка к устройству/IP) | §4, §16 | Persist-профиль; headless-рефреш на 401; эскалация в headed при неудаче рефреша; документировать, что долгий простой может потребовать ре-логина. |
| ~~Cookie-WS не поднимается / `user=` не тот / secretSign нужен~~ **РАЗРЕШЁН** | §17.1/§17.4, SPIKE 3+1b (перезахват) | Снят: cookie-only handshake работает, `user=<числовой uid>` из `request_user`, подписи в URL нет, secretSign не нужен. Перепроверка на залогиненной сессии ВЫПОЛНЕНА - она же опровергла выводы ревизии 2. |
| ~~`sign` истекает по `ts` то реконнект падает с `bad sign`~~ **СНЯТ как беспредметный** | §17.1 | Риск был следствием гостевого артефакта: на cookie-пути ни `sign`, ни `ts` не существуют - истекать нечему, ре-минт не нужен. Актуально только в гостевой ветке, которая в v1 не реализуется. |
| **Cookie-сессия протухает то WS закрывается `COOKIE_AUTH_FAILED`/`NO_CREDENTIALS`** | §17.1, §14.5 | Единственный auth-канал хрупкости. Close-reason `COOKIE_AUTH_FAILED`/`NO_CREDENTIALS` то headless-рефреш профиля то ре-экстракт cookie то повторный `request_user` то ретрай коннекта; при неудаче рефреша - эскалация в headed-логин. |
| **Тихое сползание в гостевую ветку** | §17.1 | Без валидной cookie клиент не падает: `uid?.toString() || n.guid` даёт GUID, и собирается гостевой sign/ts-URL - ровно та ловушка, что породила ревизию 2. Митигация: числовой uid из `request_user` **обязателен**; пустой/нечисловой uid = жёсткая ошибка авторизации, фоллбэк на guid НЕ реализуется; тест на отказ. |
| **`request_user` требует CSRF (единственный read-метод с таким требованием)** | §17.4 | Забытый `X-CSRF-TOKEN` то 403 `bad_csrf_token` то нет uid то нет WS. `csrf.ts` обязателен в v1; вызов `request_user` всегда с токеном; тест «без CSRF то 403» пинит требование. |
| ~~push: `ClientTransportId`/`XivaSubscriptionId` неоднозначен~~ **РАЗРЕШЁН** | §17.2, SPIKE push↔subscribe | Снят: `XivaSubscriptionId` = `subscription-id` из операционного кадра `subscribed` (Xiva шлёт автоматически на connect); app-level subscribe не нужен; heartbeat-push дал `Status:1`. |
| **Гонка/протухание `subscription-id` для push** | §17.2 | Соединение не готово к push до прихода `subscribed`; `subscription-id` - per-connection состояние, обнуляется на reconnect (как seq §14.8); push ждёт свежий id, со stale не уходит; тесты «push до subscribed» и «reconnect то новый id». |
| Источник флага непрочитанных | §2.4, §14.2 строка 1030 | Проверить, несёт ли `history Limit:0` unread; иначе добавить `requestCounters то normalizeCounters`; тест unread-source. |
| Ротация протокола Яндекса (frame-формат, имена методов, config-значения при новой версии chats-web) | §12.2, §15 | Изолировать константы и frame codec в модули; fixture-тесты пинят поведение (3 арности); config-значения переопределяемы в config.json; debug-режим захвата кадров для ре-снапшота. |
| Rate limits | §14.4, §14.6 | Уважать `rate_limit.wait_for`; backoff на `TOO_MANY_REQUESTS(7)`/`THROTTLED(18)`/`RATE_LIMIT_EXCEEDED(23)`; сериализовать push-отправки; сюрфейсить как retryable MCP-ошибку. |
| Необратимость send (не в тот чат / дубль) | §14.4 | draft то confirm; confirm-токен с резолвнутым ChatId + хэш текста; ре-верификация перед push; `DUPLICATE(8)` идемпотентен; без авто-ретрая; авто-confirm запрещён. |
| Потеря точности таймстемпов-курсоров | §14.2 строки 1019/1027-1030 | Мкс (16 цифр) как string/BigInt; арифметика `n+1`/`i-1` через BigInt, не float; тест точности. |
| Резолв приватного ChatId (порядок guid, конструирование) | §5 строка 428 | resolveChat: сначала search chats (прямой ChatId); иначе search users то `<собеседникGuid>_<мойGuid>`; НЕ используем `create_private_chat` (мутация, вне scope); порядок собеседник+я проверяется на реальном чате. |
| ~~Неизвестный параметр страницы search~~ **РАЗРЕШЁН** | §17.5, SPIKE 2 | Снят отрицательным результатом: page-based пагинации в API НЕТ, параметр искать не нужно. `page`/`pages` вестигиальны; полнота - через limit-эскалацию. |
| **Серверный потолок `limit` в search не установлен** | §17.5 | На 7 совпадениях потолок не проверить. Клиент эскалирует `limit` до плато (`total < limit`); если сервер начнёт резать/ошибаться на большом `limit` - **деградировать ЯВНО**: вернуть найденное + машиночитаемая пометка об усечении (`truncated:true` + достигнутый `limit`), НИКОГДА не молча обрезать. Потолок фиксируется в константах, как только обнаружится на реальном наборе. |
| WS - единая точка отказа | §1, §14.7 | Reconnect-контроллер; обработка сброса seq (§14.8); server-ping health-check; понятные close-reason (§14.5). |
| Footprint Playwright/Chromium | constraint | Headless для рефреша, headed только для логина; один инстанс, один профиль. |
| ToS/легальность автоматизации личного аккаунта | §16 | Личный инструмент; риск принимается пользователем; без массовой рассылки, push сериализован. |

---

## Verification Steps

1. `pnpm test` (или npm) - unit+integration зелёные; frameCodec cross-check против msgpackr на всех трёх арностях проходит.
2. Integration против mock-WS: connect то whoami то history(Limit:0) то страница то push то commit-status; принудительный reconnect восстанавливает корреляцию; synthetic PROXY_STATUS/PUSH проходят через error-маппинг.
3. E2E smoke (env-gated, реальный аккаунт): пройти все Acceptance Criteria ниже вживую, включая draft то confirm в тестовый чат (по подтверждённому push↔subscribe) и скачивание картинки+файла.
4. MCP-клиент (Claude) видит пять инструментов и успешно вызывает каждый.
5. Лог-аудит: stdout чист (только MCP), корреляция и редакция секретов присутствуют в stderr.
6. Отдельный reviewer/verifier pass (не в этом же контексте) подтверждает отсутствие заглушек/`test.skip`/нереализованных веток.

---

## Acceptance Criteria (перенос из спека, все тестируемые)

- [ ] `list_chats` возвращает метаданные чатов (последнее сообщение, непрочитанные) через WS `history` с `Limit:0`; **источник флага непрочитанных подтверждён** (либо `Limit:0`, либо отдельный counters-вызов §14.2 строка 1030).
- [ ] `get_history(chat: ChatId|query, ...)` возвращает страницу сообщений конкретного чата с пагинацией по `MaxTimestamp`/`Offset` (курсоры BigInt/string); при query резолвит чат, при неоднозначности возвращает кандидатов.
- [ ] `search(query, entities)` ищет по `messages`/`users`/`chats` через HTTP registry (`enableCSRF:false`) и возвращает **полный набор результатов через эскалацию `limit`** (§17.5): `total == limit` то поднять `limit` и перезапросить, `total < limit` то найдено всё. **Проверяемо:** запрос с известным числом совпадений N при стартовом `limit < N` возвращает все N (эскалация сработала), а не первые `limit`. Поля `page`/`pages` не используются (вестигиальны, всегда 1); `limit` задаётся явно, серверный дефолт 5 не подразумевается. Entity `contacts` НЕ поддерживается и отвергается с понятной ошибкой (§17.6). При упоре в серверный потолок `limit` результат помечается как усечённый, а не обрезается молча.
- [ ] `send_message` шаг 1 (draft) возвращает превью и НЕ отправляет; шаг 2 (`confirm:true`) отправляет `push` Plain.Text с `ClientTransportId.XivaSubscriptionId` из операционного кадра `subscribed` (§17.2) и возвращает статус коммита (`FULLY_COMMITTED(1)`).
- [ ] `download_attachment(ref)`: для рефа с `file_info.id` строится download URL (§12.2), файл скачивается той же auth-сессией в папку загрузок, возвращается локальный путь; работает для картинок и произвольных файлов. `get_history` вложения НЕ качает - только рефы.
- [ ] Автоочистка: файлы старше TTL удаляются (проверяемо: положить старый файл то запустить sweep то файла нет).
- [ ] Auth bootstrap: при отсутствии сессии первый вызов инструмента поднимает headed-браузер для логина и продолжает; последующие работают на сохранённом профиле без ручного входа; при 401 профиль рефрешится.
- [ ] `list_chats`: все чаты, сортировка по свежести, флаг непрочитанных; `limit` (дефолт 50) и `unread_only` работают.
- [ ] `get_history` возвращает сообщение с полями: id, время (ISO+мкс), отправитель (имя+guid), текст, рефы вложений, reply/forward-контекст, флаги edited/deleted.
- [ ] WS-кадры кодируются/декодируются корректно: `0x01` + MessagePack-заголовок (арности `0x92`/`0x93`/`0x94`) + `0x05`+11×`0x00` + JSON; ответы парсятся, seq/RequestId матчатся; **декод идёт по длине msgpack-заголовка, а не сканом `0x05`** (кадр с `seq=5` декодируется верно - подтверждено SPIKE 4, §17.3).
- [ ] WS-URL собирается cookie-only, БЕЗ подписи: `?service&session=<4x4hex>&client=web_main&user=<числовой uid>` (§17.1) - параметров `sign`/`ts` в URL нет. `user=` несёт **числовой uid**, полученный из `request_user` (§17.4), не guid. `secretSign` не участвует.
- [ ] `request_user` вызывается с `X-CSRF-TOKEN` (без него 403 `bad_csrf_token`, §17.4), params `{bind_phone_number:false}`, и отдаёт `{status:"ok", data:{user:{guid, uid}}}`; числовой `uid` идёт в WS-URL, `guid` - в конструирование приватного ChatId (§5). Отсутствие числового uid = ошибка авторизации, а не фоллбэк на guid.
- [ ] Сервер поднимается как MCP stdio-сервер и все инструменты видны MCP-клиенту (Claude).
- [ ] Ошибки протокола (3 слоя) маппятся в осмысленные сообщения инструментов.

---

## Config Defaults (§15, hardcoded в defaults.ts, переопределяемо в config.json)

| Ключ | Значение |
|------|----------|
| `apiUrl` (HTTP RPC) | `https://yandex.ru/messenger/api/registry/api/` |
| `csrfTokenUrl` | `https://yandex.ru/messenger/api/registry/csrf-token/` (в v1 ИСПОЛЬЗУЕТСЯ: `request_user` требует CSRF, §17.4; отдаёт `{token}` голым, §17.6) |
| `xivaUrl` (WS cookie-режим) | `wss://push.yandex.ru/v2/subscribe/websocket{query}` |
| `xivaServiceName` | `messenger-prod` |
| `serviceId` (X-Origin-Service-ID, Meta.Origin) | `27` |
| `apiVersion` (Messenger version) | `5` |
| `client` (HTTP config-значение §15 строка 1144) | `1000` |
| `filePrivateHost` | `files.messenger.yandex.ru` |
| `filePublicHost` | `files.messenger.yandex.net` |
| `yapicFileHost` | `avatars.mds.yandex.net` |
| `workspaceId` | `main` (не снят, дефолт из бандла) |
| Xiva `{query}` (**подтверждено перезахватом SPIKE 3, §17.1**) | `?service=messenger-prod:version5*common+version5*main&session=<4x4hex random>&client=web_main&user=<числовой uid>` - **без `sign` и `ts`, URL не подписан** |
| `uidMethod` (источник числового uid, §17.4) | registry-метод `request_user` (POST на cookie **с `X-CSRF-TOKEN`**, params `{bind_phone_number:false}`) то `data.user.uid`. Нужен потому, что `whoami` живёт за WS. **Sign НЕ отдаёт** |
| `secretSign` (§17.1) | **НЕ используется в v1**: фоллбэк гостя / заблокированной cookie-авторизации (`secretSignNeeded` только на `COOKIE_AUTH_FAILED`/`NO_CREDENTIALS` либо под OAuth) |
| `searchDefaultLimit` (стартовый, §17.5) | задаётся клиентом явно; серверный дефолт = `5` (НЕ 10, как в §3.3), на него не полагаемся |
| `searchEntities` (валидные, §17.6) | `messages`, `users`, `chats` (`contacts` НЕВАЛИДЕН) |
| Downloads TTL | 7 дней (дефолт, переопределяемо) |
| Артефакты | `~/.config/yandex-messenger-mcp/` (`config.json`, `profile/`, `downloads/`) |

> **Различай два `client`:** HTTP config-значение `client=1000` (§15 строка 1144) и WS xiva-query `client=web_main` (§15 строка 1155) - это РАЗНЫЕ значения в разных местах, не путать.

> **Отложенный config (v2 OAuth, НЕ в v1 defaults):** `websocketUrl` (uniproxy) = `wss://uniproxy.messenger.yandex.ru/uni.ws` (§15 строка 1139), `uniproxyApiKey` (`auth_token` sync-state) = `069b6659-984b-4c5f-880e-aaedcfd84102` (§15 строка 1149). Нужны только для OAuth-транспорта uniproxy, который потребует нового WS-клиента (§13.5/§13.8 п.4). В v1 - YAGNI, не тащим.

---

## Changelog (применено из ревью Architect SOUND_WITH_CONCERNS + Critic REJECTED)

1. **OAuth-обоснование (Required #1).** Принцип 2 переписан: OAuth = ОТДЕЛЬНЫЙ транспорт uniproxy `uni.ws` с auth в первом synchronize-state кадре и неизвестным frame envelope (§13.5 строка 968, §13.8 п.4 строка 997); порт НЕ даёт «OAuth без правок транспорта». Выбран тонкий шов инъекции `{cookieHeader, userParam, secretSign?, yandexUid}`; `buildWsUrl`/`getWsSyncState` убраны из порта, сборка WS-URL отдана `MessengerWsClient` (единый xiva/cookie транспорт). OAuth-скаффолдинг (`getWsSyncState`, `websocketUrl`, `uniproxyApiKey`) снят из v1 как YAGNI. Fork(a): добавлена и выбрана опция A1 «cookie-only без OAuth-скаффолдинга»; прежний ports-and-adapters (A2) и mode-branching (A3) инвалидированы. ADR обновлён.
2. **Переупорядочены спайки (Required #2).** SPIKE 3 (cookie handshake) - первым после codec; primary-метод = захват живого handshake через Playwright init-script (§Приложение строки 1198-1204), не fallback; вариант (a) cookie-only проверяется первым. SPIKE 1 (secretSign) - УСЛОВНЫЙ (только при провале (a)), acceptance расширен: «secretSign не требуется/не добывается» = валидный PASS; жёсткая связка SPIKE1 то SPIKE3 убрана. Итоговый порядок: SPIKE 4 то SPIKE 3 то SPIKE push↔subscribe то SPIKE 1 (условно) то SPIKE 2.
3. **Добавлен SPIKE push↔subscribe (Required #3).** Блокер Phase 5, высший приоритет: определить, требует ли push subscribe-derived `XivaSubscriptionId` (§2.6 строка 243) или самоминт `createClientTransportId()` (§14.1 строка 1011). При зависимости - minimal subscribe в scope v1 (правка Non-goals: отложены LIVE-события, не подписка для отправки). Добавлены сценарий pre-mortem (#4) и тест push↔subscribe.
4. **Фикстуры PROXY_STATUS/PUSH (Required #4).** SPIKE 4 и unit-матрица кодека расширены на арности заголовка `0x92` (PROXY_STATUS `[reqId,errorCode]`) и `0x94` (PUSH `[uid,service,event,transitId]`), не только `0x93` DATA (§14.9 строка 1121, §2.2 строки 96-99). Отсутствующие байт-эталоны синтезируются по msgpack-спеке с пометкой `synthetic fixture, не captured`; интеграционный тест ошибок (§14.6) наполняется ими.
5. **resolveChat + puid (Required #5).** Специфицирован путь query то ChatId: приватный ChatId = `<собеседникGuid>_<мойGuid>` (порядок собеседник+я, §5 строка 428); выбрано - search chats (прямой ChatId) иначе search users то конструирование; `create_private_chat` отклонён (мутация, вне scope). SPIKE 3 включает резолв `user=` (uid vs puid, §13.5 строка 970) и источник puid (whoami его не отдаёт, §2.5 строки 214-224). Phase 2 AC поправлен на uid/guid (puid - условно по SPIKE 3).
6. **Источник unread для list_chats (Required #6).** Добавлена спайк/фикстур-проверка: несёт ли `history Limit:0` флаг непрочитанных или нужен отдельный `requestCounters то normalizeCounters` (§14.2 строка 1030). Условный `counters.ts`, поправлены AC и тест unread-source.
7. **MINOR (Required #7).** ~~`csrf.ts` отложен (все HTTP v1 - read/enableCSRF:false, §3.3/§13.4).~~ **Отменено ревизией 3 (п. 18): `csrf.ts` нужен в v1 - `request_user` требует CSRF (§17.4).** В push добавлен `LogData.YandexUid` из cookie `yandexuid` (§14.4 строка 1059). Разведены `client=1000` (HTTP config §15 строка 1144) и `client=web_main` (WS xiva-query §15 строка 1155). Таймстемпы-курсоры парсятся как string/BigInt, арифметика `n+1`/`i-1` через BigInt, не float (§14.2 строки 1019/1027-1030).

Дополнительно: добавлена секция `## Changelog`; ADR приведён к полному виду (Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups). Статус плана: pending approval.

---

### Ревизия 2 - применены результаты спайков (2026-07-16)

**Все 5 спайков ВЫПОЛНЕНЫ живыми экспериментами.** Источники: `.omc/spikes/yandex-mcp/SPIKE-RESULTS.md` + §17 в `yandex-messenger-api-research.md` (захват с `chats-web/3.22.0`). Факты из спайков **авторитетнее старых §-утверждений**. Phase 0 закрыта, блокеров реализации не осталось. Внесено:

8. **SPIKE 4 (frame codec) PASSED - 13/13 оффлайн.** Ручной кодек (Fork B2) подтверждён: энкод даёт побайтово точные заголовки §2.2; декод по разбору длины msgpack-заголовка (НЕ сканом `0x05`) корректно берёт push с `seq=5` - эмпирическое подтверждение довода B2 о коллизии fixint-5; синтетические `0x92`/`0x94` и str8-путь работают. Артефакт `spike4-framecodec.mjs` **переносится в репо как есть** и становится основой `frameCodec.ts` (правки: Fork(b) B2, Package Structure, Phase 3, AC кодека). §17.3.

9. **SPIKE 3 (handshake) PASSED, с поправкой к research.** Реальный WS-URL: `?service&session=<4x4hex>&client=web_main&sign=<32hex>&ts=<unix-sec>&user=<GUID>`. **Опровергнуто §2.1/§4/§15** («в URL токена нет»): `sign` (=secretSign) и `ts` ПРИСУТСТВУЮТ, cookie-only handshake НЕ достаточен. **Опровергнуто §2.1/§15/§13.5** («user = числовой uid» / «user=<puid>»): `user=` это **GUID** из whoami `UserInfo.Guid` - **вопрос uid/puid закрыт**, поиск источника puid из плана убран. Правки: Requirements (auth), Принципы 1-2, Driver 2, Pre-mortem 2, Package Structure, Phase 2-3, Risks, AC, Config Defaults. §17.1.

10. **SPIKE 1/1b (secretSign) PASSED - источник найден, условность снята.** `sign` приходит **в ответе HTTP-метода `request_user`** (тело содержит ровно то значение sign, что уходит в WS-URL, + ключ `secretSign`). Server-issued, клиентом не вычисляется (гипотеза client-side HMAC отвергнута). Подтверждает §14.5, **закрывает §13.8 п.1**, правит §10 («не размаплен»). SPIKE 1 перестал быть УСЛОВНЫМ - он был обязателен и решён; `secretSign` перестал быть опциональным полем `AuthContext` (`secretSign?` то `secretSign`), `secretSign.ts` из условного стал обязательным. Добавлен ре-минт `sign`/`ts` перед каждым (ре)коннектом. §17.4.

11. **SPIKE push↔subscribe PASSED - противоречие §2.6 vs §14.1 разрешено.** App-level chat-`subscribe` для отправки НЕ нужен: Xiva на connect сама шлёт операционный текст-кадр `{operation:"subscribed", subscription-id:"<40hex>", ...}`, и `push.ClientTransportId.XivaSubscriptionId` ТОЧНО РАВЕН этому id; heartbeat-push вернул `Status:1`. `createClientTransportId()` (§14.1) оборачивает subscription-id из кадра. **Правка Non-goals:** в v1 входит чтение операционного `subscribed` (транспортное, автоматическое); отложен только app-level chat-subscribe для LIVE-событий. `protocol/subscribe.ts` вычеркнут из v1. Правки: Requirements, Non-goals, Pre-mortem 4, Test Plan, Package Structure, Phase 3/5, Risks, AC. §17.2.

12. **SPIKE 2 (search) PASSED - ОТРИЦАТЕЛЬНЫЙ РЕЗУЛЬТАТ, главная правка плана.** **Page-based пагинации в search НЕТ**; §3.3 был прочитан неверно. Свип на bucket `users`: `limit=1→total=1`, `limit=5→total=5`, `limit=10/20/50/100→total=7` (плато), `count==total`, **`pages`=1 всегда**; без параметра `limit` то `total=5` (дефолт 5, а не 10). Кандидаты `page`/`offset`/`from`/`skip`/`page_number`=2 сервером ИГНОРИРУЮТСЯ (`works:false` для всех пяти). Значит `total` = число ВОЗВРАЩЁННЫХ элементов (`min(limit, реальное)`), а не общее число совпадений; `page`/`pages` вестигиальны. **Все упоминания «полная пагинация по всем страницам» / «page-param из SPIKE 2» переписаны под limit-эскалацию** (Requirements, Test Plan unit+e2e, `search.ts`, Phase 4, AC). §17.5.

13. **Риск «Неизвестный параметр страницы search» СНЯТ как разрешённый.** Заменён на риск «**серверный потолок `limit` не установлен**»: при упоре - явная деградация (вернуть найденное + машиночитаемая пометка об усечении), НИКОГДА не молча обрезать. Аналогично сняты как разрешённые риски cookie-WS/`user=` и `ClientTransportId`; взамен добавлены остаточные риски «`sign` истекает по `ts`» и «гонка/протухание `subscription-id`». Правки: Risks, ADR Consequences.

14. **Поправки каталога методов (правят §10/§3.1/§3.3).** `get_current_user_data` **НЕ СУЩЕСТВУЕТ** (`{code:"No such path", source:"yamb"}` даже с валидным CSRF) - идентичность берётся только из WS `whoami` (§2.5); `get_organizations` требует `organization_ids`; `csrf-token` возвращает `{token}` голым, без обёртки `{status,data}`; **entity `contacts` невалиден** для search (валидны `messages`/`users`/`chats`) - отвергается на входе, отражено в AC; поиск требует нормальных термов (односимвольные/стоп-слова дают 0-1). §17.6.

15. **Принцип 4 (Spike-before-build) обновлён** с «предстоит» на «ВЫПОЛНЕНО 2026-07-16» с перечнем подтверждённого/опровергнутого и остаточной проверки. Секция `## Spikes` переписана: все 5 помечены ✅ PASSED с результатами, таблицами и ссылками на артефакты `.omc/spikes/yandex-mcp/`; убраны формулировки «условный» (SPIKE 1) и «нужен аккаунт с total>limit» (SPIKE 2) - выполнено. Phase 0 помечена ✅ ВЫПОЛНЕНА.

**Остаточная проверка (не блокер, гейтится в Phase 3 acceptance):** SPIKE 3/1b сняты на сессии, которая на тот момент могла быть гостевой (полноценный логин подтверждён позже: `Session_id`/`sessionid2`/`yandexuid`, 17 кук, UI с реальными чатами). Структура handshake и источник sign - протокольные факты, но перепроверяются на первом реальном коннекте; тогда же уточняется, приходит ли `ts` из `request_user` или минтится клиентом.

> ⚠️ **Пункты 9, 10 и 13 (в части «sign истекает») ревизии 2 ОТМЕНЕНЫ ревизией 3: они построены на гостевом артефакте.** Остаточная проверка выше выполнена 2026-07-17 и опровергла их. Раздел сохранён как история решений; действующая версия - ниже.

Статус плана: **pending approval** (не меняется - спайки уточняют реализацию, но решения A1/B2/C1 подтверждены, а не пересмотрены).

---

### Ревизия 3 - откат гостевых артефактов (2026-07-17)

**Перезахват на ЗАЛОГИНЕННОЙ сессии опроверг auth-выводы ревизии 2.** Захват 2026-07-16 был снят с **гостевой** (незалогиненной) сессии и принят за норму: гостевая сессия не падает, а тихо уходит в фоллбэк-ветку и выдаёт правдоподобный, но чужой протокол. Оговорка ревизии 2 («сессия могла быть гостевой, перепроверить») **сработала**. Эталон истины - research §17. Внесено:

16. **WS-handshake: cookie-only РАБОТАЕТ, откат «подписанного URL».** Реальный URL залогиненной сессии: `?service=messenger-prod:version5*common+version5*main&session=<4x4hex>&client=web_main&user=<числовой uid>` - **ни `sign`, ни `ts` НЕТ**. `user=` - **числовой uid** (наблюдался `<numeric-uid>`, тот же, что в примере §2.1), не GUID. **Исходные §2.1/§4/§15 БЫЛИ ПРАВЫ**; пункты 9-10 ревизии 2 отменены. Гостевая ветка (`sign`+`ts`+`user`=GUID) объясняется бандловым фоллбэком `uid?.toString() || n.guid` - у гостя нет числового uid. Правки: Requirements, Принципы 1-2, Driver 2, Fork A1, Pre-mortem 2, Package Structure, Phase 0/2/3, ADR, Risks, AC, Config Defaults. §17.1.

17. **`secretSign` - гостевой фоллбэк, НЕ нормальный путь.** `secretSignNeeded` взводится только на close-reason `COOKIE_AUTH_FAILED`/`NO_CREDENTIALS` либо под OAuth. В `AuthContext` поле стало опциональным (`secretSign?`) и в v1 не заполняется; `auth/secretSign.ts` из плана **вычеркнут**. Гостевая ветка в v1 не реализуется: отсутствие числового uid = ошибка авторизации, а не повод подставить guid. §17.1.

18. **`request_user` НЕ отдаёт sign; его роль - источник ЧИСЛОВОГО uid.** Живой ответ: `{status:"ok", data:{user:{guid, uid, ...}}}`. Params: `{bind_phone_number:false}` (§10 числил opaque). **Требует CSRF** - без `X-CSRF-TOKEN` то 403 `bad_csrf_token`, единственное известное исключение среди read-методов. Нужен MCP потому, что `whoami` живёт ЗА WS (курица-яйцо), а uid необходим для сборки URL до открытия сокета. Следствие: **`csrf.ts` возвращён в v1** (ровно под `request_user`; прочие read - без CSRF), добавлен `auth/requestUser.ts`. §17.4.

19. **`AuthContext` переопределён:** `{cookieHeader, userUid, userGuid, yandexUid, secretSign?}`. `userUid` (числовой) идёт в `user=` WS-URL; `userGuid` нужен для конструирования приватного ChatId (§5); `secretSign?` опционален (гостевая ветка). Прежний `{cookieHeader, userGuid, secretSign, ts, yandexUid}` отменён.

20. **Риск «`sign` истекает по `ts`» СНЯТ как беспредметный**, вместе с «ре-минтом `sign`/`ts` перед каждым (ре)коннектом» (на cookie-пути истекать нечему). Заменён на «**cookie-сессия протухает то headless-рефреш**» (`COOKIE_AUTH_FAILED`/`NO_CREDENTIALS` то рефреш профиля то ре-экстракт то `request_user` то ретрай). Добавлены риски «тихое сползание в гостевую ветку» и «`request_user` требует CSRF». Правки: Risks, Pre-mortem 2, ADR Consequences, Observability (close-reason `bad sign` убран). Пункт 13 ревизии 2 в части sign отменён.

21. **Урок в Принцип 1 (дисциплина захвата).** Протокольный вывод принимается только с сессии, **залогиненность которой доказана ПО ДАННЫМ**: минимум `Session_id` **и** непустой список чатов. Косвенные признаки (наличие 17 кук, отрисовка UI) логин НЕ доказывают - именно они и обманули ревизию 2.

**Что УСТОЯЛО и не пересматривается:** push↔subscribe (§17.2; подтверждено и на залогиненной сессии - первый push ушёл раньше первого app-level subscribe и получил `Status:1`; нюанс: на реальном аккаунте клиент шлёт много app-level subscribe - это LIVE-подписка на чаты, v2); SPIKE 4 frame codec (13/13, §17.3); SPIKE 2 search (page-пагинации нет, `total` = число возвращённых, полнота через эскалацию `limit`, дефолт 5, §17.5); поправки каталога §17.6 (`get_current_user_data` не существует, `get_organizations` требует `organization_ids`, `csrf-token` отдаёт `{token}` голым, `contacts` невалиден). Решения A1/B2/C1 подтверждены.

Статус плана: **pending approval** (не меняется).
