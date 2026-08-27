# Спайк #22 - сырой кадр пересылки (2026-08-28)

Снято собственным клиентом (`dist/`, скрипт [`capture-forward-frame.mjs`](capture-forward-frame.mjs)) на
залогиненном профиле. Cookie-сессия поднята штатным путём проекта (`PlaywrightProfile` ->
`CookieAuthProvider`), браузер не запускался.

**Чтение узкое и только чтение.** Один чат, окно `MinTimestamp = метка-1`, `MaxTimestamp = метка+1`,
`Limit:1` - то есть ровно одно сообщение; плюс один `message_info` по той же метке. Ни одной записи.

**Содержимого здесь нет.** Ниже только структура: имена ключей, типы, длины строк, булевы значения и
результаты сравнений («равно/не равно»). Сырой дамп остался вне репозитория и не коммитится.

## Специмен

Пересланное сообщение, метка `1787305219882056` (2026-08-21T09:40:19.882Z), приватный чат.
Наружу оно выходило пустым: `kind:'unknown'`, без `text`, `forwarded:[]`, `context` отсутствует -
то есть неотличимо от удалённого. Это и есть баг #22, воспроизведён до правки.

## Ответы на три вопроса шага 5

### 1. Приходит ли сиблинг `ForwardedMessages` - **ДА. Наблюдено живьём.**

Он лежит ровно там, где его ждёт `enrichMessage`: третьим ключом уровня `ServerMessage`, рядом с
`ClientMessage` и `ServerMessageInfo`.

```
[history ServerMessage keys]      ClientMessage, ServerMessageInfo, ForwardedMessages
[message_info ServerMessage keys] ClientMessage, ServerMessageInfo, ForwardedMessages
```

`history` и `message_info` отдают ОДНУ И ТУ ЖЕ форму - оба пути обогащения питаются одинаково.

### 2. Какая у элементов обёртка - **`{Payload, ServerMessageInfo}`. Ни одна из двух гипотез не подтвердилась.**

```
ForwardedMessages: array(2) [
  {
    Payload: {                          <- ЭТО ТЕЛО, а не ClientMessage и не ServerMessage
      Text: { MessageText: string },
      ChatId: string(len=73),
      CustomPayload: string(len=392),
      PayloadId: string(len=27)
    },
    ServerMessageInfo: {
      Timestamp: int, PrevTimestamp: int, SeqNo: int, Version: int,
      From: { Guid, DisplayName, AvatarId, PhoneId, Version }
    }
  },
  ... второй элемент той же формы
]
```

`Payload` - это содержимое `ClientMessage.Plain`, поднятое на уровень элемента: ключ `Plain` в цепочке
отсутствует, `ClientMessage` отсутствует тоже. `buildForwarded` пробовал две обёртки - сам элемент как
`ServerMessage` и вложенный `element.ServerMessage` - **обе мимо**. Отсюда и пустой `forwarded[]`:
`normalizeMessage` требует `{ClientMessage, ServerMessageInfo}`, не находил `ClientMessage`, возвращал
`undefined`, и элемент молча отбрасывался. Это причина бага, а не следствие.

Сверки по этому же кадру:

- `Payload.ChatId !== ChatId несущего сообщения` - в `Payload` лежит адрес **исходного** чата, значит
  `source_chat` выводится из данных, а не додумывается;
- `ServerMessageInfo.Timestamp` элемента - 16-значная метка, отличная от метки несущего сообщения:
  адрес оригинала полный, `get_message` по паре `(Payload.ChatId, Timestamp)` адресуем;
- `From.Guid` элемента совпал с автором несущего сообщения - частный факт этого специмена
  (человек переслал сам себя), не свойство формы;
- элементов **два**, и оба одной формы - блок «две пересылки сразу» приходит массивом, а не склейкой.

### 3. Есть ли `ForwardedMessageRefs` в теле - **НЕТ. Наблюдено живьём.**

Тело несущего сообщения:

```
ClientMessage.Plain keys: ChatId, CustomPayload, PayloadId
```

Ни `ForwardedMessageRefs`, ни `ForwardedMessageStyles` во всём кадре нет (проверено поиском по всей
сериализации, не только по телу). Отсюда два следствия:

- `context` у пересылки не строится вовсе - `buildContext` возвращает `undefined` при пустых refs и
  quotes. Прежнее наблюдение `README.md` («`context.refs` пуст даже у reply») **подтверждается** и на
  пересылке;
- content-поля в теле нет ни одного, поэтому `resolveBody` отдаёт `kind:'unknown'`. Это штатный вид
  ЧИСТОЙ ПЕРЕСЫЛКИ (без своего комментария), а не признак поломки.

### 4. Контрольная проверка: `Deleted` не выставлен

`ServerMessageInfo` элемента и несущего сообщения ключа `Deleted` не содержат вовсе; строки `Deleted`
в кадре нет. Значит `kind:'unknown'` пришёл из `resolveBody`, а не из перекрытия флагом, и правка
расщепления `kind` этот кадр не затрагивает.

Дополнительно: у элемента `Messages[]` есть сиблинг `Meta: { Origin: int }` (наблюдённое значение -
одно число). Что означает `Origin`, кадр не говорит; в разбор он не берётся.

## Какая ступень лестницы применена

**Ступень 1: оригиналы пришли.** `forwarded[]` наполняется текстом и вложениями из `Payload` - тем же
v1-нормализатором, которому элемент приводится к форме `{ClientMessage:{Plain:Payload}, ServerMessageInfo}`.

Ступень 2 (`context.refs` с адресом оригинала) **не применяется**: рефов в кадре нет, придумывать
нечего. Ступень 3 (не пришло ничего) опровергнута этим же кадром.

## Разметка доверия

| Утверждение | Статус |
|---|---|
| `ForwardedMessages` - сиблинг уровня `ServerMessage`, есть и в `history`, и в `message_info` | наблюдено живьём |
| Обёртка элемента - `{Payload, ServerMessageInfo}`, `Payload` есть тело | наблюдено живьём |
| `Payload` несёт `Text.MessageText`, `ChatId` исходного чата, `PayloadId`, `CustomPayload` | наблюдено живьём |
| Блок из нескольких пересылок приходит массивом элементов той же формы | наблюдено живьём (два элемента) |
| `ForwardedMessageRefs`/`ForwardedMessageStyles` у пересылки не приходят | наблюдено живьём |
| Тело чистой пересылки не несёт content-поля, отсюда `kind:'unknown'` | наблюдено живьём |
| Пересылка **с вложением** несёт `Payload.Image`/`Payload.MiscFile` тем же местом, что обычное тело | **выведено** - кадр показал только текстовые оригиналы |
| Обёртки `element.ServerMessage` и «элемент = `ServerMessage`» где-либо встречаются | **выведено** - ни разу не наблюдались, оставлены запасным разбором |
| Что означает `Meta.Origin` | не установлено |
