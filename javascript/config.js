// блок настройки приложения
// здесь описаны базовые параметры работы интерфейса и связи с сервисом

// исходный адрес http-сервиса 1С
const _RAW_API_BASE = 'http://192.168.57.85/siteapinew/hs/siteapinew';

// на HTTPS-странице браузер блокирует http-запросы (mixed content),
// поэтому автоматически повышаем протокол до https
const _IS_HTTPS_PAGE = (typeof location !== 'undefined' && location.protocol === 'https:');
const _API_BASE = _IS_HTTPS_PAGE
    ? _RAW_API_BASE.replace(/^http:/i, 'https:')
    : _RAW_API_BASE;

const APP_CONFIG = {
    // адрес http сервиса 1с
    // лишний слэш в конце будет автоматически убран в script.js
    apiBase: _API_BASE,
    apiVersion: '1.0',

    // таймауты запросов в миллисекундах
    // загрузка справочника обычно должна быть быстрее, чем отправка документов
    loadTimeoutMs: 10000,
    sendTimeoutMs: 20000,

    // как часто автоматически пробовать досылать офлайн очередь
    // она используется вместе с экспоненциальной задержкой в script.js
    syncRetrySeconds: 30,

    // блокировка точки после снятия показателей
    // value endOfDay до 00 00
    // value hours на число часов из lockHours
    lockMode: 'endOfDay',
    lockHours: 12,

    autoLogoutAfterSubmit: false,

    pageSize: 30,
    refreshAfterMinutes: 5
};

// fallback на apiVersion, чтобы URL не сломались при опечатке в конфиге
if (!APP_CONFIG.apiVersion) APP_CONFIG.apiVersion = '1.0';