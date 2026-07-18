# Work Plan: Yandex Messenger MCP v2 (paritet chteniya i mutaciy)

Status: CONSENSUS APPROVED (Architect APPROVE + Critic APPROVE, итерация 1, 2026-07-17); исполнение авторизовано пользователем (ralph)
Mode: RALPLAN-DR DELIBERATE (в scope необратимые мутации, отправка вложений, auth-UX)
Source spec: `.omc/specs/deep-interview-yandex-messenger-mcp-v2.md` (ambiguity 18%, ниже порога 0.2)
Предшественник: `.omc/plans/ralplan-yandex-messenger-mcp.md` (v1, в проде)
Protocol source of truth: `yandex-messenger-api-research.md`, §17 (живые поправки) приоритетнее старых разделов; ключевое для v2 - §17.10-17.14
Spike source of truth v2: `.omc/spikes/yandex-mcp/v2/` (SPIKE-1-3-BUNDLE.md, SPIKE-2-4-LIVE.md, SPIKE-5-REACTION-MAP.md, reaction-map.json, threadid-derivation.mjs) - все 5 закрыты живьём 2026-07-17
Target: существующий репозиторий `/Users/macbook/Projects/yandex-messenger-mcp` (v1: 5 инструментов, 346 тестов, build/typecheck 0)

> Это ДЕЛЬТА поверх v1. Пакетная структура и транспорт v1 (WS handshake, frame codec, auth cookie, backoff, download) не переписываются, а расширяются. Ниже показано, какие модули добавляются и меняются, а не весь репозиторий.

---

## Requirements Summary

Довести MCP до рабочего паритета с веб-интерфейсом по чтению и мутациям. Три оси:

1. **Обогащение чтения (перестать терять данные).** Ключевой вывод разведки: ~10 из 11 запрошенных пунктов УЖЕ приходят по проводу, v1 их выбрасывает в `src/protocol/messageShape.ts`. Это не реверс нового API, а прекращение потери. Сообщение должно приезжать с реакциями, прочтениями (кто и когда), связями (reply/forward/thread), оригиналом пересылки, именами упоминаний. Единственное, чего в протоколе НЕТ - структурированные entities: отдаём сырой `MessageText` (спайк 2 подтвердил байт-в-байт).

2. **Адресация и фильтры.** `get_message` по ChatId+Timestamp (через `message_info`) и по join-ссылке (§17.11: хвост = Timestamp, hash = invite_hash, резолв через `get_chats_info {invite_hash}` без CSRF); `get_message_context` (окно до/после метки); треды как чаты с полным паритетом веба, включая создание («Обсудить» = строковая деривация `thread_id`, §17.10, реверса не требует); `get_history` с фильтрами `from_date`/`to_date`/`after` (ISO → `MinTimestamp`/`MaxTimestamp`, верхняя граница исключающая).

3. **Симметрия чтения и письма.** На всё, что MCP умеет прочитать, он должен уметь ответить тем же способом, что человек в вебе. Реверсибельные мутации (один вызов, без confirm): `set_reaction`, `mark_read`, `pin_message`. Необратимые (draft→confirm): `delete_message`, `edit_message`, отправка вложений (`send_file` + картинка), `vote_in_poll`. Плюс чтение опросов и адресация self-чата («Избранное») по имени.

**И честность доказательств.** Долги, которые сейчас держатся на фикстурах или реконструкции (voice/gallery-вложения при чтении, форма push-ответа кроме `Status`, единица `rate_limit.wait_for`, ресайз превью `?size=`), закрываются живым прогоном, а не остаются в README как хвост. Не закрылся живьём - остаётся в README дословно с указанием, что пробовали.

**Инструменты v2 (дельта к пяти v1).** Сохраняются: `list_chats`, `get_history` (расширяется датами), `search`, `send_message`, `download_attachment` (расширяется voice/gallery + `?size=`). Добавляются: `get_message`, `get_message_context`, `get_thread`, `set_reaction`, `mark_read`, `pin_message`, `delete_message`, `edit_message`, `send_file`, `vote_in_poll`. Реакции и прочтения выставляются в обогащённой выдаче `get_history`/`get_message`; отдельная детальная выборка - через внутренний путь `list_reactions` (2 вызова на сообщение).

**Всё одним релизом** (решение Round 4), не разбивать на волны.

---

## RALPLAN-DR (Deliberate)

### Principles

1. **Перестать терять данные, а не реверсить новый API.** Разведка доказала: почти всё запрошенное уже на проводе, теряется в нормализаторе v1. Основная работа v2 - в `messageShape.ts` и новых read-путях (`message_info`, `list_reactions`), а не в транспорте. Транспорт v1 для мутаций уже корректен: `buildPushParams` в `src/protocol/push.ts` заворачивает мутацию в полный конверт `ClientMessage`, а `MessengerWsClient.request` для метода `push` не ретраит и не применяет маппинг слоя 2. Форматирование - сырая строка, entities не выдумывать.

2. **Наблюдение важнее доки, и это заострено для v2.** Формы `Vote`, `Pin`, `SeenMarker`/`UnseenMarker`/`ReadMarker` и правки (`convertMessageToPlain` с `Timestamp`) взяты ТОЛЬКО из доки и живьём не наблюдались, а дока по этому протоколу ошибалась многократно (§17: `Type:"👍"`, `Mode`-дискриминатор, шаблон `fileDownloadUrl`, `Limit` в `list_reactions`, обрезка `RecentUserReads`). Поэтому доко-выведенная форма мутации подтверждается живым прогоном ДО того, как на ней строится Acceptance Criteria. Долг доказательств закрывается прогоном, а не рассуждением.

3. **Живые мутации - ТОЛЬКО в self-чате («Избранное»).** Жёсткое ограничение. Гейт self-чата известен (спайк 4/5): `ChatId === <guid>_<guid>` + `PrivateChatInfo` + `PartnerInfo.Guid === myGuid` + эхо `ChatId`. Ни один живой прогон не пишет в чужой чат или группу. Чтение чужих чатов - без запроса тел (`MessageDataFilter.DropPayload:true`), но помня ловушку §17.13 (под этим фильтром пропадает и `From`).

4. **Confirm - только у необратимых.** Критерий один: откатывается ли последствие тем же инструментом за один вызов. С confirm (draft→confirm): `send_message`, `delete_message`, отправка вложений, `edit_message` (перезаписывает текст), `vote_in_poll` (снятие голоса в протоколе не обнаружено). Без confirm (один вызов): `set_reaction` (`Action:REMOVE=1` откатывает), `pin_message` (легко снять), `mark_read` (безобидна). Дешёвый confirm обесценивает дорогой: раздача confirm обратимым обучает жать его не глядя, и тогда его прожмут на `delete_message`.

5. **Инварианты v1 сохранить, релиз один.** stdout под MCP stdio (логи в stderr), редакция секретов и текста в логах, никаких живых uid/guid/cookie в репо, синтетические фикстуры, курсоры и метки string/BigInt (не float), `MaxTimestamp` исключающая граница. Аддитивность обеспечивается СТРУКТУРНО, а не дисциплиной: выход `normalizeMessage` (v1) не мутируется, обогащение приезжает отдельной функцией `enrichMessage(base, {...})`, которая возвращает base плюс НОВЫЕ top-level ключи (Fork D). Неизменяемый golden-тест пинит: точный v1-объект на фиксированной фикстуре - структурное подмножество v2-выхода. Весь набор v1 (346 тестов) остаётся зелёным как AC каждой фазы, без правки ассертов.

### Decision Drivers (top 3)

1. **Доко-выведенные формы мутаций - главный риск проекта.** Дока систематически врёт, а v2 впервые строит на ней НЕОБРАТИМЫЕ действия (`edit`, `delete`, `vote`) и действия, видимые всем участникам чата (`set_reaction`, `pin`). Ошибка в форме `ReadMarker`/`Pin`/`Vote` либо тихо не сработает, либо сделает не то. Отсюда выделенная Phase 0 - живая верификация форм в self-чате как ворота перед построением инструментов.

2. **Данные уже на проводе → центр тяжести в нормализаторе, транспорт почти не трогаем.** Это дешевит обогащение и удешевляет риск: обогащение приезжает НОВОЙ функцией `enrichMessage` поверх немутируемого выхода `normalizeMessage` (Fork D), транспорт (WS, frame codec, envelope мутаций) переиспользуется как есть. Значит основной источник регрессии - форма выдачи - закрывается структурно (v1-объект остаётся подмножеством v2), а не обещанием «не трогать».

3. **Необратимость + чужие чаты.** Сообщение/правка/голос уходят живому собеседнику; реакция и пин видны всем. Confirm для необратимых, валидация реакции по карте ДО отправки (сервер не защитит - `999999` принимается), живые прогоны только в self-чате, а правку/удаление чужого отклоняет сервер (своё ограничение не изобретаем, ошибку маппим внятно).

### Viable Options

#### Fork (A): как верифицировать доко-выведенные формы мутаций

- **A1 (выбран): выделенная Phase 0 - живой wire-probe форм в self-чате ДО построения инструментов.** Прогнать в «Избранном» реальные `push` с формами `edit`/`delete`/`pin`/read-marker/`vote`/`reaction` и `list_reactions` (с `Limit`, `Mode:1`), снять фактические ключи ответа, зафиксировать в фикстуры и в §17. Инструменты (Phase 5-6) строятся только на подтверждённых формах; неподтверждённая форма → инструмент не выпускается, долг в README дословно.
  - Pros: необратимые мутации строятся на факте, а не на доке, которая уже врала; формы попадают в регресс-фикстуры; закрытие долгов встроено в тот же прогон.
  - Cons: Phase 0 требует живого self-аккаунта до старта основной реализации; часть форм в self-чате проверить НЕЛЬЗЯ. В частности форма голоса `Vote.Choices` не поддаётся живой проверке отправкой: создание опроса - Non-Goal, значит опроса в «Избранном» может не быть. Следствие (см. Fork A1-poll ниже): читать опрос можно против любого реального опроса в любом чате (read разрешён везде), но живой ГОЛОС в self-чате недостижим - поэтому `vote_in_poll` выпускается как experimental на неподтверждённой форме, а AC-29 НЕ засчитывается без живого `myChoices`; это честный долг, а не выдумка и не тихое снижение планки.
- **A2 (инвалидирован): строить инструменты по доке, чинить по багрепортам.**
  - Invalidation rationale: дока по этому протоколу опровергнута живьём минимум пятью пунктами (§17.12/§17.9/§17.7 и др.). Строить необратимый `delete_message`/`edit_message` на непроверенной форме - это гарантированный релиз с багом на пути, где баг стоит дорого (правка перезаписывает текст, удаление необратимо). Отклонён.

#### Fork (B): инфраструктура confirm-токена для необратимых мутаций

- **B1 (выбран): вынести паттерн `DraftToken` из `src/mcp/tools/sendMessage.ts` в общий модуль `src/mcp/confirm.ts`, обобщив «хэш текста» до «отпечатка полезной нагрузки» (fingerprint), С ДИСКРИМИНАТОРОМ ОПЕРАЦИИ.** Схема токена: `{op, chat_id, fingerprint, payload_id?}`, где `op` - имя операции (`send_message`/`delete_message`/`edit_message`/`send_file`/`vote_in_poll`). fingerprint домен-сепарирован префиксом `op` (`hash(op + ":" + payload)`), чтобы токен одной операции не проходил как отпечаток другой. На confirm инструмент сверяет `token.op` со своим именем (несовпадение = `ConfirmRejectedError('op_mismatch')`), ре-резолвит чат и пересчитывает fingerprint; любое расхождение = отказ. Отпечатки по операциям: `send_message` = хэш текста; `delete_message` = ChatId+Timestamp цели; `edit_message` = ChatId+Timestamp+хэш нового текста; `send_file` = ChatId+хэш содержимого/метаданных файла; `vote_in_poll` = ChatId+Timestamp+choices. Плюс общий `rememberSend` (израсходованный токен отдаёт запомненный результат).
  - Идемпотентность разведена по путям: **send-путь** (`send_message`, `send_file`) несёт `payload_id`, и серверная дедупликация `DUPLICATE(8)` для него ДОКАЗАНА (§14.4, push.ts). **target-путь** (`delete`/`edit`/`vote`) целится в существующее по `Timestamp`, и серверный `DUPLICATE(8)` на его повторе НЕ доказан - для него опираемся на естественную идемпотентность по target-Timestamp (повторное удаление уже удалённого, повторная правка тем же текстом) + локальную память `sentByToken`; серверный дедуп НЕ обещаем, пока Phase 0 (replay-проба) не покажет обратное фактом.
  - Pros: одна проверенная реализация ре-верификации на всём необратимом пути; `op` закрывает кросс-op replay; сохраняет отлаженный `ConfirmRejectedError`; идемпотентность честно разделена по путям.
  - Cons: обобщение требует аккуратной абстракции fingerprint (у delete нет текста, у vote - массив choices); риск сделать её слишком общей.
- **B2 (инвалидирован): дублировать паттерн `sendMessage` в каждом инструменте.**
  - Invalidation rationale: пять копий логики идемпотентности и ре-верификации на НЕОБРАТИМОМ пути - пять мест для расхождения. Один пропущенный ре-резолв в копии = отправка не в тот чат. Отклонён.

#### Fork (C): реакция int → эмодзи (данные vs код)

- **C1 (выбран): `reaction-map.json` как ДАННЫЕ в репо + lookup-с-фолбэком в `src/protocol/reactions.ts`.** Карта портируется из `.omc/spikes/yandex-mcp/v2/reaction-map.json` (52 записи) в `src/config/reaction-map.json`; модуль делает lookup. На чтение: `type` отдаётся ВСЕГДА, известный → `{type, name, emoji, count}`, неизвестный → `{type, name:null, emoji:null, unknown:true}`, без `chr(type)`, без молчаливого проглатывания (`Count` обязан сходиться). На запись (`set_reaction`): валидация по карте ДО отправки. Карта перегенерируется свипом по `/reactions/{type}/small` (301 vs 404 + имя из `Location`) - процедура воспроизводима, бандл не нужен.
  - Pros: пространство типов открыто (сервер принял `999999`), карта не может быть полной - lookup-с-фолбэком единственно корректен; данные отделены от кода и обновляемы без правок логики; спайк 5 прямо это предписывает.
  - Cons: колонка `emoji` - аппроксимация артворка (33 записи уровня ASSET кликом не подтверждены); нельзя выдавать её за «эмодзи от Яндекса» - авторитетны `name` и `type`.
- **C2 (инвалидирован): хардкод `switch(type)` int→emoji в коде.**
  - Invalidation rationale: `switch`, который бросает на неизвестном, ронял бы `get_message` из-за одной чужой реакции; `switch`, который молчит, терял бы данные и ломал бы сходимость `Count`. Неизвестный тип - штатный сценарий (доказано `999999`), а не баг. Отклонён.

#### Fork (D): как гарантировать аддитивность обогащения к v1-выдаче

- **D1 (выбран): отдельная функция `enrichMessage`, выход `normalizeMessage` не мутируется.** `normalizeMessage` (v1) возвращает тот же объект, что и раньше, байт-в-байт; обогащение делает НОВАЯ `enrichMessage(base, {myGuid, reactionMap, siblings})`, добавляя НОВЫЕ top-level ключи (`reactions`, `reads`, `mentions`, `forwarded`, `thread`) поверх base. Оригинал пересылки маршрутизируется в новый ключ `forwarded`, а НЕ в существующий `context.refs[]` (это явный запрет: `context.refs`/`quotes`/`is_reply` остаются ровно v1-формой). Неизменяемый golden-тест: точный v1-объект на фиксированной фикстуре = структурное подмножество v2-выхода.
  - Pros: v1-регрессия (346 тестов, `toEqual` на `context.refs`/`from`/`attachments`) держится структурно, а не правкой ассертов; «346 зелёных» честны; форма v1 не меняется тихо.
  - Cons: два прохода (normalize → enrich) и новый уровень ключей в выдаче; потребитель читает обогащение из top-level, а не из `context`.
- **D2 (инвалидирован): дописывать поля прямо в объект `normalizeMessage` (обогащать на месте).**
  - Invalidation rationale: обогащение пересылки естественно легло бы в `context.refs[]`, а на него завязаны `toEqual` v1-тестов (`messageShape.test.ts:191,214`), плюс `from`/`attachments`. «346 зелёных» тогда сохранились бы ТОЛЬКО правкой ассертов - это тихая смена v1-формы под видом регрессии-без-изменений. Отклонён.

**Форк, разрешённый разведкой без развилки (создание треда).** Альтернатива «реверсить серверное создание треда» инвалидирована фактом: серверного создания НЕТ (§17.10, спайк 1). «Обсудить» - чистая строковая деривация `thread_id` без сети (`100+parseInt(prefix,10)`), тред = чат, материализуется первым `push`. Реверс не требуется - осталась одна опция (деривация), альтернатива снята фактом, а не выбором.

### Pre-mortem: сценарии провала

1. **[ОБЯЗАТЕЛЬНЫЙ] Доко-выведенная форма мутации оказалась неверна на проводе.** Выбрали не тот из трёх маркеров (`SeenMarker`/`UnseenMarker`/`ReadMarker`) - `mark_read` тихо ничего не отмечает либо отмечает не тем способом; пустой `Pin.Timestamp` не открепляет, а даёт `BAD_REQUEST`; `Vote.Choices` не в тех единицах/обязательности - голос не засчитывается. Корень: строили AC на «как написано в доке», а дока врёт. Профилактика: **Phase 0 - ворота**. Формы, проверяемые в self-чате (read-marker: какой обнуляет `LastSeqNo - LastSeenByMeSeqNo` §17.9; `Pin.Timestamp` пустой = открепить; правка `convertMessageToPlain`+`Timestamp`), подтверждаются живым прогоном ДО построения AC; неподтверждённая → инструмент не выпускается, долг в README дословно, фикстуры с реального ответа. **Исключение с явным разграничением - голос:** форму `Vote.Choices` в self-чате отправкой проверить нельзя (опроса в «Избранном» может не быть, создание - Non-Goal). Поэтому `vote_in_poll` НЕ гейтится по «инструмент не выпускается», а выпускается как experimental на доко-форме, и его AC-29 НЕ засчитывается без живого `myChoices` (см. Fork A1-poll, Phase 6, CRITICAL). Это не обход ворот, а честная маркировка: чтение опроса (AC-28) проверяемо против любого реального опроса, живой голос (AC-29) - условный долг.

2. **`set_reaction` пишет мусорный `type` в чат, и его видят все.** Сервер `Type` НЕ валидирует (`999999` → `Status:1`, читается дословно); официальный веб на неизвестном типе рисует битую картинку - фолбэка нет даже у Яндекса. Корень: положились на серверную валидацию, которой нет; либо послали плоский `push({Reaction:{...}})` вместо полного конверта. Профилактика: валидация `type` по `reaction-map.json` ДО отправки (тип вне карты отвергается клиентом; `999999` и `1` не уходят на провод); `Reaction` уходит полным конвертом `ClientMessage` через `buildPushParams` (плоский push даёт ложный `NO_SUCH_CHAT` - легко принять за неверный ChatId); регресс-тест на форму запроса; живые прогоны только в self-чате.

3. **Необратимая мутация уходит не туда / дублируется** (`edit`/`delete`/`vote`/вложение), или confirm-токен одной операции проходит как другой (кросс-op replay). Корень: draft→confirm не привязан к ре-резолвнутому чату/цели/операции, или fingerprint посчитан не заново, или ретрай на пути push, или обобщённый токен без дискриминатора `op`. Профилактика: общий `confirm.ts` (Fork B1) с полем `op` (сверка `token.op` с именем инструмента на confirm) и домен-сепарированным fingerprint; ре-резолв и повторный расчёт fingerprint, расхождение = отказ; push НИКОГДА не ретраится (уже так в `MessengerWsClient`); правку/удаление чужого отклоняет сервер, ошибку маппим внятно; живьём только self-чат; под `DropPayload:true` не определять авторство (§17.13). **Идемпотентность честно по путям:** для `send_message`/`send_file` серверный `DUPLICATE(8)` по `payload_id` доказан (§14.4) и используется; для `delete`/`edit`/`vote` серверный дедуп НЕ обещаем - опора на естественную идемпотентность по target-`Timestamp` + локальную `sentByToken`, а Phase 0 (replay-проба: дважды submit edit/delete/vote в self-чате) фиксирует фактом, даёт ли сервер `DUPLICATE(8)` или переприменяет; серверный дедуп заявляется ТОЛЬКО где наблюдён.

4. **Обогащение роняет `get_message` из-за одной реакции либо ломает v1-регрессию.** Неизвестный тип реакции бросает исключение в нормализаторе; или обогащение легло в существующий `context.refs[]`/`from`/`attachments`, на которые завязаны `toEqual` v1-тестов (`messageShape.test.ts:191,214`), и «346 зелёных» сохранились правкой ассертов = тихая смена v1-формы. Профилактика: lookup-с-фолбэком, а не `switch` (Fork C1); `type` всегда, `Count` сходится с суммой показанного; обогащение структурно аддитивно через отдельную `enrichMessage` поверх немутируемого `normalizeMessage` (Fork D1), forward-оригинал в новый ключ `forwarded`, а не в `context.refs[]`; неизменяемый golden-тест (v1-объект = подмножество v2-выхода); полный прогон v1 зелёный БЕЗ правки ассертов - AC каждой фазы.

5. **Отправка вложения необратимо заливает байты, а сообщение не уходит.** 3-шаговый upload льёт байты на диск (507/403 - квота, 413 - размер) ДО всякой отправки; форма push-ответа кроме `Status` - реконструкция. Корень: приняли ответ без числового `Status` за тихий успех; не размапили ошибки шага 1. Профилактика: ответ без числового `Status` = ОТКАЗ (инвариант v1 распространён на вложения, уже в `parsePushResponse`); ошибки upload маппятся раздельно (507/403 → квота, 413 → размер), не «upload failed»; draft показывает имя, размер, тип, чат назначения и НЕ льёт байты (заливка - только на confirm).

### Expanded Test Plan

- **Unit.**
  - `reactions` (карта): lookup известного (`100102`→like-ext/👍), неизвестного (`999999`→`{unknown:true}`), legacy-кодпоинта (`128077`), мусора (`1`→unknown, НЕ 👍); сходимость `Count` = сумма показанных; `type` присутствует всегда; валидация на запись отвергает тип вне карты.
  - `enrichMessage` (обогащение, Fork D1): реакции (`Reactions[]`/`RecentUserReactions`), прочтения (`ReadsCount`/`RecentUserReads`/`SeenByPartnerMcs`), упоминания (`MentionedUsers` → имена; отсутствие имени → `unresolved`, не guid молча), оригинал пересылки в НОВЫЙ ключ `forwarded` (`ForwardedMessages` сиблинг → автор/чат/дата/текст), признак треда и корень (`ThreadState`/`ThreadParentMessage`); **ловушка §17.13**: под `DropPayload` нет `From` → не помечать «не моё». **Golden-тест аддитивности**: точный v1-объект `normalizeMessage` на фиксированной фикстуре = структурное подмножество `enrichMessage`-выхода; forward-оригинал в `context.refs[]` НЕ маршрутизируется (регресс-запрет); `messageShape.test.ts` не редактируется.
  - `threadId` (`src/protocol/threadId.ts`): деривация группа `0/0/<uuid>`→`100/0/<uuid>_<ts>`, канал `1/…`→`101/…`, приватный `<guid>_<guid>`→`110/0/…_<ts>`, бизнес `2/…`→недоступен; **radix 10** (`100+parseInt(prefix,10)`), round-trip `J↔j` для группы/канала/приватного; синтетические id.
  - `resolveLink` (URL): 2-сегментная `/join/<hash>/<ts>` и 3-сегментная (сообщение в треде) через `buildThreadId`; `decodeURIComponent` каждого сегмента; хвост = `Timestamp` (16 цифр, BigInt, не `parseInt`).
  - `dates` (`getHistory`): ISO `from_date`/`to_date`/`after` → `MinTimestamp`/`MaxTimestamp`; **`MaxTimestamp` исключающая** («сообщения за сегодня» одним вызовом); BigInt, не float.
  - `confirm` (`src/mcp/confirm.ts`): fingerprint для каждого необратимого (домен-сепарирован префиксом `op`); ре-резолв на confirm; расхождение chat/fingerprint → `ConfirmRejectedError`; израсходованный токен → запомненный результат. **Кросс-op replay**: токен, минченный для op X, отвергается инструментом op Y (`op_mismatch`) - отдельный тест, не только проверка членства в множестве. Список инструментов, требующих confirm, совпадает ровно с {send_message, delete_message, send_file, edit_message, vote_in_poll}, а не-confirm - с {set_reaction, pin_message, mark_read}. Идемпотентность: серверный `DUPLICATE(8)` тестируется на send-пути (`payload_id`); для delete/edit/vote тест опирается на локальную `sentByToken` + результат Phase 0 replay-пробы, серверный дедуп не мокается как данность.
  - `list_reactions` (форма запроса): `Limit` обязателен (вызов без `Limit` не собирается / отвергается на входе, а не улетает в `BACKEND_CALL_ERROR(2)`); `Mode` - дискриминатор.
- **Integration** (против mock-WS `tests/helpers/mockXiva.ts` и записанных фикстур).
  - `message_info` → `{Message, ErrorInfo, MyReactions?, ChatInfo}`; `MyReactions` исчезает как ключ без своей реакции; `get_message` без загрузки истории.
  - `list_reactions` двумя вызовами: дефолтный `Mode` → `UserReactions` (с `Timestamp` постановки + `UserInfo`); `Mode:1` → `UserReads`+`ReadsCount`; отсутствие `UserReads` = «не отслеживается», НЕ ноль; сиблинги `history` НЕ источник истины (обрезаны: `ReadsCount:10` при `RecentUserReads` длиной 3).
  - Конверт мутаций: каждая (`reaction`/`pin`/`read`/`edit`/`vote`/`delete`) уходит полным `ClientMessage` через `buildPushParams` с `requireSubscriptionId`; плоский `push({Reaction:{...}})` не собирается (регресс-тест на форму).
  - Треды: `history {ChatId:<thread_id>, ChatDataFilter:{}}` открывает тред; пустой тред → `ENTITY_NOT_FOUND` трактуется как «тред пуст», не как ошибка доступа; `ThreadParentMessage` внутри ответа; `join_to_thread`/`leave_thread` (HTTP) → `{chat_member}`.
  - URL-резолв: `get_chats_info {invite_hash}` через `RegistryHttpClient` БЕЗ CSRF → `chat_id`.
  - `resolveChat` self-чат (изменение общего резолвера, GAP): существующий `resolveChat.test.ts` остаётся НЕОТРЕДАКТИРОВАННЫМ; отдельный тест «ветка self-чата не меняет резолв не-self чатов» (тот же вход не-self → тот же выход, что в v1); резолв «Избранное» → self-ChatId (`<guid>_<guid>` + `PrivateChatInfo` + `PartnerInfo.Guid === myGuid`).
  - Вложения: 3-шаговый upload против фикстур (`upload_to_disk` → PUT → `add_files` → push с `file_info.id`); ошибки 507/403 → квота, 413 → размер; ответ без числового `Status` → отказ.
- **E2E** (env-gated, реальный аккаунт, мутации ТОЛЬКО в self-чате).
  - Phase 0 form-probe: результаты снятых форм зафиксированы (см. Live-verification).
  - `set_reaction` ставит и `Action:REMOVE=1` снимает одним вызовом (без confirm); `list_reactions` после подтверждает.
  - `mark_read`: непрочитанное (`LastSeqNo - LastSeenByMeSeqNo > 0`) после вызова обнуляется (маркер - тот, что подтвердил Phase 0).
  - `pin_message`: закреп и открепление тем же инструментом (семантика `Pin.Timestamp` - из Phase 0).
  - `edit_message`: draft показывает «было → станет» и не правит; confirm правит; сообщение читается с новым текстом и непустым `LastEditTimestamp`.
  - `delete_message`: draft не удаляет; confirm удаляет; повторное чтение → `Deleted=true`.
  - Чтение опроса (AC-28): `poll_info` против ЛЮБОГО реального опроса в любом чате (read разрешён везде, не только self-чат) → `answerVotes`/`myChoices`/`results` + признак «это опрос». Источник читаемого опроса указывается в прогоне; от self-чата НЕ зависит.
  - `vote_in_poll` (AC-29): голос отправкой в self-чат недостижим (создание опроса - Non-Goal). Инструмент прогоняется на доко-форме; **AC-29 НЕ засчитывается без живого `myChoices`** - формулировка «долг вместо голоса» не используется, вместо неё «AC-29 условный, инструмент experimental». Если окажется, что опрос в self-чат можно создать веб-UI вне MCP - тогда verify по-настоящему; иначе честный условный долг.
  - `send_file` (картинка и произвольный файл): все 3 шага + draft→confirm; читается обратно с `file_info.id` и скачивается.
  - `get_message` по ChatId+Timestamp и по join-ссылке; `get_message_context` (N до/после); self-чат резолвится по имени «Избранное».
  - Регрессия v1: `list_chats`/`get_history`/`search`/`send_message`/`download_attachment` работают на реальном аккаунте; build/typecheck 0.
- **Observability.**
  - Инварианты v1: stdout чист (только MCP stdio), stderr структурный, редакция текста/секретов/uid/guid/cookie/csrf.
  - Логировать сырое `rate_limit.wait_for` (единица не документирована, кламп 1-60 с) - первое живое срабатывание определит единицу (долг доказательств).
  - Логировать неизвестный `type` реакции (unknown-путь) и факт валидации на запись.
  - Логировать выпуск/расход confirm-токена; какой read-marker используется (запись исхода Phase 0).
  - Debug-захват сырых кадров (base64) на новых мутациях для диагностики дрейфа форм.

---

## Package Structure (ДЕЛЬТА к v1)

Новые модули:
```
src/
├── config/
│   └── reaction-map.json          # ДАННЫЕ: порт из .omc/spikes/yandex-mcp/v2/reaction-map.json (52 записи)
├── protocol/
│   ├── enrichMessage.ts           # Fork D1: enrichMessage(base,{myGuid,reactionMap,siblings}) -> base + НОВЫЕ top-level ключи (reactions/reads/mentions/forwarded/thread); normalizeMessage НЕ мутируется
│   ├── reactions.ts               # list_reactions 2 вызова (Mode дискриминатор, Limit обязателен); lookup карты; unknown-фолбэк; валидация на запись
│   ├── threadId.ts                # buildThreadId/parseThreadId (§17.10; radix 10; тред = чат)
│   ├── messageInfo.ts             # get_message через WS message_info {ChatId, Timestamp}
│   ├── threads.ts                 # get_thread (history по thread_id), join_to_thread/leave_thread (HTTP)
│   ├── poll.ts                    # poll_info (чтение) + сборка Vote (форма из Phase 0)
│   └── mutations.ts               # сборка ClientMessage-вариантов: Reaction, Pin, read-marker, edit (convertMessageToPlain+Timestamp), Vote, Delete - все через buildPushParams
├── chat/
│   └── resolveLink.ts             # разбор join-URL (§17.11) + get_chats_info {invite_hash} без CSRF
├── attachments/
│   └── uploader.ts                # 3-шаг: upload_to_disk → PUT сырых байт → add_files (§12.1); ошибки 507/403/413
├── mcp/
│   ├── confirm.ts                 # ОБЩИЙ confirm-токен {op, chat_id, fingerprint, payload_id?}: op-дискриминатор + домен-сепарированный fingerprint, encode/decode, rememberSend, ConfirmRejectedError (+op_mismatch)
│   └── tools/
│       ├── getMessage.ts          # по ChatId+Timestamp и по URL
│       ├── getMessageContext.ts   # окно до/после метки
│       ├── getThread.ts           # тред как микро-чат + join/leave + создание
│       ├── setReaction.ts         # без confirm; валидация по карте; полный конверт
│       ├── markRead.ts            # без confirm
│       ├── pinMessage.ts          # без confirm
│       ├── deleteMessage.ts       # draft→confirm
│       ├── editMessage.ts         # draft→confirm (было → станет)
│       ├── sendFile.ts            # draft→confirm; 3-шаг upload; image + file
│       └── voteInPoll.ts          # draft→confirm; poll read + голос
```

Меняются существующие:
```
src/
├── protocol/
│   ├── messageShape.ts            # normalizeMessage НЕ трогаем (выход байт-в-байт v1); обогащение вынесено в новый enrichMessage.ts (Fork D1)
│   └── push.ts                    # buildPushParams переиспользуется всеми мутациями (уже корректен: полный конверт)
├── chat/
│   └── resolveChat.ts             # ИЗМЕНЕНИЕ поведения общего резолвера: добавить ветку self-чата (guid===myGuid) НЕ меняя резолв не-self; resolveChat.test.ts не редактируется, +тест на неизменность не-self
├── mcp/
│   ├── tools/
│   │   ├── getHistory.ts          # + from_date/to_date/after (ISO → Min/MaxTimestamp, верхняя исключающая)
│   │   ├── sendMessage.ts         # DraftToken/rememberSend выносятся в mcp/confirm.ts (переиспользование, поведение не меняется)
│   │   └── downloadAttachment.ts  # + voice/gallery чтение; проверка превью ?size=
│   └── deps.ts                    # + карта реакций в ToolDeps (или её loader)
├── config/
│   ├── defaults.ts                # + лимиты list_reactions, ограничения upload, путь reaction-map
│   └── types.ts                   # + соответствующие типы Config
├── util/
│   └── timestamps.ts              # + ISO-дата → мкс (если ещё нет)
└── server.ts                      # регистрация 10 новых инструментов; аннотации confirm/destructive
```

Транспорт v1 не трогаем: `transport/ws/*` (frameCodec, MessengerWsClient, requestId, frameTypes), `transport/RegistryHttpClient.ts`, `transport/backoff.ts`, `auth/*`, `util/json.ts`, `util/logger.ts`, `attachments/{downloadUrl,downloader,cleanup}.ts` (последние - точечно под voice/gallery/`?size=`).

---

## Live-verification (долги доказательств - что считается закрытием)

Закрытие = живой прогон в self-чате, не рассуждение. Не закрылся → остаётся в README дословно с указанием, что пробовали.

- **Формы мутаций (доко-выведенные, Phase 0):** какой из `SeenMarker`/`UnseenMarker`/`ReadMarker` обнуляет непрочитанное; открепляет ли пустой `Pin.Timestamp`; правит ли `convertMessageToPlain` с проставленным `Timestamp`; форма ответа `push` кроме `Status` (`MessageInfo`/`PrevTimestampMcs`/`RateLimit.WaitFor`). Форма `Vote.Choices` живой отправкой в self-чате недостижима (нет опроса) - остаётся доко-выведенной, `vote_in_poll` experimental.
- **Replay-идемпотентность target-мутаций (Phase 0):** дважды submit `edit`/`delete` (и `vote`, если опрос есть) в self-чате; зафиксировать фактом, даёт ли сервер `DUPLICATE(8)` или переприменяет. Серверный дедуп для delete/edit/vote заявляется ТОЛЬКО там, где наблюдён; иначе опора на естественную идемпотентность по target-`Timestamp` + локальную `sentByToken`.
- **voice/gallery-вложения (чтение):** прочитать реальное голосовое и реальную галерею с живого аккаунта. Нет на профиле → долг остаётся, фикстура доказательством не объявляется.
- **Единица `rate_limit.wait_for`:** сейчас неизвестна, сырое значение зажато в 1-60 с; поймать живой `rate_limit` (на успешной отправке он не приходит - случай ловить). Не поймали → кламп и запись сырого значения в лог остаются.
- **Превью `?size=`:** проверить на картинке заведомо больше кэпа (`MIDDLE2048` ранее вернул байт-в-байт оригинал 294561 - без контроля размера исходника это не доказательство). Исход «ресайз не работает / параметр игнорируется» - тоже закрытие, если доказан.

---

## Implementation Phases (в порядке исполнения)

### Phase 0 - Живой wire-probe форм мутаций + закрытие долгов (ВОРОТА)
Прогнать в self-чате реальные `push` и `list_reactions`, снять фактические формы, зафиксировать в фикстуры (`tests/fixtures/`) и §17. Никакой AC-несущий mutation-инструмент, чья форма проверяема в self-чате, не начинается, пока его форма не подтверждена здесь либо явно не оставлена долгом.
Снять: read-marker (`SeenMarker` vs `UnseenMarker` vs `ReadMarker` - какой обнуляет `LastSeqNo - LastSeenByMeSeqNo`, §17.9); `Pin.Timestamp` (пустой = открепить?); правка (`convertMessageToPlain` + `Timestamp`); форма push-ответа кроме `Status`; `list_reactions` с `Limit` и `Mode:1`. **Replay-идемпотентность:** дважды submit edit/delete (и vote при наличии опроса) - фиксировать `DUPLICATE(8)` vs переприменение. Закрыть долги: voice/gallery чтение, живой `rate_limit` + единица `wait_for`, превью `?size=` на большой картинке. **Форма `Vote.Choices` в self-чате недостижима** (нет опроса, создание - Non-Goal): остаётся доко-выведенной, помечается как условная для AC-29.
Модули: артефакты-прогоны (не в проде), фикстуры.
Покрывает AC: 25 (voice/gallery), 26 (форма push-ответа + `wait_for`), 27 (превью `?size=`); подтверждает формы для AC 19, 20, 21 (в self-чате достижимы); форма для AC 29 остаётся условной (голос недостижим).
Acceptance: каждая доко-выведенная форма, достижимая в self-чате, либо подтверждена живым прогоном и снята в фикстуру, либо явно записана в README как незакрытый долг с описанием попытки; исход replay-пробы зафиксирован (серверный дедуп заявлен только где наблюдён). Живые мутации выполнены ТОЛЬКО в self-чате; все поставленные реакции сняты; временные скрипты и сырые дампы удалены.

### Phase 1 - Обогащение чтения (enrichMessage)
Создать `src/protocol/enrichMessage.ts` (Fork D1) поверх немутируемого `normalizeMessage`: НОВЫЕ top-level ключи - прочтения (`ReadsCount`/`RecentUserReads`/`SeenByPartnerMcs`; отсутствие → «не отслеживается», не ноль), упоминания (`MentionedUsers` → имена; нет имени → `unresolved`, не guid молча), оригинал пересылки в ключ `forwarded` (сиблинг `ForwardedMessages` → автор/чат/дата/текст; НЕ в `context.refs[]`), признак треда и корень (`ThreadState`/`ThreadParentMessage`), сырые реакции (`Reactions[]`/`RecentUserReactions` - тип int; отрисовка через карту приходит в Phase 2). Учесть §17.13: под `DropPayload:true` нет `From` - не принимать за «не моё». Форматирование - сырой `MessageText` (уже так; зафиксировать в README отсутствие entities, §17.14). Golden-тест: v1-объект = подмножество v2-выхода.
Модули: `enrichMessage.ts` (новый), `messageShape.ts` (не мутируется), README.
Покрывает AC: 1 частично (обогащённая выдача, реакции сырым `type`; emoji/name реакции - Phase 2; полное AC-1 закрывается в конце Phase 2, проверяемо на сообщении `1784287503814009`), 5 (оригинал пересылки), 6 (упоминания в имена), 13 (сырое форматирование).
Acceptance: сообщение приезжает с прочтениями/reply/forward/thread-ref + сырыми реакциями, где API это отдаёт; упоминания в именах либо явный `unresolved`; `normalizeMessage`-выход не изменился (golden); `messageShape.test.ts` не редактирован; набор v1 зелёный.

### Phase 2 - Реакции и прочтения (чтение)
`src/protocol/reactions.ts`: два вызова `list_reactions` на сообщение (дефолтный `Mode` → `UserReactions`; `Mode:1` → `UserReads`+`ReadsCount`; `Limit` обязателен), lookup по карте, unknown-фолбэк, сходимость `Count`. Портировать `reaction-map.json` в `src/config/`. Тип трактуется как int (id артворка), не emoji и не кодпоинт; `type` присутствует всегда; неизвестный → `{type, name:null, emoji:null, unknown:true}` без `chr(type)`. Сиблинги `history` обрезаны - не источник истины для полного списка.
Модули: `reactions.ts` (новый), `config/reaction-map.json` (новый), интеграция в выдачу `get_history`/`get_message` (через `enrichMessage`).
Покрывает AC: 1 (завершение: реакции с `emoji`/`name` из карты поверх Phase 1), 2 (2 вызова), 3 (int + unknown, `type` всегда), 4 (`Limit` обязателен).
Acceptance: реакции и прочтения достаются двумя вызовами; `999999` в карте-фолбэке не роняет выдачу, виден как unknown, `Count` сходится; вызов без `Limit` не собирается; отсутствие `UserReads` = «не отслеживается».

### Phase 3 - Адресация и фильтры истории
`src/protocol/messageInfo.ts` (`get_message` по ChatId+Timestamp через `message_info`, без загрузки истории; форма `{Message, ErrorInfo, MyReactions?, ChatInfo}`). `src/chat/resolveLink.ts` (разбор join-URL §17.11: хвост = `Timestamp` BigInt, hash = `invite_hash`; резолв `get_chats_info {invite_hash}` без CSRF; 3-сегментная = сообщение в треде через `buildThreadId`). `get_message_context` (окно `MinTimestamp`/`MaxTimestamp`/`Offset`/`Limit` вокруг метки). Расширить `getHistory.ts`: `from_date`/`to_date`/`after` (ISO → мкс; верхняя граница исключающая).
Модули: `messageInfo.ts`, `resolveLink.ts`, `mcp/tools/getMessage.ts`, `mcp/tools/getMessageContext.ts` (новые); `getHistory.ts`, `util/timestamps.ts` (меняются).
Покрывает AC: 7 (`get_message` по ID), 8 (`get_message` по URL), 9 (`get_message_context`), 10 (даты).
Acceptance: `get_message(chat_id+message_id)` отдаёт одно сообщение без истории; принимает join-URL и резолвит в чат+сообщение; `get_message_context` возвращает N до/после; «сообщения за сегодня» одним вызовом с корректной исключающей верхней границей.

### Phase 4 - Треды (полный паритет)
`src/protocol/threadId.ts` (деривация §17.10, radix 10, тред = чат; бизнес-префикс `2/…` недоступен - зафиксировать). `src/protocol/threads.ts` + `mcp/tools/getThread.ts`: открытие треда = `history {ChatId:<thread_id>, ChatDataFilter:{}}` (`ENTITY_NOT_FOUND` = «пуст», не ошибка); сообщение несёт признак «есть тред» и корень (из Phase 1); создание («Обсудить») = деривация + первый push материализует; `join_to_thread`/`leave_thread` (HTTP → `{chat_member}`). Отправка в тред использует УЖЕ существующий send-путь v1 (`send_message` с `thread_id` как ChatId - это его же draft→confirm, `thread_id` = валидный ChatId), поэтому функциональна в конце Phase 4 без ожидания Phase 5/6; общий `confirm.ts` (Phase 5) её не блокирует.
Модули: `threadId.ts`, `threads.ts`, `mcp/tools/getThread.ts` (новые).
Покрывает AC: 11 (треды: чтение, признак, отправка через v1 send-путь, создание, join/leave).
Acceptance: `get_thread(message|thread_id)` отдаёт сообщения треда; создание из сообщения работает (деривация + первый push); join/leave через HTTP; отправка в тред работает через переиспользование v1 `send_message` (draft→confirm) с `thread_id` как ChatId.

### Phase 5 - Общий confirm-токен + реверсибельные мутации (без confirm)
Вынести `DraftToken`/`encodeToken`/`decodeToken`/`rememberSend`/`ConfirmRejectedError` из `sendMessage.ts` в `src/mcp/confirm.ts`, обобщив до fingerprint (Fork B1); `sendMessage.ts` перевести на общий модуль без смены поведения. `src/protocol/mutations.ts`: сборка вариантов `ClientMessage`. Инструменты без confirm (один вызов, полный конверт через `buildPushParams`): `set_reaction` (валидация по карте ДО отправки; `Action:REMOVE=1`), `mark_read` (маркер из Phase 0), `pin_message` (семантика `Pin.Timestamp` из Phase 0).
Модули: `mcp/confirm.ts`, `protocol/mutations.ts`, `mcp/tools/{setReaction,markRead,pinMessage}.ts` (новые); `sendMessage.ts` (рефактор на общий модуль).
Покрывает AC: 16 (`set_reaction` + REMOVE), 17 (валидация по карте), 18 (полный конверт, плоский отвергнут), 20 (`mark_read`), 21 (`pin_message`), 32 (confirm отсутствует у реакций/пина/read).
Acceptance: `set_reaction`/`mark_read`/`pin_message` выполняются одним вызовом без confirm; `set_reaction` отвергает `999999`/`1` на входе; плоский `push({Reaction:{...}})` не собирается; `mark_read` обнуляет непрочитанное; открепление работает тем же инструментом. Живьём - в self-чате.

### Phase 6 - Необратимые мутации (draft→confirm)
На инфраструктуре Phase 5: `delete_message` (пустой `Plain` §9.3; draft показывает удаляемое, confirm удаляет; повторное чтение → `Deleted=true`), `edit_message` (`convertMessageToPlain`+`Timestamp` - форма подтверждена Phase 0; draft «было → станет», confirm правит; чтение с непустым `LastEditTimestamp`). **Опросы расцеплены на чтение и голос:** чтение (`poll_info` → `answerVotes`/`myChoices`/`results` + признак «это опрос») live-проверяется против ЛЮБОГО реального опроса в любом чате (read разрешён везде) - AC-28 закрывается безусловно; голос `vote_in_poll` (`Vote` §9.3, форма ДОКО-ВЫВЕДЕНА, в self-чате не проверить) выпускается как **experimental**: реализуется + unit/integration на доко-форме, но AC-29 НЕ засчитывается без живого `myChoices` - это условный долг, инструмент не объявляется проверенным. Правку/удаление чужого отклоняет сервер - ошибку маппим внятно, своё ограничение не изобретаем.
Модули: `mcp/tools/{deleteMessage,editMessage,voteInPoll}.ts`, `protocol/poll.ts` (новые); `protocol/mutations.ts` (расширяется).
Покрывает AC: 12 (`delete_message`), 19 (`edit_message`, форма из Phase 0), 28 (чтение опроса + признак, безусловно), 29 (`vote_in_poll`, УСЛОВНО: инструмент shipped experimental, засчитывается только с живым `myChoices`), 31 (confirm присутствует у delete/edit/vote).
Acceptance: draft каждого не мутирует; confirm мутирует; delete → `Deleted=true`, edit → новый текст + `LastEditTimestamp`; опрос читается против реального опроса (источник указан в прогоне) с признаком «это опрос» - AC-28 закрыт. `vote_in_poll` реализован и тестируется на доко-форме; AC-29 остаётся условным долгом до живого `myChoices`. **draft/confirm-вывод `vote_in_poll` несёт явное поле `form_status: experimental_unverified`, пока Phase 0 не подтвердит `Vote.Choices` живьём - предупреждение видно в точке необратимого действия, а не только в README.** Если live обнаружит механику снятия/смены голоса - confirm у `vote_in_poll` пересматривается (основание отпадает). Живьём (delete/edit) - в self-чате.

### Phase 7 - Отправка вложений (draft→confirm)
`src/attachments/uploader.ts`: 3 шага (§12.1: `upload_to_disk {files:[{name, upload_id, size, chat_id}]}` → HTTP PUT сырых байт на `upload_url`, заголовок `Location` → `add_files {chatId, files:[{location}]}` → `{file_id}`); затем обычное сообщение с `file_info.id` через send-путь. Инструмент `send_file` (image и file; voice/gallery только чтение): draft показывает имя/размер/тип/чат и НЕ льёт байты (заливка на confirm). Ошибки: 507/403 → квота, 413 → размер, не «upload failed». Ответ без числового `Status` → отказ (уже в `parsePushResponse`). Расширить `downloadAttachment.ts`: чтение voice/gallery, проверка `?size=` (Phase 0).
Модули: `attachments/uploader.ts`, `mcp/tools/sendFile.ts` (новые); `attachments/downloadUrl.ts`, `downloadAttachment.ts` (меняются).
Покрывает AC: 22 (`send_file` 3 шага + draft→confirm), 23 (ошибки 507/403/413), 24 (нет `Status` = отказ), 31 (confirm у вложений).
Acceptance: `send_file` (картинка и файл) проходит все 3 шага + draft→confirm; draft не льёт байты; отправленное читается обратно с `file_info.id` и скачивается; ошибки upload раздельны; voice/gallery читаются (или долг). Живьём - в self-чате. Заметка в README: при повторном confirm после рестарта процесса (локальная `sentByToken` потеряна) 3-шаговый upload перезаливает байты; дубля сообщения нет (`payload_id` дедуплицируется на send-пути), но байты уходят повторно - поведение ограничено квота-ошибкой, не блокер.

### Phase 8 - Self-чат по имени + сквозной confirm-тест + документация + верификация
`resolveChat.ts` (ИЗМЕНЕНИЕ поведения общего резолвера, GAP): добавить ветку self-чата (`ChatId === <guid>_<guid>` + `PrivateChatInfo` + `PartnerInfo.Guid === myGuid`, резолв «Избранное» по имени) так, чтобы резолв НЕ-self чатов не изменился. Жёсткое требование: существующий `resolveChat.test.ts` остаётся НЕОТРЕДАКТИРОВАННЫМ; добавить тест «ветка self-чата не меняет резолв не-self» (тот же не-self вход → тот же выход, что в v1). Регистрация всех инструментов в `server.ts` с корректными аннотациями. Сквозной тест confirm-политики (два перечня совпадают ровно) + кросс-op replay (`op_mismatch`). README: долги дословно (включая условный AC-29 vote), confirm-политика, треды, оговорка про аппроксимацию эмодзи, требование к таймауту MCP-клиента (≥5 мин - ожидание логина дольше дефолтов, first-run auth). Прогон верификации отдельным reviewer/verifier-проходом (не в этом контексте): нет заглушек/`test.skip`/нереализованных веток.
Модули: `resolveChat.ts`, `server.ts`, README (меняются); сквозные тесты.
Покрывает AC: 14 (first-run auth таймаут в README), 15 (регрессия v1 зелёная), 30 (self-чат по имени), 31+32 (сквозной confirm-тест).
Acceptance: `get_history` по имени «Избранное» отдаёт self-чат; `resolveChat.test.ts` не редактирован и зелёный, ветка self не меняет не-self резолв (отдельный тест); тест на список инструментов с confirm совпадает с двумя перечнями; кросс-op токен отвергается; unit+integration зелёные; e2e-smoke на реальном аккаунте (мутации в self-чате) PASSED; build/typecheck 0; README покрывает долги, confirm-политику, треды, таймаут.

---

## ADR

- **Decision.** Расширить существующий MCP v1 до паритета чтения и мутаций аддитивной дельтой: обогащение нормализатора (`messageShape`) + новые read-пути (`message_info`, `list_reactions` 2 вызова, треды как чаты, join-URL) + 10 новых инструментов-мутаций поверх уже корректного WS-транспорта. Confirm - только у необратимых (send/delete/edit/attachments/vote); реверсибельные (reaction/pin/read) - одним вызовом. Реакция - int (id артворка) с картой-данными и lookup-с-фолбэком. Доко-выведенные формы мутаций верифицируются живьём в self-чате ДО построения на них AC (Phase 0 - ворота).
- **Drivers.** (1) Доко-выведенные формы мутаций - главный риск, дока систематически врёт, а v2 строит на ней необратимое → живая верификация как ворота. (2) Данные уже на проводе → центр тяжести в нормализаторе, транспорт переиспользуется → дешёвое обогащение, регрессия закрывается аддитивностью. (3) Необратимость + чужие чаты → confirm необратимым, валидация реакции на запись, live только self-чат.
- **Alternatives considered.** Строить инструменты по доке и чинить по багам (A2) - отклонён: необратимое на непроверенной форме. Дублировать confirm-паттерн в каждом инструменте (B2) - отклонён: N мест расхождения на необратимом пути. Хардкод `switch` int→emoji (C2) - отклонён: пространство типов открыто, `switch` ронял бы или терял бы данные. Реверс серверного создания треда - снят фактом: создания нет, «Обсудить» = строковая деривация (§17.10). Client-side парсинг markdown в entities - отклонён (Round 3, спайк 2: entities на проводе нет). Real-time/LIVE-события, звонки, управление чатами, мульти-аккаунт, OAuth без браузера - вне scope v2 (Non-Goals спека).
- **Why chosen.** Аддитивная дельта переиспользует отлаженный транспорт v1 (frame codec, handshake, envelope мутаций, no-retry push) и минимизирует регрессию; Phase 0 переносит риск доко-выведенных форм из релиза в дешёвый живой прогон; общий `confirm.ts` даёт одну проверенную реализацию идемпотентности на всём необратимом пути; карта-данные с фолбэком - единственно корректный способ при открытом пространстве типов.
- **Consequences.** Phase 0 требует живого self-аккаунта до основной реализации; часть форм/долгов может не закрыться (voice/gallery в self-чате) - тогда честный долг в README, не выдумка. **`vote_in_poll` выпускается experimental на доко-форме `Vote.Choices` (в self-чате голос недостижим - создание опроса Non-Goal); AC-29 засчитывается ТОЛЬКО с живым `myChoices`, иначе условный долг. Чтение опроса (AC-28) при этом закрывается безусловно против любого реального опроса.** Обогащение вынесено в отдельную `enrichMessage` (Fork D1): `normalizeMessage` не мутируется, forward-оригинал в новый ключ `forwarded`, v1-регрессия держится golden-тестом БЕЗ правки ассертов. confirm-токен несёт `op` (кросс-op replay закрыт). Серверная дедупликация `DUPLICATE(8)` заявляется только на send-пути (`payload_id`); для delete/edit/vote - естественная идемпотентность по target-`Timestamp` + локальная память, серверный дедуп только там, где Phase 0 (replay-проба) наблюдала его фактом. `resolveChat` меняет поведение общего резолвера - защищено неизменностью `resolveChat.test.ts` + тестом на не-self. Реакции читаются двумя вызовами `list_reactions` на сообщение (цена паритета). Колонка `emoji` в карте - аппроксимация (33 записи ASSET кликом не подтверждены), авторитетны `type` и `name`. Единица `rate_limit.wait_for` может остаться неизвестной (кламп 1-60 с сохраняется).
- **Follow-ups (v3).** Real-time/LIVE-подписки и обработка потока событий (app-level chat-subscribe); отправка voice/gallery; звонки и встречи (Telemost); управление чатами; мульти-аккаунт; OAuth через отдельный `UniproxyWsClient`; если live обнаружит снятие/смену голоса - убрать confirm у `vote_in_poll`; сезонные наборы реакций (живьём не наблюдались - июль) и подтверждение 33 ASSET-записей кликом.

---

## Risks and Mitigations

| Риск | Источник | Митигация |
|------|----------|-----------|
| Доко-выведенная форма мутации неверна на проводе | спек (Vote/Pin/ReadMarker/edit доко-выведены), §17-прецедент | Phase 0 - ворота: форма без живого подтверждения → инструмент не выпускается, долг в README; фикстуры с реального ответа |
| `set_reaction` пишет мусор, видят все; сервер не валидирует | спайк 5 (`999999` → `Status:1`) | Валидация по `reaction-map.json` ДО отправки; полный конверт `ClientMessage` (плоский → ложный `NO_SUCH_CHAT`); live только self-чат |
| Необратимая мутация не в тот чат / дубль / кросс-op replay токена | необратимость edit/delete/vote/вложения; обобщённый токен | Общий `confirm.ts` с полем `op` (сверка на confirm) + домен-сепарированный fingerprint; ре-резолв на confirm; push не ретраится; чужое отклоняет сервер. Дедуп: `DUPLICATE(8)` только send-путь (`payload_id`); delete/edit/vote - target-`Timestamp` + `sentByToken`, серверный дедуп только где наблюдён (Phase 0 replay-проба) |
| Неизвестный тип реакции роняет `get_message` | спайк 5 (пространство типов открыто) | Lookup-с-фолбэком, не `switch`; `type` всегда; `Count` сходится |
| `DropPayload:true` срезает `From` → «ничьё» сообщение | §17.13 | Не определять авторство под `DropPayload`; тест-ловушка |
| Обогащение ломает v1-регрессию (346 тестов) через `context.refs`/`from`/`attachments` | обогащение на месте в `normalizeMessage` | Отдельная `enrichMessage` (Fork D1), `normalizeMessage` не мутируется; forward-оригинал в новый ключ `forwarded`, не в `context.refs[]`; golden-тест (v1 = подмножество v2); `messageShape.test.ts` не редактируется |
| `vote_in_poll` строится на непроверяемой в self-чате форме | `Vote.Choices` доко-выведена, опроса в «Избранном» нет | Расцепить чтение (AC-28, безусловно против любого опроса) и голос (AC-29, experimental); AC-29 не засчитан без живого `myChoices`; планка спека не снижается, долг честный |
| Вложение необратимо залито, сообщение не ушло | §12.1; форма push-ответа реконструкция | Ответ без числового `Status` = отказ; ошибки 507/403/413 раздельно; draft не льёт байты |
| `Limit` в `list_reactions` пропущен → `BACKEND_CALL_ERROR(2)` | §17.12 / спайк 5 | `Limit` обязателен; вызов без него не собирается; регресс-тест на форму запроса |
| Единица `rate_limit.wait_for` неизвестна | §12.1, спек | Кламп 1-60 с; сырое значение в лог; поймать живой `rate_limit` (Phase 0) - иначе долг остаётся |
| Тред в бизнес-чате (`2/…`) недоступен (radix 2 → NaN) | §17.10, спайк 1 | Реализовать `100+parseInt(prefix,10)` (radix 10); бизнес-префикс задокументировать как недоступный, не копировать radix 2 |
| voice/gallery/опрос отсутствуют в self-чате | спек (долги) | Долг остаётся в README дословно; фикстура доказательством не объявляется |
| Точность меток-курсоров | инвариант v1 | string/BigInt, не float; ISO-дата → мкс через BigInt |

---

## Acceptance Criteria mapping (32 AC спека → фаза)

Легенда: «безусловно» - закрывается кодом+тестом независимо от живого прогона. «условно от Phase 0» - covered тогда и только тогда, когда Phase 0 подтвердил форму живым прогоном; иначе README-долг дословно + инструмент НЕ объявляется проверенным.

| # | AC (кратко) | Фаза / условие |
|---|---|---|
| 1 | Обогащённый `get_history` (реакции/reads/reply/forward/thread), msg `1784287503814009` | 1+2 (реакции: сырой type в 1, emoji/name в 2) |
| 2 | Реакции+прочтения двумя вызовами `list_reactions` | 2 |
| 3 | `Reaction.Type` = int; unknown-фолбэк; `type` всегда | 2 |
| 4 | `list_reactions` с обязательным `Limit` | 2 |
| 5 | Оригинал пересылки (автор/чат/дата/текст) | 1 |
| 6 | Упоминания в имена (`unresolved`, не guid) | 1 |
| 7 | `get_message(chat_id+message_id)` через `message_info` | 3 |
| 8 | `get_message` по join-URL | 3 |
| 9 | `get_message_context(before, after)` | 3 |
| 10 | `get_history` `from_date`/`to_date`/`after` | 3 |
| 11 | Треды: чтение/признак/отправка/создание/join-leave | 4 |
| 12 | `delete_message` draft→confirm, `Deleted=true` | 6 |
| 13 | Сырое форматирование + README | 1 |
| 14 | First-run auth таймаут ≥5 мин в README | 8 |
| 15 | Регрессия v1 зелёная (build/typecheck 0) | 8 (+ каждая фаза) |
| 16 | `set_reaction` + `Action:REMOVE`, без confirm | 5 |
| 17 | `set_reaction` валидирует по карте ДО отправки | 5 |
| 18 | `Reaction` полным конвертом; плоский отвергнут | 5 |
| 19 | `edit_message` было→станет; `LastEditTimestamp` | 6 · условно от Phase 0 (форма edit подтверждается в self-чате) |
| 20 | `mark_read` одним вызовом; обнуляет непрочитанное | 5 · условно от Phase 0 (какой из 3 маркеров - подтверждается в self-чате) |
| 21 | `pin_message` одним вызовом; открепление | 5 · условно от Phase 0 (семантика `Pin.Timestamp` - подтверждается в self-чате) |
| 22 | `send_file` + картинка: 3 шага + draft→confirm | 7 |
| 23 | Ошибки upload: 507/403 квота, 413 размер | 7 |
| 24 | Нет числового `Status` = отказ | 7 |
| 25 | voice/gallery прочитаны живьём | 0 (чтение - 7) |
| 26 | Форма push-ответа кроме `Status` + `wait_for` | 0 |
| 27 | Превью `?size=` на большой картинке | 0 |
| 28 | Чтение опроса + признак «это опрос» | 6 · условно от Phase 0 (форма `poll_info` проверяется против ЛЮБОГО реального опроса, не зависит от self-чата → закрываемо) |
| 29 | `vote_in_poll` draft→confirm; `myChoices` | 6 · УСЛОВНО: shipped experimental на доко-форме; НЕ засчитан без живого `myChoices` (голос в self-чате недостижим) |
| 30 | Self-чат по имени «Избранное» | 8 |
| 31 | Confirm ровно у send/delete/attachments/edit/vote | 5/6/7 + 8 (сквозной тест) |
| 32 | Confirm отсутствует у reaction/pin/read | 5 + 8 (сквозной тест) |

Покрыто: **27 безусловно + 5 условно от Phase 0** (AC 19/20/21/28/29). Из условных: 19/20/21 закрываются живым прогоном в self-чате; 28 закрывается против любого реального опроса (не зависит от self-чата); **29 может остаться условным долгом** - живой голос в self-чате недостижим (создание опроса Non-Goal), инструмент выпускается experimental и не объявляется проверенным без живого `myChoices`. Долги ЧТЕНИЯ (25/26/27) закрываются живым прогоном либо остаются документированным долгом - это легитимно по спеку. «32/32» безусловным НЕ заявляется.

---

## Config additions (defaults.ts / types.ts)

| Ключ | Значение / смысл |
|------|------|
| `reactionMapPath` | `src/config/reaction-map.json` (данные, порт из спайка 5) |
| `listReactionsLimit` | обязательный `Limit` для `list_reactions` (дефолт напр. 50; без него `BACKEND_CALL_ERROR(2)`) |
| upload-ограничения | размер/типы для `send_file` (image, file); voice/gallery только чтение |
| `mcpClientTimeoutHintMin` | документируемый минимум таймаута MCP-клиента (≥5 мин, first-run auth) |

Наследуются из v1 без изменений: `apiUrl`, `csrfTokenUrl`, `xivaUrl`, `xivaServiceName`, `serviceId=27`, `apiVersion=5`, `client=1000`, file-хосты, `workspaceId=main`, TTL загрузок, пути артефактов.

---

## Changelog

1. Создан план v2 как ДЕЛЬТА к v1 (`ralplan-yandex-messenger-mcp.md`): та же секционная структура (Requirements, RALPLAN-DR, Package Structure, Phases, ADR, Risks, AC mapping, Changelog), пакетная структура показана дельтой.
2. RALPLAN-DR DELIBERATE: Principles (5), Decision Drivers (3), Viable Options (3 форка A/B/C + снятая развилка создания треда), Pre-mortem (5, включая обязательный про доко-выведенную форму), Expanded Test Plan (unit/integration/e2e/observability).
3. Встроен ключевой вывод разведки (Principle 1): ~10 из 11 уже на проводе, v2 = «перестать терять данные», единственное чего нет - entities (сырая строка).
4. Формы `Vote`/`Pin`/`ReadMarker`/edit вынесены в Phase 0 (ворота) с живой верификацией в self-чате ДО построения AC; долги доказательств привязаны к живому прогону.
5. Confirm-политика из спека зафиксирована как вход (Principle 4), проверяется сквозным тестом (Phase 8).
6. Реакции: int-id, карта-данные с lookup-фолбэком (Fork C1), валидация на запись, полный конверт `ClientMessage`.
7. ADR полный: Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups.

### Ревизия итерации 1 (Architect SOUND_WITH_CONCERNS + Critic ITERATE) - применено

8. **[CRITICAL] Расцеплены чтение и голос опроса, снято противоречие ворот на `vote_in_poll`.** AC-28 (чтение) закрывается безусловно против ЛЮБОГО реального опроса (read везде), источник указывается в прогоне. AC-29 (голос) НЕ засчитывается без живого `myChoices`: голос в self-чате недостижим (создание опроса Non-Goal), инструмент выпускается experimental на доко-форме, не объявляется проверенным. Убрана формулировка «долг вместо голоса», снижавшая планку спека. Правки: Fork A1 Cons, Pre-mortem #1, E2E, Phase 0, Phase 6, AC-28/29 mapping.
9. **[MAJOR] Confirm-токен получил дискриминатор операции `op` + домен-сепарированный fingerprint.** Схема `{op, chat_id, fingerprint, payload_id?}`; сверка `token.op` с именем инструмента на confirm (`op_mismatch`). Добавлен тест «токен op X отвергается op Y». Правки: Fork B1, Package Structure `confirm.ts`, Test Plan confirm, Pre-mortem #3, Risks.
10. **[MAJOR] Идемпотентность разведена по путям, серверный `DUPLICATE(8)` не переобобщён.** Заявляется только на send-пути (`payload_id`); для delete/edit/vote - естественная идемпотентность по target-`Timestamp` + локальная `sentByToken`, серверный дедуп только где наблюдён. Добавлена Phase 0 replay-проба (дважды submit edit/delete/vote). Правки: Fork B1, Phase 0, Live-verification, Pre-mortem #3, Risks, ADR Consequences.
11. **[MAJOR] Аддитивность `messageShape` сделана структурной (Option B), не дисциплиной.** Добавлен Fork D1: отдельная `enrichMessage` поверх немутируемого `normalizeMessage`; forward-оригинал в новый ключ `forwarded`, НЕ в `context.refs[]`; неизменяемый golden-тест (v1 = подмножество v2); `messageShape.test.ts` не редактируется. Правки: Principle 5, Driver 2, Fork D, Pre-mortem #4, Test Plan, Package Structure (+`enrichMessage.ts`), Phase 1, Risks.
12. **[MAJOR] «32/32» перемаркировано честно.** 27 безусловно + 5 условно от Phase 0 (19/20/21/28/29). Каждый Phase-0-зависимый AC помечен «covered iff Phase 0 закрыл форму». Легенда добавлена в таблицу.
13. **[MINOR] AC-1 = Phase 1+2** (сырой type в 1, emoji/name в 2). Поправлены Phase 1, Phase 2, mapping.
14. **[MINOR] Phase 4 thread-send:** убрана неверная ссылка на «Phase 6 инфраструктура»; отправка в тред функциональна в конце Phase 4 через переиспользование v1 `send_message` (уже draft→confirm) с `thread_id` как ChatId.
15. **[GAP] `resolveChat` self-чат помечен как изменение общего резолвера.** Требование: `resolveChat.test.ts` не редактируется; тест «ветка self не меняет резолв не-self». Правки: Package Structure, Phase 8, Test Plan integration.
16. **[GAP] Источник читаемого опроса (AC-28) указан:** любой реальный опрос в любом чате, от self-чата не зависит.

Status плана: pending approval. Итерация 1 применена, готов к следующему проходу Architect/Critic.
