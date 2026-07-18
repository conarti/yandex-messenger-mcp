# Спайки 2 и 4 — живые вызовы (2026-07-17)

Снято собственным клиентом v1 (`/Users/macbook/Projects/yandex-messenger-mcp`, `dist/`) на залогиненном профиле.
Мутации — только в self-чате (`<myGuid>_<myGuid>`, подтверждён гейтом: `PrivateChatInfo` + `PartnerInfo.Guid === myGuid` + эхо `ChatId`).
Чужие чаты — **только чтение**, тела сообщений не запрашивались (`MessageDataFilter:{DropPayload:true}`).
Ниже — только структура: имена ключей, типы, длины. Живых значений нет.

**Живое наблюдение против доки: верить наблюдению.** Ниже три места, где §9.3/§14.3 врут.

---

## СПАЙК 2 — форматирование

### Ответ: entities НЕТ. Подтверждено живьём.

Послано в self-чат одним `push({Plain:{ChatId, PayloadId, Text:{MessageText}}})`, текст содержал:
`**bold** *italic* __underline__ ~~strike~~`, `` `inline code` ``, ```` ``` ````-блок, `>quote`,
`[link text](https://example.com/spike)`, голый URL.

Прочитано обратно через `history` и `message_info`.

### Что пришло обратно vs что послано

**Строка вернулась байт-в-байт той же, со всеми markdown-символами как есть.** Ни один символ
разметки не съеден, не преобразован, не вынесен в отдельное поле. Отправленное === полученное.

### Точная форма `Text`

```jsonc
"Plain": { "ChatId": string, "PayloadId": string, "Text": { "MessageText": string } }
```

- `Text` несёт **ровно один ключ** — `MessageText`. Всё.
- `Card` — **отсутствует** (не пустой, а именно нет ключа).
- Полей с `ranges`/`entities`/`spans`/`markup`/`format` **нет ни одного** — ни внутри `Text`,
  ни в `Plain`, ни среди сиблингов `ServerMessage`.
- Полный набор сиблингов `ServerMessage` у этого сообщения (после реакции):
  `ClientMessage, ServerMessageInfo, Reactions, ReactionsVersion, RecentUserReactions,
  ReadsCount, ReadsVersion, ShowReadsCount, SeenByPartnerMcs` — форматирования среди них нет.

### Вывод

**§11.1 в части `Text` верна, дока НЕ соврала.** Решение Round 3 (отдавать сырую строку)
подтверждено живьём: структуру выдумывать не из чего, парсить markdown client-side — по-прежнему
отклонено. README обязан честно сказать: форматирование = markdown внутри `MessageText`.

---

## СПАЙК 4 — `list_reactions` живьём

### 4.1 🚨 `Reaction.Type` — INT, а не emoji. §9.3 ВРЁТ.

Свип вариантов `push({Reaction:{...}})` по своему сообщению:

| вариант | результат |
|---|---|
| `Type: "👍"` (emoji-строка, как велит §9.3) | ❌ transport `BACKEND_CALL_ERROR(2)` |
| `Type: "👍", Action: 0` | ❌ `BACKEND_CALL_ERROR(2)` |
| `Type: "👍", Action: 2` | ❌ `BACKEND_CALL_ERROR(2)` |
| `Type: "1"` (строка-цифра) | ❌ `BACKEND_CALL_ERROR(2)` |
| **`Type: 1` (int)** | ✅ `Status:1` FULLY_COMMITTED |
| без `Type` | ❌ `Status:13` BAD_REQUEST, `Details:"Reaction Type is required for ADD/REPLACE actions"` |

`Type` на проводе — **целочисленный id реакции**. Любая строка отвергается прокси-слоем
(`BACKEND_CALL_ERROR` = невозможность распарсить, а не «бэкенд лёг»).
Снятие: `{ChatId, Timestamp, Type: 1, Action: 1}` → `Status:1` (проверено, реакция снята).

⚠️ **Открытый вопрос для v2:** таблицы `int → emoji` у нас НЕТ. Чтение реакций отдаёт `Type:1`,
а показать пользователю надо 👍. Маппинг живёт в веб-бандле (lookup-карта) — нужен отдельный
маленький спайк по бандлу. Это вопрос **отображения**, не доступности данных.

### 4.2 🚨 `{UserReactions, UserReads}` вместе НЕ приходят. `Mode` — дискриминатор. §14.3 ВРЁТ.

§14.3 обещает `list_reactions -> {UserReactions, UserReads}`. Живьём **один вызов отдаёт одно**:

| `Mode` | ключи ответа |
|---|---|
| отсутствует | `UserReactions, ReadsVersion` |
| `0` | `UserReactions, ReadsVersion` |
| **`1`** | **`UserReads, ReadsCount, ReadsVersion`** (реакций нет) |
| `2` | `UserReactions, ReadsVersion` |
| `3` | ❌ `BACKEND_CALL_ERROR(2)` |

**`Mode:1` = режим прочтений.** Без него `UserReads` не придёт никогда — именно поэтому
первые прогоны его «не видели». Для v2: **два вызова на сообщение**, если нужны и реакции, и прочтения.

### 4.3 Точная форма ответа (структура, без значений)

`list_reactions` (реакции, `Mode` отсутствует/`0`/`2`):
```jsonc
{
  "UserReactions": [ { "Type": int,           // id реакции
                       "Timestamp": int,      // 16 цифр, мкс - ВРЕМЯ ПОСТАНОВКИ РЕАКЦИИ
                       "UserInfo": { "Guid": string, "DisplayName": string, "PublicName"?: string,
                                     "AvatarId": string, "Version": int,
                                     "Uid"?: int, "Nickname"?: string, "PhoneId"?: string,
                                     "AccountCategory"?: int } } ],
  "ReadsVersion": int
}
```

`list_reactions` (прочтения, `Mode:1`):
```jsonc
{
  "UserReads": [ { "Timestamp": int,          // 16 цифр, мкс - ВРЕМЯ ПРОЧТЕНИЯ
                   "UserInfo": { /* та же форма UserInfo */ } } ],
  "ReadsCount": int,
  "ReadsVersion": int
}
```

- **Время постановки реакции конкретным пользователем — ЕСТЬ** (`UserReactions[].Timestamp`,
  16 цифр мкс, отличается от метки сообщения).
- **Кто прочитал и во сколько — ЕСТЬ** (`UserReads[].Timestamp` + полный `UserInfo` с именем).
  Проверено на 3 чатах (2 групповых, 1 приватный): прочитавший ≠ я, метка прочтения > метки сообщения.
- `UserInfo` неоднороден: `Uid`/`Nickname` наблюдались в self-чате, `PhoneId`/`AccountCategory`/
  `PublicName` — в чужих. Читать как опциональные.

### 4.4 Сиблингов history НЕ хватает — `list_reactions` обязателен

Сравнение на живых сообщениях (`Limit:30`, 13 чатов):

| | `ReadsCount` | `RecentUserReads` | `UserReads` (`Mode:1`) |
|---|---|---|---|
| групповое сообщение | 10 | **3** | **10** |

**`RecentUserReads` обрезан** (3 из 10) — имя «Recent» не врёт. Полный список прочтений даёт
**только** `list_reactions Mode:1`.

По реакциям: `RecentUserReactions` совпал с `UserReactions` на всех наблюдениях, но там были
счётчики 1–2 — потолок обрезки не проявился. **Считать `RecentUserReactions` тоже обрезанным**
(по симметрии с `RecentUserReads`, где обрезка доказана); для полного списка — `list_reactions`.

Сиблинги, наблюдавшиеся живьём на `ServerMessage`:
`Reactions[{Type:int, Count:int}]`, `ReactionsVersion`, `RecentUserReactions[{Type,Timestamp,UserInfo}]`,
`ReadsCount`, `ReadsVersion`, `ShowReadsCount:bool`, `RecentUserReads[{Timestamp,UserInfo}]`,
`SeenByPartnerMcs` (только приватные чаты).
Появляются **только когда есть что показать**: у сообщения без реакций/прочтений этих ключей нет вовсе.

### 4.5 `message_info` — форма (будущий `get_message`)

```jsonc
{ "Message": { "ServerMessage": { "ClientMessage", "ServerMessageInfo", /* + сиблинги как в history */ },
               "Meta": { "Origin": int } },
  "ErrorInfo": {},          // не в §14.3
  "MyReactions": [ int ],   // ОТСУТСТВУЕТ, если своей реакции нет (не пустой массив - нет ключа)
  "ChatInfo": {} }          // не в §14.3
```

- §14.3 обещает `{Message, MyReactions}` — живьём приходят ещё `ErrorInfo` и `ChatInfo` (оба пустые объекты).
- `MyReactions` — **массив int** (тех же id, что `Reaction.Type`). До реакции — ключа нет; после
  постановки — `[1]`; после снятия — ключ снова исчез.
- `Message.ServerMessage` несёт **те же сиблинги**, что `history`, то есть `message_info` = полноценный
  источник для `get_message` без загрузки истории. Параметры `{ChatId, Timestamp}` достаточны
  (`InviteHash` не потребовался).

### 4.6 Побочная находка: `DropPayload:true` срезает и `From`

Контроль на self-чате (одно и то же сообщение):

| | ключи `ServerMessageInfo` |
|---|---|
| без фильтра | `Timestamp, PrevTimestamp, SeqNo, Version, From` |
| `MessageDataFilter:{DropPayload:true}` | `Timestamp, PrevTimestamp, SeqNo, Version` — **`From` НЕТ** |

То есть `DropPayload` роняет не только тело, но и **авторство**. Reads/reactions-сиблинги при этом
переживают фильтр. Для v2: нельзя определять автора под `DropPayload` — молча получишь «ничьё» сообщение.
(Ловушка реальна: на ней сломался промежуточный прогон этого же спайка.)

---

## Прямой ответ на вопрос выполнимости

**Пункт «реакции с временем конкретного пользователя + кто прочитал и когда» — ВЫПОЛНИМ ПОЛНОСТЬЮ.**

Данные на проводе есть все:
- реакция + кто поставил + **когда поставил** → `list_reactions` (`Mode` по умолчанию);
- **кто прочитал + когда прочитал** + имя → `list_reactions` `Mode:1`;
- своя реакция → `message_info.MyReactions`.

Цена, которую надо заложить в реализацию (ничего из этого не блокирует):
1. **Два вызова `list_reactions` на сообщение** (реакции и прочтения раздельно, `Mode:1`) —
   сиблинги history неполны (обрезка доказана: 3 из 10).
2. **`Type` — int**, и таблицы `int → emoji` у нас нет. Реакции читаются, но отрисовать их
   как emoji без маппинга из бандла нельзя. Нужен мини-спайк по бандлу — **вопрос отображения,
   а не доступности**; выполнимость пункта он не отменяет.
3. Прочтения приходят не у каждого сообщения — только там, где сервер их считает
   (`ShowReadsCount`/`ReadsCount`). Отсутствие `UserReads` = «не отслеживается», а не «никто не читал»;
   врать пользователю нулём нельзя.

## Поправки, которые надо внести в `yandex-messenger-api-research.md`

1. **§9.3**: `Reaction.Type` — **int**, не emoji. Строка отвергается (`BACKEND_CALL_ERROR`).
   Без `Type` → BAD_REQUEST «Reaction Type is required for ADD/REPLACE actions».
2. **§14.3**: `list_reactions` **не отдаёт `{UserReactions, UserReads}` вместе**. `Mode` — дискриминатор:
   default/`0`/`2` → `UserReactions`; **`1` → `UserReads`+`ReadsCount`**; `3` → ошибка.
3. **§14.3**: `message_info` → `{Message, ErrorInfo, MyReactions?, ChatInfo}`; `MyReactions` — массив int,
   ключ отсутствует при отсутствии своей реакции.
4. **§14.2**: `MessageDataFilter:{DropPayload:true}` срезает также `ServerMessageInfo.From`.
5. **§11.2**: `RecentUserReads` обрезан (наблюдалось 3 при `ReadsCount:10`) — не источник полного списка.

## Что осталось в мессенджере после спайка

- Тестовое сообщение с markdown в **self-чате** — оставлено (личный чат; удаление — фича v2,
  не проверялась, лишних мутаций не делал).
- Реакция, поставленная на него, — **снята** (`Action:1`, `Status:1`; `UserReactions` и `MyReactions`
  после снятия отсутствуют).
- Чужие чаты не изменялись — ни одной мутации, тела чужих сообщений не запрашивались.
- Временные скрипты и сырые дампы удалены.
