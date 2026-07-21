/**
 * Конфигурация semantic-release (AC-29). Порядок плагинов фиксирован намеренно:
 * commit-analyzer определяет тип бампа (patch/minor/major) из коммитов ->
 * release-notes-generator и changelog готовят текст и файл -> npm публикует пакет ->
 * github публикует релиз с заметками -> git коммитит CHANGELOG.md и package.json
 * обратно в репозиторий. Каждый плагин отдельная devDependency, версии сверены
 * с npm registry на дату написания конфига (context7 + `npm view`, не по памяти):
 * semantic-release 25.0.8, commit-analyzer 13.0.1, release-notes-generator 14.1.1,
 * changelog 6.0.3, npm 13.1.5, github 12.0.9, git 10.0.1.
 *
 * НИ ОДИН ПЛАГИН НЕ ТРЕБУЕТ ЯВНОГО КОНФИГА: `@semantic-release/git` по умолчанию
 * коммитит `CHANGELOG.md` + `package.json` с сообщением `chore(release): ...[skip ci]`,
 * `@semantic-release/changelog` пишет в `CHANGELOG.md` в корне, `@semantic-release/npm`
 * публикует пакет из корня (`pkgRoot` не переопределён - `files:["dist"]` в
 * `package.json` уже ограничивает содержимое тарбола). Значения проверены через
 * официальную документацию плагинов, не приняты как данность.
 *
 * ============================================================================
 * ВЕРСИОНИРОВАНИЕ (AC-29): выбран ВАРИАНТ B (0.x, "ещё нестабильно").
 * ============================================================================
 *
 * Решение пользователя (2026-07-21): держать проект в 0.x, пока API не устоялся.
 * Реализовано ниже через `releaseRules` в commit-analyzer (breaking -> minor).
 * ОСТАЁТСЯ РУЧНОЙ ШАГ ПЕРЕД ПЕРВЫМ РЕЛИЗОМ (релизное действие, не часть подготовки):
 *   1. Поставить тег базы, от которой считать первый бамп, на коммит ДО фич-ветки:
 *        git tag v0.1.0 a825603 && git push origin v0.1.0
 *      (без тега semantic-release захардкодит первый релиз в 1.0.0, минуя 0.x).
 *   2. После merge фич-ветки в main первый прогон даст 0.2.0 (breaking -> minor).
 *   3. Когда проект будет готов к стабильному API - снять правило major->minor ниже
 *      явным коммитом и выпустить 1.0.0.
 *
 * Ниже сохранён исходный разбор развилки для контекста.
 *
 * У semantic-release НЕТ git-тега вида `v0.1.0` в истории этого репозитория (пакет
 * никогда не публиковался). Из исходника `lib/get-next-version.js` (сверено через
 * context7, не по памяти): если `lastRelease.version` пуст, следующая версия жёстко
 * равна константе `FIRST_RELEASE = '1.0.0'` - тип коммита (feat/fix/BREAKING CHANGE)
 * на это НЕ влияет, а текущее значение `package.json:version` (`0.1.0`) semantic-release
 * не читает вовсе - оно ему не источник истины, git-теги источник истины.
 *
 * Отдельно: официальный FAQ semantic-release прямо говорит, что инструмент НЕ
 * реализует нпм-конвенцию «breaking-change на 0.x бампает minor, а не major» -
 * «The rules of Semantic Versioning apply differently to major version zero,
 * and supporting these differences is outside the scope of the project» и
 * «It is generally advised to start at version 1.0.0». Это значит: заход в план
 * «первый релиз 0.2.0, а дальше breaking даёт 0.3.0, не 1.0.0» НЕ дают дефолтные
 * настройки инструмента - для него потребовался бы явный `releaseRules` в
 * `@semantic-release/commit-analyzer`, переопределяющий `major` на `minor` вручную.
 *
 * Вариант A (ничего не делать, дефолт инструмента).
 *   Первый `npx semantic-release` на этой ветке отдаёт `1.0.0` на npm-тег `latest`,
 *   независимо от типа первого коммита. `package.json:version` (`0.1.0`) будет
 *   переписан на `1.0.0` этим же прогоном (плагин `npm`/`git`). Дальше обычная
 *   семантика: fix -> patch, feat -> minor, BREAKING CHANGE -> major (2.0.0 и далее).
 *   Простой путь, но публично заявляет о стабильности API с первого дня.
 *
 * Вариант B (сохранить видимость 0.x, "ещё нестабильно").
 *   До первого запуска `semantic-release` вручную создать git-тег `v0.1.0` на текущем
 *   HEAD (`git tag v0.1.0 && git push origin v0.1.0`), чтобы у инструмента появился
 *   `lastRelease.version = '0.1.0'`, от которого он посчитает следующий бамп обычным
 *   semver-инкрементом. Важно: как показано выше, `BREAKING CHANGE`-коммит от этой
 *   точки всё равно даст **major**, то есть `0.1.0 -> 1.0.0` при первом же ломающем
 *   коммите (semantic-release не занижает major на 0.x сам по себе) - если нужно
 *   именно нпм-подобное поведение «breaking = minor, пока не 1.0.0», в конфиг ниже
 *   придётся добавить `releaseRules` в `@semantic-release/commit-analyzer`,
 *   переписывающий тип `major` на `minor` (и снять это правило явным коммитом,
 *   когда проект будет готов объявить `1.0.0`).
 *
 * Выбор между A и B, а также решение о `releaseRules`, эта задача не делает -
 * см. поручение по AC-29: "НЕ финализируй выбор 1.0.0 vs 0.2.0".
 */
export default {
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        /*
         * Вариант B (0.x): breaking change бампает MINOR, а не MAJOR, пока проект в 0.x.
         * semantic-release сам этого не делает (см. разбор выше), поэтому правило явное.
         * ВРЕМЕННОЕ: снять при готовности к 1.0.0, тогда breaking снова станет major.
         */
        releaseRules: [{ breaking: true, release: 'minor' }],
      },
    ],
    '@semantic-release/release-notes-generator',
    '@semantic-release/changelog',
    '@semantic-release/npm',
    '@semantic-release/github',
    '@semantic-release/git',
  ],
};
