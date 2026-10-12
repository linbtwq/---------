// блок налаштувань
// тут описані базові параметри роботи інтерфейсу і зв'язку з 1с

// базовий адрес http-сервісу 1с
const _RAW_API_BASE = 'http://192.168.57.85/siteapinew/hs/siteapi';

const APP_CONFIG = {
    // адрес http-сервісу 1с
    // зайвий слеш в кінці автоматично прибере script.js
    apiBase: _RAW_API_BASE,
    apiVersion: '1.0',

    // таймаути запитів у мілісекундах
    // завантаження довідника зазвичай швидше, ніж відправка документів
    loadTimeoutMs: 10000,
    sendTimeoutMs: 20000,

    // як часто автоматично пробувати дозавантажувати офлайн чергу
    // використовується разом з експоненційною затримкою в script.js
    syncRetrySeconds: 30,

    // блокування точки після зняття показників
    // value endOfDay до 00 00
    // value hours на число годин з lockHours
    lockMode: 'endOfDay',
    lockHours: 12,

    autoLogoutAfterSubmit: false,

    pageSize: 30,
    refreshAfterMinutes: 5
};

// запасний варіант для apiVersion, щоб URL не зламався при помилці в конфігурації
if (!APP_CONFIG.apiVersion) APP_CONFIG.apiVersion = '1.0';