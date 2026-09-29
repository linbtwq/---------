// блок настройки приложения
// здесь описаны базовые параметры работы интерфейса и связи с сервисом
const APP_CONFIG = {
  // адрес http сервиса 1с
  // лишний слэш в конце будет автоматически убран в script.js
 apiBase: 'http://192.168.57.85/siteapi/hs/siteapi',

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

  unlimitedUserIds: ['9'],
  autoLogoutAfterSubmit: false,

  pageSize: 30,
  refreshAfterMinutes: 5
};
