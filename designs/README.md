# Визуальные референсы

Файлы JSX/HTML здесь — макеты для сравнения с Polly, а не модули приложения. Текущие компоненты и токены живут в `packages/polly/src/`.

| Файл | Область |
|---|---|
| [common.jsx](common.jsx) | Базовые компоненты и общий визуальный язык |
| [final-auth.jsx](final-auth.jsx) | Вход, T-012 |
| [final-onboarding.jsx](final-onboarding.jsx) | Онбординг, T-013 |
| [final-chrome.jsx](final-chrome.jsx) | Desktop shell, T-018 |
| [final-chat.jsx](final-chat.jsx) | Чат, T-019 |
| [final-voice.jsx](final-voice.jsx) | Голос, T-034 |
| [final-dm.jsx](final-dm.jsx) | Личные сообщения, T-064 |
| [final-inbox.jsx](final-inbox.jsx) | Inbox, T-065 |
| [final-profile.jsx](final-profile.jsx) | Профиль, T-068 |
| [final-settings.jsx](final-settings.jsx) | Настройки |
| [final-mobile.jsx](final-mobile.jsx) | Мобильный UI, включая секретные чаты T-100…T-103 |
| [final-extras.jsx](final-extras.jsx) | Дополнительные экраны и состояния |

`variant-a.jsx`…`variant-d.jsx` — варианты дизайна. `design-canvas.jsx` и `.design-canvas.state.json` относятся к редактору макетов. HTML-экспорты [Как дела.html](<Как дела.html>) и [КакДела.html](КакДела.html) — отдельные сохранённые материалы, не очевидные дубликаты; они сохранены.

Некоторые старые карточки называют `final-secret-chat.jsx` или `КакДела мобильное.html`; таких файлов сейчас нет. Доступный локальный референс мобильных/секретных чатов — `final-mobile.jsx`. Перед UI-работой сверять его с текущей реализацией и конкретным запросом.
