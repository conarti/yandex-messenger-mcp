# Спайки 1 и 3 — разбор клиентского бандла

Метод: скачан и грепнут публичный бандл `chats-web`, хеш сборки взят живьём из DOM `yandex.ru/chat`.

- Бандл: `https://yastatic.net/s3/chat-static/_/0x421b6bd/web/{app.js,*.chunk.js}`
  (хеш `0x421b6bd`; в §Приложении research зафиксирован устаревший хеш — заменить)
- Проанализировано: `app.js` (3.5 МБ) + 12 чанков. Ключевые: `ui.chunk.js`, `quick-access-panel.chunk.js`, `lang-ru.chunk.js`
- Мутаций не производилось, живая переписка не читалась. Бандл удалён после анализа.
- Карта чанков (из `__webpack_require__.u`): `501:"ui-additionals"`, `522:"ui"`, `508:"lang-ru"`, `867:"quick-access-panel"`, `947:"info-panel"`

| Спайк | Итог |
|---|---|
| 1. Создание треда («Обсудить») | **НАЙДЕНО.** Механики создания на сервере НЕТ — `thread_id` вычисляется на клиенте детерминированно |
| 3. Резолв join-ссылки | **НАЙДЕНО.** Полностью, включая билдер ссылки и тред-вариант с 3-м сегментом |

---

## СПАЙК 1 — создание треда: НАЙДЕНО (вывод отрицательный и это главное)

### Вывод

**Серверного метода создания треда не существует.** В бандле нет ни `create_thread`, ни
`createThread`, ни `new_thread`, ни `start_thread` — только `join_to_thread` и `leave_thread`
(по одному вхождению каждый, оба в `app.js`).

Кнопка «Обсудить» **ничего не создаёт**. Она:
1. вычисляет `thread_id` из `{ChatId родителя, Timestamp родительского сообщения}` **чистой строковой функцией, без сети**;
2. пытается открыть тред как **обычный чат** с этим `ChatId` (`history`);
3. если сервер отвечает `ENTITY_NOT_FOUND` — клиент **синтезирует пустой тред локально**;
4. тред материализуется на сервере **в момент отправки первого сообщения** обычным `push({Plain:{ChatId: <thread_id>, ...}})`.

Тред — это чат. `thread_id` — это `ChatId`. Отдельной сущности нет.

Это объясняет, почему `uiLoggerScope` у кнопки — `btn_go_to_thread`, а не `create`.

### Цепочка доказательств

**1. i18n-ключ кнопки** (`lang-ru.chunk.js`) — единственное вхождение «Обсудить»:

```js
write_in_thread:"Обсудить"
```

**2. Пункт меню** (`ui.chunk.js` @89209, дубль в `quick-access-panel.chunk.js` @16227):

```js
[a.WRITE_IN_THREAD]:{id:a.WRITE_IN_THREAD,uiLoggerScope:"btn_go_to_thread",
  textI18nKey:"common.write_in_thread",icon:"chat-thread-outline",
  testTag:"message-menu-write-in-thread",enabledPredicate:i,color:"default"}
```

**3. Обработчик клика** (`ui.chunk.js` @627406 и @594372) — на вход идёт только ключ сообщения:

```js
onGoToThreadClick(t){e((0,I.E)({threadData:{timestamp:n,chatId:a},toggle:!0,hit:t.$ui.hit}))}
/* и из контекстного меню: */
case wr.RP.WRITE_IN_THREAD:(0,it.vx)(),e((0,I.E)({threadData:c,hit:t.$ui.hit}));break;
```

**4. Экшен `openThread`** (`app.js`, модуль `61751`, экспорт `E:()=>_`) — `threadId` считается локально:

```js
function _(e){let t=e.threadData,n=e.timestamp,p=e.toggle,f=void 0!==p&&p,_=e.inviteHash,E=e.hit;
 return(e,p)=>{const A=p(),w=(()=>{
   if(t)return(0,a.s3)(t);                                   /* <-- ВЕСЬ «create» вот здесь */
   if(!_)return;
   const e=A.chatsMeta.inviteHashToChatId[_.hash];
   return e?(0,a.s3)({chatId:e,timestamp:_.timestamp}):void 0
 })();
 ...
 const I=()=>e((0,h.Ec)({component:g,props:{threadId:w,inviteHash:T,anchor:w?void 0:n},push:C,...}));
 const O=(null==t?void 0:t.chatId)||T&&A.chatsMeta.inviteHashToChatId[T.hash];
 !O||(0,c.T)(A,O)?I():(0,b.T)({dispatch:e,getState:p},{chatId:O,inviteHash:null==T?void 0:T.hash,
    source:"open_thread",callback:e=>{e?v.M.showError(e,(0,i.a)("error.request")):I()}})}}
```

Никакого запроса. `(0,a.s3)` — синхронная функция из модуля `40939`.
Последняя строка — вступление в **родительский** чат, если ты в нём не состоишь (`source:"open_thread"`), не создание треда.

### Алгоритм `thread_id` — модуль `40939` (`app.js` @806145)

Регэкспы модуля (вербатим):

```js
const _=/^\d+\/(\d+)\//,E=/^1\/(\d+)\//,A=/^(\d+)\/(\d+)\/(.+)$/,
      w=/^1(\d\d)\/(\d+)\/(.+)_(\d{16})$/,S=/^2\/(\d+)\//,T=/^(\d+)\/(\d+)\//,
      C=/^[a-z0-9-]{36}_[a-z0-9-]{36}$/,I=/^([a-z0-9-]{36})_([a-z0-9-]{36})$/,O="110/0/";
```

**Построение** (`s3` → `J`), вербатим:

```js
function J(e){
  if(U(e.chatId)) return `110/0/${e.chatId}_${e.timestamp}`;   /* U = C.test → приватный чат guid_guid */
  const t=A.exec(e.chatId)||[],n=(0,r.Z)(t,4),i=n[1],s=n[2],a=n[3];
  if(!i) return;
  const c=parseInt(i,2);
  return isNaN(c)||!(0,o.$K)(c)||c>99 ? void 0 : `${100+c}/${s}/${a}_${e.timestamp}`
}
```

**Обратный разбор** (`J$` → `j`), вербатим:

```js
const j=e=>{const t=w.exec(e); if(!t) return;
  const n=(0,r.Z)(t,5),i=n[1],o=n[2],s=n[3],a=n[4];
  try{ return "10"===i ? {timestamp:parseInt(a,10),chatId:s}
                       : {timestamp:parseInt(a,10),chatId:`${parseInt(i,10)}/${o}/${s}`} }catch(e){return}}
```

Сопутствующие предикаты того же модуля:

```js
function R(e){return e.startsWith(O)}      /* DJ  — тред в приватном чате */
const B=e=>null!==w.exec(e);               /* n2  — isThreadId       */
const U=e=>C.test(e);                      /* TP  — isPrivateChatId  */
function k(e){return!(0,o.$K)(e.threadData)} /* fb — у чата есть threadData → это тред */
const K=/^([a-z0-9-]{36})_\1$/, Y=/^110\/0\/([a-z0-9-]{36})_\1_\d{16}$/;
function Z(e){return K.test(e)||Y.test(e)} /* zv — self-chat / тред в «Избранном» */
```

#### Правило (проверено прогоном извлечённого кода, синтетические id)

| Тип родителя | `ChatId` | `thread_id` |
|---|---|---|
| Группа | `0/0/<uuid>` | `100/0/<uuid>_<ts>` |
| Канал | `1/0/<uuid>` | `101/0/<uuid>_<ts>` |
| Приватный | `<guid>_<guid>` | `110/0/<guid>_<guid>_<ts>` |
| Бизнес | `2/<ns>/<uuid>` | **`undefined`** (см. ниже) |

`<ts>` — метка **родительского** сообщения, ровно 16 цифр (мкс). Round-trip `J → j` сходится для группы/канала/приватного.

⚠️ **`parseInt(i,2)` — radix 2, не 10.** Это не опечатка распаковки, в бандле именно так.
Следствия:
- префиксы `0` и `1` → radix значения не важен, совпадает с radix 10;
- префикс `2` (бизнес-чат, `S=/^2\/(\d+)\//`) → `parseInt("2",2) = NaN` → **треды в бизнес-чатах через эту кнопку недоступны**;
- обратный парсер `j` использует `parseInt(i,10)` — то есть пара функций **несимметрична** для экзотических префиксов.

**Рекомендация для MCP:** реализовать `100 + parseInt(prefix, 10)` для префиксов `0`/`1` — это согласуется с обратным парсером (авторитетным, т.к. он разбирает то, что реально лежит в `ChatId` с сервера). Поведение для префикса `2` подтвердить живьём, прежде чем закладываться. Не копировать radix 2 слепо.

### Открытие треда = обычный `history`

`Vt` (`sU`, `app.js` @467596) — резолв треда:

```js
function Vt(e,t){return(n,r)=>{const i=(0,T.J$)(e);
  if(!i||!(0,be.dR)(r(),i.chatId)) return Promise.reject(new ne.z({threadId:e}));
  if(!(0,w.T)(r(),e)) return n(function(e,t,n){return(r,i)=>r((0,Be.WK)(e,n)).catch((n=>{
    if(!te.g.is(n)) throw n;                                     /* g = ENTITY_NOT_FOUND */
    return Promise.resolve((0,k.bW)(i(),t)).then((e=>{if(!e)return r((0,Be.Jb)(t))})).then((()=>{
      const n=(0,k.bW)(i(),t),o=(0,w.T)(i(),t.chatId);
      if(!n||!o||!(0,K.LG)(n)&&!(0,K.EB)(n)) throw new te.g({threadId:e});
      if(!(0,L.rv)(o)) throw new ne.z({threadId:e});
      r(B._Q({authId:i().authId,
              chats:[(0,T.mL)(e,o,n)],                            /* ЛОКАЛЬНЫЙ объект треда */
              histories:[{chat_id:e,historyStartTs:0,last_seqno:0,last_timestamp:0,messages:[]}],
              users:[],preventA11yLog:!0,source:void 0})),
      X.bQ.onChatResolved()}))}))}(e,i,t));
  return (0,_e.pb)(r(),e)?Promise.resolve():n(jt([e]))}}
```

`Be.WK` (`app.js` @496733) — обычная загрузка чата:

```js
function D(e,t,n){return(s,l)=>(0,a.X)((()=>o.bC.getChatWithHistory({chatId:e,inviteHash:t||(0,d.vv)(l(),e),limit:n||(0,d.yS)(l())})))
  .then(...)
  .catch((t=>{...
    if(t.statusIs(g.bv.ResponseStatus.ENTITY_NOT_FOUND)) throw new v.g({chatId:e}); ...}))}
```

`getChatWithHistory` (`app.js` @1231402) — это WS `history`:

```js
getChatWithHistory(e){let t=e.chatId,n=e.inviteHash,r=e.limit;
  return this.requestChatHistory({ChatId:t,InviteHash:n,Limit:r,ChatDataFilter:{}})}
```

Итог: **открыть тред = `history {ChatId:<thread_id>, ChatDataFilter:{}, Limit:n}`.**
`ENTITY_NOT_FOUND` = «треда ещё нет», а не ошибка. Именно так веб отличает пустой тред от существующего.

### Отправка в тред — без единого спец-поля

`convertMessageToPlain` (`app.js` @920663, модуль `22879`):

```js
function le(e,t){const n={ChatId:e.chatId,CustomPayload:k.serialize(t),PayloadId:e.messageId,
  MentionedUserIds:e.mentions&&e.mentions.map((e=>e.guid)),
  ForwardedMessageRefs:e.forwarded&&e.forwarded.map((e=>({ChatId:e.chatId,Timestamp:e.timestamp}))),
  ForwardedMessageStyles:e.forwarded&&e.quoteFragment?[{Quote:e.quoteFragment}]:[],
  UrlPreviewDisabled:e.urlPreviewDisabled,IsImportant:e.important};
  return e.version&&(n.Timestamp=e.timestamp),e.data?((0,_.pb)(e,{text:e=>{n.Text={MessageText:e.message_text}},...
```

Тред-полей нет вообще. `ChatId` — это и есть `thread_id`. Отправка (`app.js` @1226822):

```js
sendMessage(e,t,n){return this.push({Plain:A.convertMessageToPlain(e,this.makeCustomPayload(t)),
  NotificationBehaviour:n}).then(A.deserializePushResponse)}
```

Попутно подтверждено для спека v2 (§9.3): `deleteMessage(e,t){return this.push({Plain:{ChatId:e,Timestamp:t}})}` — пустой `Plain` = удаление.
И `Text:{MessageText}` — **никаких entities**, что усиливает решение Round 3 (но окончательно это решает спайк 2).

### `join_to_thread` / `leave_thread` — точная форма (`app.js` @1076366)

```js
joinToThread(e,t){let n=e.threadId;
  return this.request("join_to_thread",{thread_id:n},t).then((e=>(0,H.getRelationFromApi)(e.chat_member)))}
leaveThread(e,t){let n=e.threadId;
  return this.request("leave_thread",{thread_id:n},t).then((e=>(0,H.getRelationFromApi)(e.chat_member)))}
```

Оба возвращают `{chat_member}`. Это **подписка** на тред, не создание (`app.js` @456811: экшены названы `subscribeToThread`/`leaveThread`, i18n-ключи `threads.error.subscription_was_failed`).

Пуш-события от сервера: `you_added_to_thread` / `you_removed_from_thread`, оба несут `data.thread_id` (`app.js` @750790, @752375).

### Смежное, полезное для v2

- В ответе `history` элемент чата-треда несёт **`ThreadParentMessage`** (`app.js` @936595):
  `threadParentMessage:e.ThreadParentMessage?Ae(e.ThreadParentMessage,!1):void 0` —
  то есть родительское сообщение приезжает **внутри** объекта треда, отдельный запрос не нужен.
  Фича-флаг `lazyThreadParentMessages` (эксперимент `web_lazy_thread_parent_messages_2`) может его отключать.
- Список тредов (`app.js` @432635) — подтверждает §2.4/§14.2 дословно:
  ```js
  _.bC.requestHistory({Threads:!0,Limit:0,ChatDataFilter:{},
    MessageDataFilter:{DropThreadParentMessage:r},MinTimestamp:e},{timeout:n})
  ```
  Гейт: фича-флаг `enableThreadsList`.
- Право `WRITE_TO_THREAD:"write_to_thread"` в наборе прав чата (`app.js` @596270) — родитель может запрещать треды.

---

## СПАЙК 3 — резолв join-ссылки: НАЙДЕНО

### Формат

```
https://yandex.ru/chat/#/join/<invite_hash>/<timestamp>
https://yandex.ru/chat/#/join/<invite_hash>/<parent_timestamp>/<thread_message_timestamp>
```

**Хвост ссылки — это НЕ `message_id` в смысле отдельного идентификатора. Это `Timestamp` сообщения**
(мкс, 16 цифр) — та же метка, что `ServerMessageInfo.Timestamp` и что уходит в `message_info {ChatId, Timestamp}`.
То есть `<message_id>` из формулировки задачи = `Timestamp`. Отдельного message-id в протоколе нет.

`<invite_hash>` — поле `invite_hash` чата (с провода: `ChatInfo.InviteHash`). Оно и есть тот самый
`InviteHash`, что фигурирует в params `history` / `message_info` / `get_chats_info`.

### Таблица маршрутов (`app.js` @616966, вербатим)

```js
const o="/chats",s=`${o}/:id/:timestamp?`,a="/c/:alias/:timestamp?";
const l="/join/:hash/:timestamp?",
      u="/join/:hash/:timestamp/:threadMessageTimestamp",
      d="/autoJoin/:autoJoinHash/:hash/:timestamp?",
      h="/autoJoin/:autoJoinHash/:hash/:timestamp/:threadMessageTimestamp",
      p="/staff/:nickname/:timestamp?",f="/user/:guid/:timestamp?",
      g="/link/:token",m="/stickers/:packId",v="/",y=v,b="/settings",_="/forward",E="/threads",
      A="/meeting",w="/planning",S="/conferences-history";
function T(e){return t=>{const n=[[s,e.chats],[f,e.user],[l,e.join],[u,e.join],[a,e.alias],
  [p,e.nickname],[d,e.autojoin],[h,e.autojoin],[g,e.link],[m,e.stickers]];
  for(const e of n){var o=(0,r.Z)(e,2);const n=o[0],s=o[1],a=(0,i.LX)(t,{path:n,exact:!0});
    if(a)return s(a.params)} return e.unknown()}}
```

### Билдер ссылки — самое ценное (`app.js` @835359, вербатим)

Именно эта функция породила ссылку, которую прислал пользователь:

```js
function O(e,t,n){let r=t.invite_hash,i=t.alias;
  const o=(0,g.J$)(e.chatId),          /* parseThreadId: сообщение лежит В ТРЕДЕ? */
        s=o?`/${e.timestamp}`:"",      /* 3-й сегмент = метка сообщения внутри треда */
        a=o?o.timestamp:e.timestamp,   /* 2-й сегмент = метка РОДИТЕЛЯ треда, иначе самого сообщения */
        c={invite_hash:r,alias:o?void 0:i};
  return `${(0,g.nc)(c,n)}/${a}${s}`}
```

Читается однозначно:
- сообщение в обычном чате → `…/join/<hash>/<message_ts>`;
- сообщение **внутри треда** → `…/join/<hash>/<thread_parent_ts>/<message_ts>`;
- у треда `alias` принудительно гасится (`alias:o?void 0:i`) — тред адресуется только через `invite_hash` родителя.

База (`nc` → `le`, модуль `40939` @811403):

```js
function le(e,t){const n=e.alias,r=e.invite_hash;
  return void 0!==n?`${ce()}#${(0,b.CX)(n)}`:r?`${ce()}#${(0,b.VB)(r)}`:""}
```

Сегменты (`app.js` @827534):

```js
const I=e=>`/join/${encodeURIComponent(e)}`,O=e=>`/chats/${encodeURIComponent(e)}`,
      R=e=>`/user/${encodeURIComponent(e)}`,k=e=>`/c/${encodeURIComponent(e)}`,
      P=e=>`/staff/${encodeURIComponent(e)}`;
/* экспорты: VB:()=>I (join), N9:()=>O (chats), VU:()=>R (user), CX:()=>k (alias), IG:()=>P */
```

Origin (`ce`, @810821): `messengerLinkOrigin` из конфига, иначе `location.origin`; базовый путь `/chat/`
(для Я.Team — `/`). Совпадает с `joinUrl:"https://messenger-test.yandex.ru/#/join/{hash}"` в дефолтах конфига (@62111).

⚠️ `invite_hash` проходит через `encodeURIComponent` — при разборе ссылки обязателен `decodeURIComponent`
(клиент так и делает: `hash:(0,Eo.sh)(e.hash)`).

### Резолв: `invite_hash` → `chat_id`

Обработчик join-роута (`ui.chunk.js` @186900):

```js
const $o=Bo((()=>{const e=(0,z.$B)().params,
  t=a.useMemo((()=>({hash:(0,Eo.sh)(e.hash),timestamp:zo.d(e.timestamp),
    threadMessageTimestamp:zo.d(e.threadMessageTimestamp),
    autoJoinHash:"autoJoinHash"in e?(0,Eo.sh)(e.autoJoinHash):void 0})),[e]),
  n=t.hash,o=t.timestamp,s=t.autoJoinHash,l=t.threadMessageTimestamp;
  /* autoJoin */
  ...
  /* useOpenThread: срабатывает ТОЛЬКО когда есть оба timestamp'а */
  Ko.q.addTask({params:{inviteHash:e},tag:"useOpenThread",stage:Zo.P.CHAT_ENTERED,
    callback(e){s((0,jo.E)({timestamp:n,threadData:{chatId:e,timestamp:t},hit:l}))}})
  ...
  return (0,bo.U)({loader:(0,i.EL)(Yo,n),
    selector:a.useCallback((e=>{var t;return null===(t=(0,Lt.T)(e,e.chatsMeta.inviteHashToChatId[n]))||void 0===t?void 0:t.chat_id}),[n]),
    timestamp:o,useMiddleware:qo})}));
function Yo(e){return(0,fo.rR)({inviteHash:e})}
function qo(e,t){return a.useEffect((()=>{e&&(0,ha.tN)({anchorTimestamp:t,chatId:e,redirect:!0,replace:!0,
  logParams:{source:"redirect_to_chat_id"}})}),[e,t]),!0}
```

Резолвер `rR` → `Gt` (`app.js` @468952):

```js
function Gt(e){return t=>{
  if((0,se.Z9)(e)&&(0,T.n2)(e.chatId)) return t(Vt(e.chatId));    /* уже thread_id → резолв треда */
  if((0,se.Z9)(e)){ if((0,T.sB)(e.chatId)) throw new te.g(e); return t((0,Be.WK)(e.chatId)) }
  return _.Z.getGroupChatInfo(e,{waitOnlineTokenProvider:()=>ie.tV.waitUntilReady()}).then((e=>{
    if((0,T.ZN)(e)) throw new te.g({chatId:e.chat_id});
    X.bQ.onChatResolved(), t($.a4(e))}))}}
```

`getGroupChatInfo` → HTTP `get_chats_info` (`app.js` @1073880):

```js
getGroupChatInfo(e,t,n){const r=le(e);
  return (0,l.$K)(r)? this.request("get_chats_info",
    Object.assign(Object.assign({},r),{supported_features:n}),
    Object.assign(Object.assign({},t),{enableCSRF:!1})).then(...)}
```

Билдер params (`app.js` @1068500) — **точная форма, три взаимоисключающих варианта**:

```js
function le(e){return (0,ie.Z9)(e)?{chat_ids:[e.chatId]}
                   :(0,ie.ve)(e)?{alias:e.alias}
                   :(0,ie.Qh)(e)?{invite_hash:e.inviteHash}
                   :void 0}
```

`enableCSRF:!1` — CSRF не нужен, согласуется с §17.4 («read-методы идут без CSRF»).

Обратная связь `invite_hash ⇄ chat_id` берётся **из самого объекта чата** (`app.js` @1353353):

```js
function c(e,t){ if(t.threadData) return;   /* треды свои invite_hash не регистрируют */
  ...
  t.invite_hash&&(e.inviteHashToChatId[t.invite_hash]=t.chat_id,
                  e.chatIdToInviteHash[t.chat_id]=t.invite_hash)}
```

а `invite_hash` попадает в объект чата из `ChatInfo.InviteHash` (`app.js` @936157):

```js
invite_hash:r.InviteHash, is_public:Boolean(r.IsPublic), ...
```

### Готовый алгоритм для `get_message(url)`

1. Взять hash-часть URL после `#`, `decodeURIComponent` каждого сегмента.
2. Сматчить по порядку (важен именно этот порядок — так делает `T`):
   - `/join/:hash/:timestamp/:threadMessageTimestamp`
   - `/join/:hash/:timestamp`
   - `/autoJoin/:autoJoinHash/:hash/:timestamp[/:threadMessageTimestamp]`
   - `/chats/:id/:timestamp?`, `/c/:alias/:timestamp?`, `/user/:guid/:timestamp?`, `/staff/:nickname/:timestamp?`
3. `chat_id` ← `get_chats_info {invite_hash}` → `data.chats[0].chat_id` (без CSRF).
4. Двухсегментная ссылка → `message_info {ChatId: chat_id, Timestamp: <timestamp>, InviteHash: <hash>}`.
5. Трёхсегментная → сообщение лежит в треде:
   `thread_id = buildThreadId({chatId: chat_id, timestamp: <timestamp>})`,
   затем `message_info {ChatId: thread_id, Timestamp: <threadMessageTimestamp>, InviteHash: <hash>}`.
6. `InviteHash` полезно тянуть дальше в `history`/`message_info` — это путь доступа для тех, кто в чате не состоит.

⚠️ Метки — 16-значные мкс. Клиент гонит их через `parseInt` (теряя точность в JS!), но инвариант v1
(string/BigInt) **строже и правильнее** — сохранить его, из бандла числовую семантику не копировать.

---

## Что осталось на живой захват

Из бандла всё нужное вытащено; ниже — то, что бандл принципиально не покажет:

1. **Материализация треда сервером** при первом `push({Plain:{ChatId:<thread_id>}})` — подтвердить, что
   `history` по `thread_id` после отправки перестаёт давать `ENTITY_NOT_FOUND` и что у родителя появляется
   `ThreadState`/`threadMessageCount`. (Мутация — только с санкции пользователя.)
2. **Префикс `2` (бизнес-чат)**: `parseInt(i,2)→NaN`. Проверить, действительно ли треды там недоступны,
   или это баг клиента, который сервер бы принял.
3. **Точная форма ответа `get_chats_info {invite_hash}`** — что в `data`, есть ли `chat_id` на верхнем уровне
   (§17.6 показал: дока по формам ответов регулярно врёт).
4. **`ENTITY_NOT_FOUND` на `history` несуществующего треда** — точный код/оболочка ошибки, чтобы MCP
   отличал «тред пуст» от «нет доступа» (`ACCESS_DENIED` обрабатывается отдельной веткой в `D`).
5. Спайки 2 (форматирование) и 4 (`list_reactions`) — не входили в задание.
   Попутно из бандла: `Text:{MessageText}` без entities (усиливает Round 3);
   `getUserReactions` → `{UserReactions, UserReads}` с params `{ChatId,Timestamp,InviteHash,Limit,MaxTimestamp,Mode}` (@1231402) — курсорная пагинация есть.

## Правки, которые нужно внести в research

- §Приложение: хеш бандла устарел → актуальный `0x421b6bd`, URL `https://yastatic.net/s3/chat-static/_/<hash>/web/app.js` + чанки (`ui`, `quick-access-panel`, `lang-ru` несут UI-логику, в `app.js` её нет).
- §10: `join_to_thread`/`leave_thread` — это **подписка**, не создание; возвращают `{chat_member}`.
- §10/§3.2: `get_chats_info` params — строго один из `{chat_ids:[...]}` / `{alias}` / `{invite_hash}` (+ опционально `supported_features`), `enableCSRF:false`.
- Новый раздел «Треды»: `thread_id` — производная строка от `ChatId`+`Timestamp` родителя, не серверная сущность; тред = чат; создания нет.
- Новый раздел «Ссылки»: таблица маршрутов и билдер `O` (двух- и трёхсегментный join).
