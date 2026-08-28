# [0.4.0](https://github.com/conarti/yandex-messenger-mcp/compare/v0.3.1...v0.4.0) (2026-08-28)


### Features

* обогащение выдачи search и состав упоминаний при правке ([#26](https://github.com/conarti/yandex-messenger-mcp/issues/26)) ([ebac68c](https://github.com/conarti/yandex-messenger-mcp/commit/ebac68ca337f65be480333008e77613d7defe43a)), closes [#15](https://github.com/conarti/yandex-messenger-mcp/issues/15)


### BREAKING CHANGES

* search.messages теперь несёт ключи обогащения - reads, mentions,
reactions, thread, forwarded, from_me. Прежние v1-поля не изменились. Вызывающий,
который строго сверял форму элемента выдачи поиска, увидит новые ключи.

## [0.3.1](https://github.com/conarti/yandex-messenger-mcp/compare/v0.3.0...v0.3.1) (2026-08-28)


### Bug Fixes

* публикация в npm падала на проверке provenance ([#25](https://github.com/conarti/yandex-messenger-mcp/issues/25)) ([6ed4500](https://github.com/conarti/yandex-messenger-mcp/commit/6ed4500805f354b48623b31727106e7884fee3bd))

# [0.3.0](https://github.com/conarti/yandex-messenger-mcp/compare/v0.2.1...v0.3.0) (2026-08-28)


### Bug Fixes

* критичные баги резолва, упоминаний и чтения пересылки ([#23](https://github.com/conarti/yandex-messenger-mcp/issues/23)) ([e650ff9](https://github.com/conarti/yandex-messenger-mcp/commit/e650ff9b9e6a1b7d02f86a8c1250c7f38ee65794)), closes [#16](https://github.com/conarti/yandex-messenger-mcp/issues/16) [#17](https://github.com/conarti/yandex-messenger-mcp/issues/17) [#15](https://github.com/conarti/yandex-messenger-mcp/issues/15) [#16](https://github.com/conarti/yandex-messenger-mcp/issues/16) [#17](https://github.com/conarti/yandex-messenger-mcp/issues/17) [#18](https://github.com/conarti/yandex-messenger-mcp/issues/18) [#22](https://github.com/conarti/yandex-messenger-mcp/issues/22) [#15](https://github.com/conarti/yandex-messenger-mcp/issues/15)


### BREAKING CHANGES

* у удалённого сообщения kind сменился с 'unknown' на 'deleted'.
Значение 'unknown' сузилось до «тела нет либо content-поля нет». Миграция через поле
deleted, оно не менялось.
* draft.text у send_message теперь отличается от входного текста, если в нём
есть упоминания. На confirm надо возвращать дословно draft.text, иначе отпечаток не совпадёт.
Рядом появилось поле text_preview с именами вместо guid, только для чтения, для эха непригодно.

## [0.2.1](https://github.com/conarti/yandex-messenger-mcp/compare/v0.2.0...v0.2.1) (2026-07-21)


### Bug Fixes

* publish package to public npm ([e5d5c76](https://github.com/conarti/yandex-messenger-mcp/commit/e5d5c76cfcb4cb90c35485cb8980e88670c3ac4e))

# [0.2.0](https://github.com/conarti/yandex-messenger-mcp/compare/v0.1.0...v0.2.0) (2026-07-21)


### Features

* исходящие упоминания и reply, единая форма реакций, npm-пакет ([#14](https://github.com/conarti/yandex-messenger-mcp/issues/14)) ([c6bb35e](https://github.com/conarti/yandex-messenger-mcp/commit/c6bb35edcd26818f854e96f209f065fb57f4934c))
