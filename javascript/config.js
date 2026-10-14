// блок настроек
// тут описаны базовые параметры работы интерфейса и связи с 1С

// адрес HTTP-сервиса 1С по умолчанию
// используется, если в браузере не задан свой адрес через localStorage
const _RAW_API_BASE_DEFAULT = 'http://176.98.84.42:49155/siteapinew/hs/siteapi';

// функция решает, какой адрес использовать:
//   1) если в localStorage лежит ключ apiBaseOverride и это валидная http(s)-ссылка — берём её
//   2) иначе берём адрес по умолчанию
// это позволяет менять сервер без правки кода, прямо из консоли браузера
function resolveApiBase() {
    try {
        const override = localStorage.getItem('apiBaseOverride');
        // принимаем только валидный http(s)-адрес, всё остальное игнорируем
        if (override && /^https?:\/\/.+/i.test(override)) {
            // убираем слеши в конце, чтобы не было двойных слэшей в запросах
            return override.replace(/\/+$/, '');
        }
    } catch (e) {}
    return _RAW_API_BASE_DEFAULT;
}

const _RAW_API_BASE = resolveApiBase();

const APP_CONFIG = {
    // адрес HTTP-сервиса 1С
    // лишний слеш в конце автоматически уберёт script.js
    apiBase: _RAW_API_BASE,
    apiVersion: '1.0',

    // таймауты запросов в миллисекундах
    // загрузка справочника обычно быстрее, чем отправка документов
    loadTimeoutMs: 10000,
    sendTimeoutMs: 20000,

    // как часто автоматически пробовать дозагружать офлайн-очередь
    // используется вместе с экспоненциальной задержкой в script.js
    syncRetrySeconds: 30,

    // блокировка точки после снятия показателей
    // значение endOfDay — до 00:00
    // значение hours — на число часов из lockHours
    lockMode: 'endOfDay',
    lockHours: 12,

    autoLogoutAfterSubmit: false,

    pageSize: 30,
    refreshAfterMinutes: 5
};

// запасной вариант для apiVersion, чтобы URL не сломался при ошибке в конфигурации
if (!APP_CONFIG.apiVersion) APP_CONFIG.apiVersion = '1.0';