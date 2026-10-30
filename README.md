# page-inspector

Расширение Chrome/Edge (Manifest V3) для диагностики открытой страницы.

Установка: `chrome://extensions` → режим разработчика → «Загрузить распакованное расширение» → папка репозитория.

Режимы:
- **Максимальный снимок** (`full.js`) — DOM всех фреймов с закрытым Shadow DOM, cookie с HttpOnly,
  local/sessionStorage, IndexedDB, Cache Storage, OPFS, значения полей, глобальные переменные страницы,
  performance; опционально MHTML и тела всех ресурсов через DevTools Protocol.
- **Подробный снимок без секретов** (`detailed.js`) — то же дерево DOM, но без значений.
- Старые JSON/HTML-снимки и selector probe (`popup.js`).

Подробности и ограничения — в [README_RU.txt](README_RU.txt).

> Максимальный снимок содержит значения сессионных cookie и паролей из полей. Не передавайте файл посторонним.
