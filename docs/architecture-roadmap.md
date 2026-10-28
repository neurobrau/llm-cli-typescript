# NeuroBräu TypeScript — архитектура и roadmap

Дата анализа: 26 октября 2026. Реализация не начиналась. Документ содержит рекомендации; выбор TUI и спорные отличия поведения нужно принять до соответствующего задания.

## Проверенные источники

Прочитаны README, спецификация, CLI и provider/engine-контракты Python, а также README, storage/parity, CLI/engine, обработка фоновых операций и зависимости Go.

- [Python snapshot](https://github.com/neurobrau/llm-cli-python/tree/0a6d045c022b850371a1c51a1df30f11d9d4c60e).
- [Go snapshot](https://github.com/neurobrau/llm-cli-go/tree/b064decc66cad7d9656488bdf7749650b52cf309).
- [Python TUI specification](https://github.com/neurobrau/llm-cli-python/blob/0a6d045c022b850371a1c51a1df30f11d9d4c60e/docs/tui-spec.md).
- [Go storage](https://github.com/neurobrau/llm-cli-go/blob/b064decc66cad7d9656488bdf7749650b52cf309/docs/storage.md).
- [Go parity](https://github.com/neurobrau/llm-cli-go/blob/b064decc66cad7d9656488bdf7749650b52cf309/docs/parity.md).

Это анализ исходников и документации, а не повторное выполнение тестов двух проектов. Go README и константа CLI по-прежнему содержат `0.4.0-dev`. Наличие релизного тега отдельно не проверялось. TypeScript repository endpoint вернул 404: репозиторий не найден или недоступен этому подключению. Он не был создан; доступный GitHub connector не предоставляет создание репозиториев.

## Что переносим

| Область | Python | Go | Предложение TS |
| --- | --- | --- | --- |
| CLI | argparse; режимы выбираются в cli.py | тестируемый Run с внедрёнными потоками | тонкий cli.ts + run(argv, io) + чистый parseArgs |
| Провайдеры | Protocol, dataclasses, синхронный вызов/iterator | интерфейсы llm, context, stream iterator | интерфейсы TS, Promise и AsyncIterable |
| Engine | активная модель и request options | сборка llm.Request, общий provider | неизменяемый snapshot запроса; общая логика для всех UI |
| Session | восстановление и фиксация сообщений | отдельный session, переключение conversations | единственный владелец committed history и usage |
| Persistence | JSON reference writer | атомарные записи и byte parity fixtures | отдельные codecs и async filesystem adapter |
| TUI | curses, worker, bounded queue | tcell, фоновая работа, cancellation tokens | UI controller/reducer; async I/O; ограничение очередей и частоты рендера |
| Цены | Decimal | точная арифметика | BigInt fixed-point/rational, округление только при отображении |

Сохраняем разделение ответственности, но не переносим потоки Python и goroutines Go буквально. Обычная сеть не требует Worker Threads в Node. Если позднее обнаружится тяжёлая CPU-работа, её можно вынести отдельно по результатам измерений.

## Предлагаемые модули

Будущая структура: `src/domain/` (messages, usage, settings, events), `src/providers/` (OpenAI/Ollama adapters и capabilities), `src/application/` (engine, sessions, request lifecycle), `src/storage/` (codecs, paths, atomic writes), `src/ui/plain/`, `src/ui/tui/`, `src/pricing/`. Тонкий `src/cli.ts` только собирает приложение. В Task 001 создаются лишь реально нужные файлы skeleton.

Domain не импортирует SDK, файловую систему или TUI. Session управляет фиксацией обмена и ledger. UI отображает временный ответ отдельно от сохранённых messages. Providers возвращают нормализованные данные и ошибки, не пишут файлы и не управляют терминалом. SDK objects не становятся форматом истории.

Provider использует `generate(request, signal): Promise<GenerationOutcome>` и `stream(request, signal): AsyncIterable<StreamEvent>`. StreamEvent — discriminated union: text delta, reasoning delta, completed, incomplete, failed. При штатном потреблении до конца — ровно одно terminal event; при досрочном закрытии iterator обязательна очистка, но доставка terminal event потребителю уже не гарантируется. Ожидаемые ошибки провайдера нормализуются на границе; непредвиденные ошибки перехватываются outer boundary.

Контроллер присваивает generation ID и AbortController каждой операции, включая discovery. При отмене ID немедленно становится неактивным, затем вызывается abort. Поздние события игнорируются; законченный ответ фиксируется не более одного раза. Принимается один активный request/check; настройки блокируются на время запроса по спецификации. Promise cleanup должен завершаться предсказуемо, без unhandled rejection, оставшихся timers/listeners и бесконечного ожидания выхода.

Поток читается pull-based. Если понадобится очередь между чтением и UI, она ограничена; обновления рендера объединяются, но текст не теряется. Await записи учитывает backpressure и отмену. `TextDecoder` должен сохранять состояние между byte chunks; NDJSON проверяется на split UTF-8, split lines, EOF и malformed messages. Не использовать неограниченную цепочку fire-and-forget событий.

## Сборка и зависимости

Рекомендация: Node 24, npm с lockfile, native ESM, TypeScript NodeNext, обычный tsc без bundler. Запуск: `node dist/cli.js`. Bootstrap version `0.1.0-dev`; это ещё не полный milestone 0.1.0. Единственный источник версии — package.json. (Обновление: Task 004 завершил milestone, версия теперь `0.1.0`; план версий в `docs/architecture.md`.)

Встроенный node:test покрывает unit/integration и subprocess tests; TypeScript отдельно проверяет и source, и tests. ESLint с typescript-eslint — dev tools. Vitest удобен для UI-oriented тестов, но пока не даёт достаточного преимущества для ещё одной зависимости. Commander пригодится при сложном CLI с subcommands; текущих flags достаточно для util.parseArgs. Проверять CLI нужно через собранный JS, а не только через TS runner.

Для OpenAI рекомендован официальный `openai` SDK, подключаемый в Task 003. Проверить request cancellation, retries, deadlines, stream close, mock transport и `store: false`. SDK retries необходимо согласовать с cancellation/usage и единственным разрешённым fallback встроенного reasoning default; не добавлять незаметные повторные генерации после получения текста. Никаких live API tests.

Для Ollama рекомендую небольшой адаптер на встроенном fetch: используются tags/show/chat, и прямой контроль NDJSON полезен для parity. Официальный Ollama JS client — альтернативный вариант, если после проверки он заметно сокращает код без потери контроля. Не писать общий HTTP framework. Loopback bypass proxy, OLLAMA_HOST и cloud filtering должны повторять проверенные правила reference.

Список моделей OpenAI не является достоверным каталогом reasoning capabilities. Discovery и capabilities — разные задачи. Для известных моделей нужна версионируемая подтверждённая таблица; для неизвестных — честное unknown. Не выводить поддержку функций из названия модели или самого присутствия в Models API.

## TUI: сравнение и решение

| Вариант | Преимущества для NeuroBräu | Что требуется проверить |
| --- | --- | --- |
| Ink / React | знакомая компонентная модель, TS, декларативное состояние, render/test tools | точные ASCII geometry/цвета, F1–F6 и клавиатурные протоколы, scroll anchoring, cleanup на signals |
| Blessed | screen/widgets, функциональные клавиши, imperative layout близко к curses/tcell | актуальное состояние проекта, типизация и ESM interop, Node 24, изоляция listeners, teardown и тестовый экран |
| OpenTUI | TS bindings, core и React renderer | native/runtime требования; текущий upstream development использует Bun/Zig, что требует отдельной проверки применимости к Node 24 |
| Свой ANSI renderer | полный контроль небольшого фиксированного UI | клавиатурный parser, resize, Unicode, cleanup и terminal compatibility придётся сопровождать самостоятельно |

Предварительно первым проверяем Ink, вторым Blessed. Это порядок проверки, а не утверждённая зависимость. В документации Ink есть alternate screen, но F1–F35 не представлены отдельными полями key для Kitty protocol. Поэтому обещать F2–F6 без эксперимента нельзя. OpenTUI пока не основной кандидат: native stack нужно обосновать для простого UI и Node-only требования. Собственный ANSI renderer — резервный вариант, если готовые библиотеки мешают точному поведению.

Отдельный bounded spike до TUI: Node 24, baseline 80×25, exact black/ASCII frame, F1–F6, PgUp/PgDn, resize/too-small, paste/Unicode, fake streaming с typing/scrolling, Ctrl+C cancel/idle exit, SIGTERM/SIGHUP cleanup, broken pipe. Headless tests проверяют состояние и кадры; Linux PTY tests — raw mode/alternate screen/keys/signals; владелец вручную проверяет Ptyxis. Зафиксировать измеримые результаты и выбрать одну библиотеку перед основной реализацией. Task 001 библиотеку TUI не устанавливает.

## Решения по parity

| Вопрос | Предложение |
| --- | --- |
| Основной контракт | Python language-neutral spec; отклонения фиксировать по каждому случаю |
| One-shot saved settings | принять Go: flags + built-in defaults, без чтения settings; это сознательное отличие от Python |
| Incomplete non-streaming | принять Go: не фиксировать сообщения; учитывать reported usage как incomplete |
| UI responsiveness | все network checks async; отмена активных fetch сразу, без Python thread limitation |
| Reasoning | explicit CLI → saved provider/model setting → confirmed built-in Off/None → omitted parameter; default сохраняется отдельно от отсутствия preference |
| --no-history | запрет всех history reads/writes/chmod; settings остаются отдельной функцией, как в Go |
| Unknown capabilities | не выдавать guessed support за подтверждённый; unsupported explicit flag — startup error согласно контракту |
| Ошибки/exit codes | спецификация, включая 8, 130, 141; safe terminal restore при SIGTERM/SIGHUP в TUI |

Эти решения должны попасть в соответствующие будущие задания. Не копировать все Go intentional differences автоматически. Строки help и версия языка могут отличаться; форматы shared JSON и смысл persisted settings — нет.

## Storage: где TS требует особого внимания

`undefined`/отсутствие поля, JSON `null`, строка `default` и конкретное значение — разные состояния. У max tokens absence означает отсутствие preference, null означает явный выбор Model default. У reasoning CLI `model-default` преобразуется в persisted `default`. CLI overrides не сохраняются; интерактивный выбор заменяет override по reference. Answer style глобальный; остальные настройки привязаны к provider/model.

Обычный JSON.stringify не гарантирует весь reference format: active.json однострочный с Python-style separators, conversations/settings с indent и trailing newline, строгий порядок полей и сортировка model/provider keys. У JS integer-like keys могут переставляться; Unicode сортировка тоже требует проверки. Нужен codec с каноническим порядком, fixtures и byte comparison, а не только deepEqual.

JS number теряет точность выше 2^53−1, тогда как Go допускает signed 64-bit counts, а Python — больше. В storage задаче надо выбрать lossless integer parser/serializer (возможно небольшую проверенную зависимость), сохраняющий целые как BigInt, и точно определить общий поддержанный диапазон. Не принимать большие числа через JSON.parse с последующей проверкой: точность уже потеряна. API SDK counts проверять как safe integers; недостоверные значения нельзя молча округлять. Обещание безусловного 100% parity для произвольного Python JSON без такого решения неверно.

Проверить timestamp offsets/precision, legacy provider, unknown fields/schema, optional requests, malformed records, Unicode, nonfinite values и settings file protection. Atomic write: same-dir exclusive temp 0600 → write/fsync → rename → dir fsync; directories 0700 только внутри app paths; cleanup temp при ошибке. Writes сериализуются внутри процесса. Несколько одновременно работающих реализаций не координируются; last writer wins уже является ограничением reference.

Каждый completed exchange фиксируется один раз. Incomplete usage может сохраняться без partial messages; отмена/ошибка без известного usage ничего не добавляет. Usage totals — billed usage, а не длина context. Reasoning tokens уже входят в output. Pricing каталог переносится как датированный compatibility snapshot, а не объявляется актуальным тарифом; refresh — отдельная проверенная задача. Для точной цены нужен BigInt fixed-point/rational, не binary float.

## Roadmap — небольшие задания

| Task | Результат | Gate |
| --- | --- | --- |
| 001 | CLI bootstrap, help/version, build/typecheck/lint/tests | built CLI checks, owner review |
| 002 | domain outcomes/errors/capabilities и pure settings resolver | precedence matrix, fake provider contract |
| 003 | OpenAI non-streaming one-shot, official SDK | mock HTTP, request shape, store:false, errors/cancel |
| 004 | Ollama non-streaming, tags/show, local filtering | mock server, no cloud/pull, manual local smoke |
| 005A | JSON codecs, lossless integer strategy, fixtures | Python/Go read/write byte parity |
| 005B | XDG paths, atomic storage, corrupt-file handling | temp-dir filesystem/failure tests |
| 006 | sessions и plain multi-turn chat, commands/history | restore/reset/confirmed cleanup/no-history; owner review |
| 007A | provider streaming, NDJSON/SSE adapters | fragmented data, terminal outcomes, reader cleanup |
| 007B | streaming in one-shot/plain; cancellation/backpressure | late events, no partial commit, bounded exit; milestone 0.2 |
| 008 | TUI library spike и ADR | F1–F6/PTyxis/PTY gates; owner selects backend |
| 009A | TUI layout/input/scroll/resize без real providers | deterministic frames и PTY restoration |
| 009B | TUI request lifecycle и fake/real adapters | responsive streaming, abort, signals; milestone 0.3 |
| 010 | F2/F3 discovery и переключение sessions | async operations, independent histories, late results |
| 011 | F4–F6 menus, persisted settings | semantic parity + restart; manual acceptance |
| 012 | full usage ledger и exact pricing display | differential fixtures, incomplete accounting |
| 013 | consolidated parity/reliability/release audit | complete cross-language suite; milestone 0.4 |

Milestone 0.1 функционально заканчивается после 004; до тех пор используется dev версия. Минимальный usage нужен уже providers, полноценный ledger/цены приходят в 012. Task 005 подготавливает storage раньше plain chat. Номера после 001 — roadmap, не разрешение выполнять их без отдельного задания и приёмки. После каждого task агент останавливается, предоставляет отчёт, затем владелец принимает результат. Milestones не требуют автоматического commit/tag/release.

Cross-language suite: синтетические файлы в temp directories, Python→TS→Python, Go→TS→Go, чтение/продолжение/reset/settings/usage. Reference code read-only, Python bytecode disabled, Go build cache и Python temp/cache расположены вне references; tests не меняют исходники. Fixture tests обязательны без установленных Python/Go; live cross-language harness запускается отдельно, но является обязательным release gate в подготовленной среде. Никаких live provider calls в автоматических тестах.

## Первый запуск coding agent

Сохранить `TS_TASK_001.md` как `.agent-tasks/TS_TASK_001.md` в новом локальном TS project. Передать агенту отдельный `TS_AGENT_PROMPT_001.md`. Первый task создаёт .gitignore, исключающий `.agent-tasks/`. Если требуется remote, владелец может создать пустой repository без commit/push:

```bash
gh repo create neurobrau/llm-cli-typescript --public --description 'NeuroBräu TypeScript — a terminal-based multi-provider LLM client'
```

Предложение public соответствует двум существующим references; это команда для владельца, не действие, уже выполненное в этом чате. Создание remote не является условием для локального bootstrap.

## Документация инструментов

- [Node test runner](https://nodejs.org/docs/latest-v24.x/api/test.html).
- [Node util.parseArgs](https://nodejs.org/api/util.html#utilparseargsconfig).
- [TypeScript module/NodeNext](https://www.typescriptlang.org/tsconfig/module.html).
- [Official OpenAI Node SDK](https://github.com/openai/openai-node).
- [Ollama API](https://docs.ollama.com/api).
- [Ink](https://github.com/vadimdemedes/ink).
- [Blessed](https://github.com/chjj/blessed).
- [OpenTUI](https://github.com/anomalyco/opentui).

Upstream инструменты меняются. Перед установкой конкретной версии coding agent проверяет её Node 24 compatibility, API и lockfile; этот анализ не является обещанием поведения непроверенной версии библиотеки.
