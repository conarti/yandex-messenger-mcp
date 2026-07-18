# Yandex Messenger MCP — spike results

Спайки из плана `.omc/plans/ralplan-yandex-messenger-mcp.md`. Живые значения секретов (session/uid/guid) НЕ сохраняются — только структура.

> ⚠️ **Ревизия 2026-07-17: SPIKE 3 и SPIKE 1/1b были сняты с ГОСТЕВОЙ (незалогиненной) сессии и дали неверные протокольные выводы.** Перезахват на залогиненной сессии их опроверг. Секции ниже переписаны. Эталон истины — research §17.

## SPIKE 4 — WS frame codec (offline) ✅ РЕШЁН

**Артефакт:** `spike4-framecodec.mjs` (13/13 passed). Проверено против §2.2/§14.9: энкод даёт побайтово точные заголовки whoami/history/push/subscribe; декод по длине msgpack-заголовка игнорирует коллизию `0x05` (push seq=5); арности `0x92`/`0x94` декодируются; str8-путь. Ручной frameCodec (Fork B2) подтверждён.

## SPIKE 3 — cookie WS-handshake ✅ РЕШЁН (перезахват на залогиненной сессии 2026-07-17)

**Артефакт:** `capture-handshake.mjs` (headed Playwright + init-script WS-патч).

Реальный handshake-URL **залогиненной** сессии (значения вычищены, структура):
```
wss://push.yandex.ru/v2/subscribe/websocket
  ?service=messenger-prod:version5*common+version5*main
  &session=<4x4hex random>
  &client=web_main
  &user=<числовой uid>    ← ЧИСЛОВОЙ uid (наблюдался <numeric-uid> — тот же, что в примере §2.1)
```
**Ни `sign`, ни `ts` в URL НЕТ. Cookie-only handshake РАБОТАЕТ** — WS открывается и качает трафик.

**Итог: research §2.1/§4/§15 БЫЛИ ПРАВЫ** («в URL токена нет, только service/session/client/user»; «user = числовой uid»). Прежняя редакция этой секции — **гостевой артефакт**, снята.

**Гостевая (незалогиненная) ветка** — что было принято за норму в захвате 2026-07-16:
```
...&client=web_main&sign=<32-hex>&ts=<unix-sec>&user=<GUID>
```
У гостя нет числового uid, поэтому бандловый фоллбэк `this.uid = uid?.toString() || n.guid` подставляет GUID, и появляются `sign`+`ts`. `secretSignNeeded` взводится только на close-reason `COOKIE_AUTH_FAILED`/`NO_CREDENTIALS` либо под OAuth. **secretSign — это фоллбэк гостя / заблокированной cookie-авторизации, а НЕ нормальный путь.**

UserAgent клиента `chats-web/3.22.0` (research снят с 3.21.0; протокол стабилен).

Ссылка: research §17.1.

## push↔subscribe ✅ РЕШЁН (критический) — УСТОЯЛ на залогиненной сессии

**Наблюдение живого трафика:**
- Xiva присылает операционный текст-кадр `{operation:"subscribed", subscription-id:"<40hex>", uid, service, event}` автоматически после connect.
- `push.ClientTransportId.XivaSubscriptionId` **точно равен** `subscription-id` из кадра `subscribed`.
- Heartbeat-push получил ответ `Status: 1` (FULLY_COMMITTED).
- Гостевой захват: клиент вообще не слал app-level `subscribe`; порядок sent: `whoami, history, push(heartbeat), history`.

**Подтверждено перезахватом на залогиненной сессии (2026-07-17):** вывод устоял. Нюанс реального аккаунта — веб-клиент шлёт **много** app-level `subscribe` (по одному на чат; у гостя чатов не было). Но порядок доказывает независимость: первый `push` ушёл **раньше** первого app-level `subscribe` (позиции 3 и 6 в потоке sent) и получил `Status:1`. То есть app-level `subscribe` — это LIVE-подписка на чаты (v2), к отправке отношения не имеет. Также в recv наблюдался метод `delivery` (в каталоге §2.3 отсутствует).

**Разрешение противоречия §2.6 vs §14.1:** для отправки (`push`) НЕ нужен app-level chat-`subscribe`. Нужен `XivaSubscriptionId`, который приходит транспортным операционным кадром `subscribed` (Xiva-уровень, автоматически на connect). `createClientTransportId()` (§14.1) фактически оборачивает этот subscription-id.

**Конкретный флоу send_message:** connect WS → дождаться операционного кадра `subscribed` → взять `subscription-id` → положить в `push.ClientTransportId.XivaSubscriptionId` → отправить `push` с `Plain.Text`. Правка плана: минимальная обработка операционного `subscribed` входит в v1 (транспортная, автоматическая); отложенным остаётся только app-level chat-subscribe для LIVE-событий.

Также подтверждено (§14.7): server-ping `{operation:"ping", server-interval-sec:60}`; наблюдался server PUSH(3)-кадр (frameType 3).

## SPIKE 1 / 1b — secretSign ✅ РЕШЁН (secretSign НЕ нужен на cookie-пути)

**Прежний вывод («sign обязателен и приходит из `request_user`») — гостевой артефакт, снят.** Он был построен на гостевом захвате SPIKE 3, где sign действительно выдаётся как фоллбэк.

**Истина (залогиненная сессия, перезахват 2026-07-17):**
- `secretSign` в WS-URL **не участвует**: cookie-only handshake работает, ни `sign`, ни `ts` в URL нет (см. SPIKE 3).
- **`request_user` НЕ отдаёт sign.** Живой ответ: `{status:"ok", data:{user:{guid, uid, ...}}}` — никаких `secret_sign`/`sign`/`ts`.
- Params `request_user`: `{bind_phone_number: false}` (снято с веб-клиента; §10 числил их opaque).
- **`request_user` ТРЕБУЕТ CSRF**: без `X-CSRF-TOKEN` → 403 `bad_csrf_token`. Единственное известное исключение из «read-методы идут без CSRF» (прочие read, напр. `list_contacts`, работают на голой cookie).
- Клиент троттлит вызов через localStorage-ключ `requestUserLastTime`.
- Маппинг веток из бандла: `("user" in e) ? {user:a(e.user), secretSign:e.secret_sign} : {user:c(e), secretSign:{sign:e.sign, ts:e.ts}}` — вторая ветка (sign/ts) и есть гостевой путь.

**Зачем `request_user` всё же нужен MCP:** он отдаёт **числовой uid**, без которого не собрать WS-URL (`user=<uid>`), а `whoami` живёт ЗА WS — курица-яйцо. То есть `request_user` = HTTP-источник uid до открытия сокета, а НЕ источник подписи.

**Флоу для headless Node:** cookie → CSRF-токен → POST registry `request_user` → взять числовой `uid` (+ `guid`) → собрать WS-URL `?service&session&client=web_main&user=<uid>`.

**Артефакт:** `spike-1b-2-http.mjs` (харнесс дал `SIGN_FROM_HTTP_RESPONSE` на гостевой сессии — вердикт невалиден вне гостевой ветки).

Ссылка: research §17.4.

## SPIKE 2 — search page-param ✅ РЕШЁН (отрицательный результат)

**Артефакт:** `spike2-limit-sweep.mjs` (решающий), плюс `spike-2-diag.mjs`, `spike2-final.mjs`, `spike2-users-pagination.mjs`.

**Пагинации по страницам в `search` НЕТ. §3.3 прочитан неверно.**

Свип `limit` на bucket `users`, query `"а"` (аккаунт залогинен, реальные данные):

| reqLimit | total | count | pages |
|---|---|---|---|
| 1 | 1 | 1 | 1 |
| 5 | 5 | 5 | 1 |
| 10 / 20 / 50 / 100 | **7** | 7 | **1** |
| без параметра | 5 | 5 | 1 |

Выводы:
1. **`total` = число ВОЗВРАЩЁННЫХ элементов** (`min(limit, реальное)`), НЕ общее число совпадений. Плато на 7 = реальное количество.
2. **`pages` всегда 1, `page` всегда 1** — поля вестигиальные, пагинацию не описывают.
3. **Дефолтный `limit` = 5** (§3.3 утверждает 10).
4. Все кандидаты параметра страницы игнорируются сервером: `page`/`offset`/`from`/`skip`/`page_number` = 2 → `respPage:1`, `itemChanged:false`, `works:false` для всех пяти.

**Стратегия клиента вместо пагинации:** запрашивать через `limit`; **если `total == limit` — возможно есть ещё, поднять `limit` и перезапросить**; плато `total < limit` = найдено всё. Серверный потолок `limit` не установлен (на 7 совпадениях не проверить), выяснится на большом наборе.

**Влияние на спек:** требование «поиск нам нужен полноценный» остаётся выполнимым, но реализуется через `limit`-эскалацию, а НЕ через обход страниц. AC плана про «проходит все страницы» подлежит переписи.

## Поправки к research, найденные попутно

- **`get_current_user_data` НЕ СУЩЕСТВУЕТ**: `{code:"No such path", source:"yamb"}` даже с валидным CSRF. §10 его перечисляет — ошибка дока. Идентичность брать из WS `whoami` (§2.5).
- **`get_organizations` требует параметр** `organization_ids`: без него `{code:"bad_request", text:"organization_ids is required"}`. §10 числит params как opaque.
- **`csrf-token` возвращает `{token}` голым**, без обёртки `{status,data}` (уточняет §3.1). CSRF-флоу рабочий.
- **entity `contacts` невалиден** для `search` (`status:"error"`); валидны `messages`/`users`/`chats`.
- Поиск требует нормальных термов: односимвольные и стоп-слова дают 0-1.

## ⚠️ Оговорка к SPIKE 3 / 1b — СРАБОТАЛА (перепроверка опровергла)

Оговорка прежней редакции звучала так: «сняты на сессии, которая могла быть гостевой; структура handshake (`sign`+`ts`+`user`=guid) и источник sign (`request_user`) — протокольные факты, но перепроверить на залогиненной сессии».

**Перепроверка 2026-07-17 выполнена и опровергла оба «факта».** Сессия действительно была гостевой; наличие кук (`Session_id`/`sessionid2`/`yandexuid`, 17 штук) и отрисовка UI были прочитаны как доказательство логина ошибочно. На залогиненной сессии: `sign`/`ts` отсутствуют, `user=` несёт числовой uid, `request_user` sign не отдаёт. Секции SPIKE 3 и SPIKE 1/1b выше переписаны под истину.

### Урок

**Перед любыми протокольными выводами убедиться, что сессия залогинена**, и проверять это ПО ДАННЫМ, а не по косвенным признакам: минимум — наличие `Session_id` **и** непустой список чатов в трафике/UI. Гостевая сессия Мессенджера не падает, а тихо уходит в фоллбэк-ветку (нет числового uid → `uid?.toString() || n.guid` → GUID + `sign`/`ts`), и её артефакты выглядят как валидный протокол. Наличие кук само по себе логин не доказывает.

---

**Статус: все 5 спайков закрыты.** frame codec (4) ✅, handshake-структура (3) ✅ *(перезахвачена на залогиненной сессии: cookie-only, без sign/ts, `user`=числовой uid)*, secretSign (1b) ✅ *(отрицательный: на cookie-пути не нужен; `request_user` даёт uid, не sign)*, push↔subscribe ✅ *(устоял)*, search-пагинация (2) ✅ — отрицательный результат, требующий правки спека/плана.
