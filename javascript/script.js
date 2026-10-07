// script.js — полированная версия

if (typeof APP_CONFIG === 'undefined') {
    throw new Error('Не знайдено config.js — підключіть його в index.html перед script.js');
}

const apiBase = String(APP_CONFIG.apiBase).replace(/\/+$/, '');
const LOCK_MODE = APP_CONFIG.lockMode;
const LOCK_HOURS = APP_CONFIG.lockHours;
const AUTO_LOGOUT_AFTER_SUBMIT = APP_CONFIG.autoLogoutAfterSubmit;

const SEARCH_MODES = {
    all:     { placeholder: 'Номер точки, номер машини або назва...',
               hint: 'Номер точки або код машини, або назва. 0 покаже всі точки',
               empty: 'Нічого не знайдено' },
    point:   { placeholder: 'Введіть номер точки...',
               hint: 'Номер точки без нулів. 0 покаже всі точки',
               empty: 'Торгова точка з таким кодом не знайдена' },
    machine: { placeholder: 'Введіть номер або назву апарату...',
               hint: 'Код машини або назва обладнання. 0 покаже апарати',
               empty: 'Обладнання з таким номером не знайдено' }
};

// ─── формат и escape ───────────────────────────────────
const _nf = new Intl.NumberFormat('ru-RU');
const _fmtCache = new Map();
const fmt = (num) => {
    const n = Number(num);
    if (!Number.isFinite(n)) return '0';
    const key = String(n);
    let v = _fmtCache.get(key);
    if (v === undefined) {
        v = _nf.format(n);
        if (_fmtCache.size > 5000) _fmtCache.clear();
        _fmtCache.set(key, v);
    }
    return v;
};

const _escRe = /[&<>"']/g;
const _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (v) => String(v ?? '').replace(_escRe, c => _escMap[c]);

const stripZeros = (v) => String(v ?? '').trim().replace(/^0+/, '');
const normalizeCode = (v) => String(v ?? '').replace(/\s+/g, '').replace(/^0+/, '');

// ─── состояние ─────────────────────────────────────────
let globalData = [];
let lastDeleteTime = 0;
let isAtTop = false;
let currentPointId = null;
let currentMeterRequestId = null;
let currentPaymentPointId = null;
let currentPaymentRequestId = null;
let searchMode = localStorage.getItem('searchMode');
if (!SEARCH_MODES[searchMode]) searchMode = 'all';
let searchTimer = null;
let renderFrame = null;
let lastLoadedAt = 0;
let isLoading = false;
let reloadQueued = false;
let isSyncing = false;
let retryTimer = null;
let retryAttempt = 0;
let lastSyncError = '';
let connectionOnline = null;
const deviceClasses = document.documentElement.classList;
const PAGE_SIZE = deviceClasses.contains('low-end')
    ? Math.min(APP_CONFIG.pageSize, 12)
    : deviceClasses.contains('mid-end')
        ? Math.min(APP_CONFIG.pageSize, 20)
        : APP_CONFIG.pageSize;
let _dataRevision = 0;
let _lockRevision = 0;
let _sortedDataSource = null;
let _sortedData = [];
let lastResults = [];
let renderedCount = 0;
let serverDataFresh = false;
const _meterErrors = new Set();
let toastTimer = null;
let statusTimer = null;
let _lastStatusKey = '';

const AUTO_REFRESH_INTERVAL = 60 * 1000;
let autoRefreshTimer = null;

// страховка от тихих падений промисов
window.addEventListener('unhandledrejection', (e) => {
    console.warn('[unhandled]', e.reason);
});

// ─── кэш блокировок и очереди ──────────────────────────
let _locksCache = null;
let _locksCacheAt = 0;

function getLocks() {
    const now = Date.now();
    if (_locksCache && now - _locksCacheAt < 1000) return _locksCache;
    try {
        _locksCache = JSON.parse(localStorage.getItem('pointLocks')) || {};
    } catch (e) {
        _locksCache = {};
    }
    _locksCacheAt = now;
    return _locksCache;
}
function saveLocks(locks) {
    localStorage.setItem('pointLocks', JSON.stringify(locks));
    _locksCache = locks;
    _locksCacheAt = Date.now();
}

let _queueCache = null;
let _queueCacheAt = 0;

function readQueue() {
    const now = Date.now();
    if (_queueCache && now - _queueCacheAt < 500) return _queueCache;
    try {
        _queueCache = JSON.parse(localStorage.getItem('offlineMetersQueue')) || [];
    } catch (e) {
        _queueCache = [];
    }
    _queueCacheAt = now;
    return _queueCache;
}
function saveQueue(q) {
    if (q.length) localStorage.setItem('offlineMetersQueue', JSON.stringify(q));
    else localStorage.removeItem('offlineMetersQueue');
    _queueCache = q;
    _queueCacheAt = Date.now();
}

// ─── отклоненные записи очереди ─────────────────────────
// запись попадает сюда когда 1С несколько раз подряд ответила ошибкой
const MAX_QUEUE_ATTEMPTS = 5;
const FAILED_KEY = 'failedMetersQueue';
const FAILED_TTL_MS = 14 * 24 * 3600 * 1000;

function readFailed() {
    try {
        const list = JSON.parse(localStorage.getItem(FAILED_KEY)) || [];
        const now = Date.now();
        return list.filter(f => f && f.payload && f.at && now - f.at < FAILED_TTL_MS);
    } catch (e) {
        return [];
    }
}
function saveFailed(list) {
    if (list.length) localStorage.setItem(FAILED_KEY, JSON.stringify(list));
    else localStorage.removeItem(FAILED_KEY);
}

// снимает локальную блокировку только если она ждала отправки
function unlockPoint(pointId) {
    const locks = getLocks();
    const lock = locks[String(pointId)];
    if (lock && lock.pending) {
        delete locks[String(pointId)];
        saveLocks(locks);
        invalidateLockSnapshot();
    }
}

// показывает отклоненные записи и предлагает отправить их заново
async function reviewFailedQueue() {
    const failed = readFailed();
    if (!failed.length) return false;

    const ok = await showConfirmDialog({
        title: 'Не відправлені записи',
        message: '1С відхилила ці показники. Повторити відправку?',
        details: failed.map(f => `Точка ${f.payload.point_id}: ${String(f.error || 'помилка').slice(0, 90)}`),
        okText: 'Повторити',
        cancelText: 'Закрити'
    });
    if (!ok) return false;

    const queue = readQueue().slice();
    for (const f of failed) {
        f.payload.attempts = 0;
        delete f.payload.lastError;
        queue.push(f.payload);
        lockPoint(f.payload.point_id, true);
    }
    saveFailed([]);
    saveQueue(queue);
    retryAttempt = 0;
    scheduleSyncRetry();
    return true;
}

// ─── снимок блокировок ─────────────────────────────────
let _lockSnapshot = {};
let _lockSnapshotKey = '';
let _lockSnapshotData = null;
let _lockSnapshotFresh = false;
let _lockSnapshotUnlimited = false;

function buildLockSnapshot() {
    const unlimited = isUnlimitedUser();
    if (_lockSnapshotKey && _lockSnapshotData === globalData &&
        _lockSnapshotFresh === serverDataFresh && _lockSnapshotUnlimited === unlimited) {
        return _lockSnapshot;
    }

    const locks = getLocks();
    const snap = {};
    const now = Date.now();
    let locksChanged = false;

    for (const item of globalData) {
        const id = String(item.id);
        const local = locks[id];

        let meterLock = null;
        if (local && !local.pending && local.until <= now) {
            delete locks[id];
            locksChanged = true;
        } else if (serverDataFresh && item.locked === true) {
            meterLock = { server: true, at: item.locked_at || null };
        } else if (local && (local.pending || local.until > now)) {
            meterLock = local;
        }

        let orderLock = null;
        if (item.order_locked === true) {
            orderLock = { server: true, at: item.order_locked_at || null };
        }

        snap[id] = { meter: meterLock, order: orderLock };
    }

    if (locksChanged) saveLocks(locks);
    _lockSnapshot = snap;
    _lockSnapshotData = globalData;
    _lockSnapshotFresh = serverDataFresh;
    _lockSnapshotUnlimited = unlimited;
    _lockSnapshotKey = `${_dataRevision}:${_lockRevision}`;
    return snap;
}

function invalidateLockSnapshot() {
    _lockSnapshotKey = '';
    _lockRevision++;
}

function getMeterLock(item) {
    const snap = _lockSnapshot[String(item.id)];
    return snap ? snap.meter : null;
}
function getOrderLock(item) {
    const snap = _lockSnapshot[String(item.id)];
    return snap ? snap.order : null;
}

// ─── сеть ──────────────────────────────────────────────
async function fetchWithTimeout(url, options = {}, ms = APP_CONFIG.loadTimeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: ctrl.signal });
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Failed to fetch (timeout)');
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

const newRequestId = () => (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

const postMeters = (payload) => fetchWithTimeout(`${apiBase}/meters?v=${APP_CONFIG.apiVersion}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
}, APP_CONFIG.sendTimeoutMs);

const postPayment = (payload) => fetchWithTimeout(`${apiBase}/payment?v=${APP_CONFIG.apiVersion}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
}, APP_CONFIG.sendTimeoutMs);

function showTopProgress() {
    const el = document.getElementById('topProgress');
    if (!el) return;
    el.classList.remove('active');
    void el.offsetWidth;
    el.classList.add('active');
}
function hideTopProgress() {
    const el = document.getElementById('topProgress');
    if (!el) return;
    setTimeout(() => el.classList.remove('active'), 1800);
}

// ─── хранилище ─────────────────────────────────────────
const localDB = {
    name: 'CoffeeMetersDB',
    store: 'cache',
    _db: null,
    async getDb() {
        if (this._db) return this._db;
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.name, 1);
            req.onupgradeneeded = e => e.target.result.createObjectStore(this.store);
            req.onsuccess = () => { this._db = req.result; resolve(req.result); };
            req.onerror = () => reject(req.error);
        });
    },
    async save(key, data) {
        const db = await this.getDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.store, 'readwrite');
            tx.objectStore(this.store).put(data, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },
    async load(key) {
        const db = await this.getDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.store, 'readonly');
            const req = tx.objectStore(this.store).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(tx.error);
        });
    }
};

// Очистка IndexedDB — вызывается из auth.js::logout()
// чтобы следующий пользователь не увидел чужие данные
function clearLocalDb() {
    return new Promise((resolve) => {
        try {
            if (localDB._db) {
                localDB._db.close();
                localDB._db = null;
            }
        } catch (e) {}

        if (!window.indexedDB || !indexedDB.deleteDatabase) { resolve(); return; }

        try {
            const req = indexedDB.deleteDatabase('CoffeeMetersDB');
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
        } catch (e) {
            resolve();
        }
    });
}
window.clearLocalDb = clearLocalDb;

// ─── инициализация ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initServiceWorker();
    initTheme();
    initEventListeners();
    initSearchFilters();
    showVersion();
});

function startApp() {
    clearMeterFlowState();
    clearPaymentFlowState();
    loadData();
    if (navigator.onLine) syncOfflineMeters();
    startAutoRefresh();
    if (window.innerWidth > 480) {
        setTimeout(() => {
            const searchInput = document.getElementById('searchInput');
            if (searchInput) searchInput.focus();
        }, 250);
    }
}

function initServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(err => console.error('помилка sw:', err));
    }
}

function initTheme() {
    let isDarkMode = localStorage.getItem('darkMode') === 'true';
    if (isDarkMode) document.body.classList.add('dark-theme');
    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
        themeBtn.textContent = isDarkMode ? '☀️' : '🌙';
        themeBtn.addEventListener('click', () => {
            document.body.classList.toggle('dark-theme');
            const isDark = document.body.classList.contains('dark-theme');
            localStorage.setItem('darkMode', isDark);
            themeBtn.textContent = isDark ? '☀️' : '🌙';
        });
    }
}

function initSearchFilters() {
    const searchInput = document.getElementById('searchInput');
    applySearchMode();
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            searchMode = chip.dataset.mode;
            localStorage.setItem('searchMode', searchMode);
            applySearchMode();
            if (searchInput) {
                searchInput.focus();
                if (searchInput.value.trim() !== '') handleSearch({ target: searchInput });
            }
        });
    });
}

function applySearchMode() {
    const cfg = SEARCH_MODES[searchMode];
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.mode === searchMode);
    });
    const searchInput = document.getElementById('searchInput');
    const hint = document.getElementById('searchHint');
    if (searchInput) searchInput.placeholder = cfg.placeholder;
    if (hint) hint.textContent = cfg.hint;
}

const _isFormField = (el) => {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
};

function showConfirmDialog({ title, message, details, okText, cancelText, danger }) {
    return new Promise((resolve) => {
        const overlay   = document.getElementById('confirmDialogOverlay');
        const titleEl   = document.getElementById('confirmDialogTitle');
        const msgEl     = document.getElementById('confirmDialogMessage');
        const detailsEl = document.getElementById('confirmDialogDetails');
        const okBtn     = document.getElementById('confirmDialogOk');
        const cancelBtn = document.getElementById('confirmDialogCancel');

        if (!overlay || !okBtn || !cancelBtn) { resolve(false); return; }

        titleEl.textContent = title || 'Підтвердіть дію';
        msgEl.textContent   = message || '';
        msgEl.style.display = message ? '' : 'none';

        if (Array.isArray(details) && details.length) {
            detailsEl.innerHTML = '<ul>' + details.map(d => `<li>${escapeHtml(d)}</li>`).join('') + '</ul>';
            detailsEl.style.display = '';
        } else {
            detailsEl.innerHTML = '';
            detailsEl.style.display = 'none';
        }

        okBtn.textContent     = okText || 'OK';
        cancelBtn.textContent = cancelText || 'Скасувати';
        okBtn.className       = 'action-btn ' + (danger ? 'btn-danger' : 'btn-success');

        const cleanup = () => {
            overlay.classList.remove('active');
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            overlay.removeEventListener('click', onOverlayClick);
            document.removeEventListener('keydown', onKey);
        };

        const onOk = () => { cleanup(); resolve(true); };
        const onCancel = () => { cleanup(); resolve(false); };
        const onOverlayClick = (e) => { if (e.target === overlay) onCancel(); };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            else if (e.key === 'Enter' && !_isFormField(document.activeElement)) {
                e.preventDefault();
                onOk();
            }
        };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        overlay.addEventListener('click', onOverlayClick);
        document.addEventListener('keydown', onKey);

        overlay.classList.add('active');
        setTimeout(() => okBtn.focus(), 80);
    });
}

function initClearCacheButton() {
    const btn = document.getElementById('clearCacheBtn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        // Блокируем очистку, если есть неотправленные данные
        if (readQueue().length > 0) {
            await showConfirmDialog({
                title: 'Помилка',
                message: 'Неможливо очистити кеш: є невідправлені дані. Дочекайтеся появи мережі.',
                cancelText: 'Закрити'
            });
            return;
        }

        const ok = await showConfirmDialog({
            title: 'Очистити кеш?',
            message: 'Сторінка перезавантажиться. Авторизація залишиться.',
            details: ['Буде очищено збережені дані', 'Кеш файлів'],
            okText: 'Очистити',
            cancelText: 'Скасувати',
            danger: true
        });
        if (!ok) return;

        btn.disabled = true;
        btn.textContent = '⏳';

        try {
            if ('caches' in window) {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
            }
            await clearLocalDb();

            const keepUser = localStorage.getItem('currentUser');
            const keepDark = localStorage.getItem('darkMode');
            const keepMode = localStorage.getItem('searchMode');
            const keepFailed = localStorage.getItem(FAILED_KEY);
            localStorage.clear();
            if (keepUser) localStorage.setItem('currentUser', keepUser);
            if (keepDark) localStorage.setItem('darkMode', keepDark);
            if (keepMode) localStorage.setItem('searchMode', keepMode);
            if (keepFailed) localStorage.setItem(FAILED_KEY, keepFailed);
        } catch (e) {
            console.warn('[clear cache]', e);
        }

        setTimeout(() => location.reload(), 300);
    });
}

async function runSync({ manual, quiet }) {
    const queue = readQueue();
    if (queue.length === 0) return;

    let queueChanged = false;
    for (const p of queue) {
        if (!p.request_id) {
            p.request_id = newRequestId();
            queueChanged = true;
        }
    }
    if (queueChanged) saveQueue(queue);

    if (!quiet) showToast(`Відправка записів із черги: ${queue.length}...`);
    const done = new Set();
    const dropped = [];
    let sentCount = 0;
    let netFail = false;
    let serverError = '';

    for (const payload of queue) {
        try {
            const response = await postMeters(payload);
            if (response.ok || response.status === 409) {
                markSynced(payload.point_id);
                done.add(payload.request_id);
                sentCount++;
                setConnectionStatus(true);
            } else {
                const body = (await response.text().catch(() => '')).slice(0, 160);
                serverError = `1С відповіла ${response.status}${body ? ': ' + body : ''}`;
                console.warn('[sync] помилка сервера:', response.status, body, payload);

                // ошибку сервера считаем попыткой, сетевые сбои не считаем
                payload.attempts = (payload.attempts || 0) + 1;
                payload.lastError = serverError;
                if (payload.attempts >= MAX_QUEUE_ATTEMPTS) {
                    dropped.push(payload);
                    done.add(payload.request_id);
                }
            }
        } catch (err) {
            netFail = true;
            console.warn('[sync] немає зв\'язку з 1С:', err.message);
            setConnectionStatus(false);
            continue;
        }
    }

    // отклоненные записи не удаляем а переносим в отдельный список
    if (dropped.length) {
        const failed = readFailed();
        for (const p of dropped) {
            failed.push({ payload: p, error: p.lastError || '', at: Date.now() });
        }
        saveFailed(failed);
    }

    // кеш очереди живет 500 мс и после долгих запросов читается заново
    // поэтому счетчик попыток переносим из обработанных объектов вручную
    const byId = new Map(queue.map(p => [p.request_id, p]));
    const rest = readQueue()
        .filter(p => !done.has(p.request_id))
        .map(p => byId.get(p.request_id) || p);
    saveQueue(rest);

    // снимаем блокировку точки если по ней в очереди больше ничего не осталось
    for (const p of dropped) {
        if (!rest.some(r => String(r.point_id) === String(p.point_id))) unlockPoint(p.point_id);
    }
    invalidateLockSnapshot();

    lastSyncError = rest.length ? (netFail ? 'немає зв\'язку з 1С' : serverError) : '';
    if (sentCount) retryAttempt = 0;

    if (dropped.length) {
        showToast(`1С відхилила записів: ${dropped.length}. Натисніть на статус зв'язку.`, true);
    } else if (sentCount && rest.length === 0) {
        showToast('Усі записи з черги відправлені в 1С.');
        loadData({ silent: true });
    } else if (sentCount) {
        showToast(`Відправлено: ${sentCount}, залишилось: ${rest.length}`, true);
    } else if (rest.length && !quiet) {
        showToast(`Не відправлено: ${rest.length}. ${lastSyncError || 'немає зв\'язку з 1С'}`, true);
    }

    if (sentCount && rest.length === 0 && dropped.length) loadData({ silent: true });
}

function initEventListeners() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.addEventListener('input', handleSearch);

    const results = document.getElementById('resultsContainer');
    if (results) {
        results.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const { action, id } = btn.dataset;
            if (action === 'open') openMeterModal(id);
            else if (action === 'more') appendCards(results, false);
            else if (action === 'pay') openPaymentModal(id);
            else if (action === 'assort') openAssortModal(id);
            else if (action === 'stock') openStockModal(id);
            else if (action === 'shipment') openStub('Відвантаження на точку', id);
            else if (action === 'recount') openRecountModal(id);
            else if (action === 'note') openStub('Примітка', id);
        });
        results.addEventListener('scroll', updateBackToTop, { passive: true });
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (readQueue().length) syncOfflineMeters({ quiet: true });
        if (currentUser && Date.now() - lastLoadedAt > APP_CONFIG.refreshAfterMinutes * 60 * 1000) {
            loadData({ silent: true });
        }
        renderStatus();
    });

    const statusBox = document.getElementById('connectionStatus');
    if (statusBox) statusBox.addEventListener('click', manualRefresh);

    window.addEventListener('online', () => {
        retryAttempt = 0;
        syncOfflineMeters();
        if (currentUser) loadData({ silent: true });
    });
    window.addEventListener('offline', () => setConnectionStatus(false));

    window.addEventListener('click', (event) => {
        if (event.target === document.getElementById('modalOverlay')) closeModal();
        if (event.target === document.getElementById('confirmOverlay')) closeConfirmModal();
        if (event.target === document.getElementById('paymentOverlay')) closePaymentModal();
    });

    document.addEventListener('keydown', onKeyDown);

    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(() => {
        if (document.visibilityState === 'visible' && currentUser) renderStatus();
    }, 15000);

    setupMeterButtons();
    initBackToTop();
    renderStatus();
    scheduleSyncRetry();
    initClearCacheButton();
}

function setupMeterButtons() {
    const container = document.getElementById('modalBody');
    if (!container) return;

    container.addEventListener('click', (e) => {
        const btn = e.target.closest('.qty-btn');
        if (!btn) return;
        const row = btn.closest('[data-drink-row]');
        if (!row) return;
        const input = row.querySelector('.meter-input');
        if (!input) return;
        const step = Number(btn.dataset.step) || 0;
        const current = Number(input.value) || 0;
        input.value = Math.max(0, current + step);
        calculateRowTotal(input);
    });

    container.addEventListener('input', (e) => {
        if (!e.target.classList.contains('meter-input')) return;
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 7);
        calculateRowTotal(e.target);
    });
}

function initBackToTop() {
    const btn = document.getElementById('backToTop');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const results = document.getElementById('resultsContainer');
        if (results) results.scrollTo({ top: 0, behavior: 'smooth' });
    });
}
function updateBackToTop() {
    const results = document.getElementById('resultsContainer');
    const btn = document.getElementById('backToTop');
    if (!results || !btn) return;
    btn.classList.toggle('visible', results.scrollTop > 400);
}

function showVersion() {
    const el = document.getElementById('appVersion');
    if (el && typeof APP_VERSION !== 'undefined') el.textContent = 'v' + APP_VERSION;
}

// ─── загрузка справочника ──────────────────────────────
function refreshResults() {
    const input = document.getElementById('searchInput');
    if (input && input.value.trim() !== '') handleSearch({ target: input });
}

async function loadData({ silent = false } = {}) {
    if (isLoading) { reloadQueued = true; return; }
    isLoading = true;
    showTopProgress();

    if (!globalData.length) {
        try {
            const cached = await localDB.load('cachedNomenclature');
            if (cached && Array.isArray(cached)) {
                globalData = cached;
                _dataRevision++;
                serverDataFresh = false;
                invalidateLockSnapshot();
                refreshResults();
            }
        } catch (e) { console.warn('Помилка читання кешу', e); }
    }

    try {
        const response = await fetchWithTimeout(
        `${apiBase}/nomenclature?t=${Date.now()}&v=${APP_CONFIG.apiVersion}&u=${encodeURIComponent(currentUser ? currentUser.id : '')}`,
        { method: 'GET', cache: 'no-store' },
         APP_CONFIG.loadTimeoutMs
                                    );

        if (!response.ok) throw new Error('Помилка мережі');
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error('Невірна відповідь 1С');

        globalData = data;
        _dataRevision++;
        serverDataFresh = true;
        lastLoadedAt = Date.now();
        invalidateLockSnapshot();

        try { await localDB.save('cachedNomenclature', data); }
        catch (e) { console.error('Помилка запису в БД', e); }

        setConnectionStatus(true);
        if (readQueue().length && !isSyncing) syncOfflineMeters({ quiet: true });

    } catch (error) {
        setConnectionStatus(false);
        serverDataFresh = false;

        if (!globalData.length) {
            try {
                const cached = await localDB.load('cachedNomenclature');
                globalData = (cached && Array.isArray(cached)) ? cached : [];
                _dataRevision++;
                invalidateLockSnapshot();
            } catch (e) {}
        }

        if (!silent) {
            showToast(globalData.length ? 'Офлайн. Показані збережені дані'
                                        : 'Немає зв\'язку і немає збережених даних', !globalData.length);
        }
    } finally {
        isLoading = false;
        refreshResults();
        hideTopProgress();
        renderStatus();
        if (reloadQueued) { reloadQueued = false; loadData({ silent: true }); }
    }
}

// ─── поиск ─────────────────────────────────────────────
function handleSearch(e) {
    const query = e.target.value?.trim().toLowerCase() || "";
    const searchContainer = document.getElementById('searchContainer');
    const resultsContainer = document.getElementById('resultsContainer');
    if (!searchContainer || !resultsContainer) return;

    if (!globalData.length && isLoading && query !== '') {
        showSkeletons();
        return;
    }

    const now = Date.now();
    const isDeleting = e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward';

    if (query === "") {
        if (isDeleting && (now - lastDeleteTime < 400) && isAtTop) {
            resultsContainer.innerHTML = `<div class="empty-state">Введіть код точки для пошуку</div>`;
            resultsContainer.classList.add('active');
        } else {
            searchContainer.classList.remove('top');
            searchContainer.classList.add('center');
            resultsContainer.classList.remove('active');
            isAtTop = false;
        }
        return;
    }

    if (isDeleting) lastDeleteTime = now;

    if (!isAtTop) {
        searchContainer.classList.remove('center');
        searchContainer.classList.add('top');
        resultsContainer.classList.add('active');
        isAtTop = true;
    }

    clearTimeout(searchTimer);
    const run = () => {
        cancelAnimationFrame(renderFrame);
        renderFrame = requestAnimationFrame(() => renderResults(filterPoints(query)));
    };
    if (globalData.length > 300) searchTimer = setTimeout(run, 120);
    else run();
}

function showSkeletons() {
    const container = document.getElementById('resultsContainer');
    if (!container) return;
    if (container.dataset.renderKey === 'skeletons') return;
    container.dataset.renderKey = 'skeletons';
    container.innerHTML = Array(3).fill(`
        <div class="point-card skeleton-card">
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton skeleton-text"></div>
            <div class="skeleton skeleton-text" style="width:60%"></div>
        </div>
    `).join('');
    container.classList.add('active');
}

function ix(item) {
    let ix = item._ix;
    if (ix) return ix;

    const name = ((item.point_name || '') + '\n' + (item.counterparty || '') + '\n' + (item.address || '')).toLowerCase();
    const machine = ((item.coffee_machine || '') + '\n' + (item.coffee_machine_code || '')).toLowerCase();
    const mcRaw = String(item.coffee_machine_code ?? '').toLowerCase().replace(/\s+/g, '');

    ix = {
        id: stripZeros(item.id),
        mc: normalizeCode(item.coffee_machine_code),
        mcRaw,
        name,
        machine,
        all: name + '\n' + machine,
        numId: Number(item.id) || 0
    };

    Object.defineProperty(item, '_ix', { enumerable: false, value: ix });
    return ix;
}

function getSortedData() {
    if (_sortedDataSource !== globalData) {
        _sortedDataSource = globalData;
        _sortedData = globalData.slice().sort((a, b) =>
            (Number(a.id) || 0) - (Number(b.id) || 0)
        );
    }
    return _sortedData;
}

function filterPoints(query, mode = searchMode) {
    const q = String(query || '').trim().toLowerCase();
    const isDigits = /^\d+$/.test(q);
    const num = stripZeros(q);

    if (isDigits && num === '') {
        const sorted = getSortedData();
        return mode === 'machine'
            ? sorted.filter(i => i.coffee_machine_code || i.coffee_machine)
            : sorted;
    }

    const results = [];
    for (let i = 0; i < globalData.length; i++) {
        const item = globalData[i];
        const data = ix(item);

        const matchId = isDigits && (data.id === num);
        const matchMachineCode = isDigits && (data.mc === num);
        const matchMachineRaw = data.mcRaw.includes(q);

        let hit;
        if (mode === 'machine') {
            hit = data.machine.includes(q) || matchMachineCode || matchMachineRaw;
        } else if (mode === 'point') {
            hit = data.name.includes(q) || matchId;
        } else {
            hit = data.all.includes(q) || matchId || matchMachineCode || matchMachineRaw;
        }

        if (hit) results.push(item);
    }

    if (isDigits) {
        results.sort((a, b) => {
            const aExact = (ix(a).id === num || ix(a).mc === num) ? 1 : 0;
            const bExact = (ix(b).id === num || ix(b).mc === num) ? 1 : 0;
            if (aExact !== bExact) return bExact - aExact;
            return (Number(a.id) || 0) - (Number(b.id) || 0);
        });
    }

    return results;
}

// карточка точки
function cardHtml(item, idx) {
    const lockSnap = _lockSnapshot[String(item.id)] || { meter: null, order: null };
    const meterLock = lockSnap.meter;
    const orderLock = lockSnap.order;
    const unlimited = isUnlimitedUser();
    const meterBlocked = meterLock && !unlimited;
    const id = escapeHtml(item.id);

    const debt = Number(item.debt) || 0;
    const debtHtml = debt > 0
        ? `<div class="info-item debt-positive"><span class="debt-label">Борг:</span><span class="debt-value red">${fmt(debt)} ₴</span></div>`
        : `<div class="info-item"><span class="debt-label">Борг:</span><span class="debt-value green">0 ₴</span></div>`;

    let machineDisplay = escapeHtml(item.coffee_machine) || '—';
    if (item.coffee_machine_code) {
        const machineCode = `<span class="machine-code">Код <code>${escapeHtml(item.coffee_machine_code)}</code></span>`;
        machineDisplay = item.coffee_machine ? `${machineDisplay} ${machineCode}` : machineCode;
    }

    const badges = [];
    if (meterBlocked) badges.push('<span class="lock-badge">Показники зняті</span>');

    let notes = '';
    if (meterLock) {
        notes += `<div class="lock-note">
            Показники по цій точці вже внесені${lockTimeText(meterLock)}.${
                unlimited ? '' : ' Для змін зателефонуйте в 1С.'
            }
            ${meterLock.pending ? '<br><b>Очікує відправки в 1С (немає зв\'язку).</b>' : ''}
        </div>`;
    }
    if (orderLock) {
        notes += `<div class="lock-note order">
            Поповнення по цій точці вже внесено${lockTimeText(orderLock)}.
        </div>`;
    }
    if (item.recount_locked === true) {
        const at = item.recount_locked_at ? ` (${item.recount_locked_at})` : '';
        notes += `<div class="lock-note recount">
            Перерахунок по цій точці вже внесено${at}.
        </div>`;
    }

    return `
        <div class="point-card${(meterLock || orderLock) ? ' locked' : ''}" style="--i:${idx}" data-rendered="1">
            <div class="point-header">
                <div>
                    <span class="point-title">${escapeHtml(item.point_name) || 'Без назви'}</span>
                    <span class="point-code" style="margin-left: 10px;">Код: ${id}</span>
                </div>
                ${badges.join('')}
            </div>

            <div class="point-grid">
                <div class="info-item"><label>Контрагент</label><span>${escapeHtml(item.counterparty) || '—'}</span></div>
                <div class="info-item"><label>Адреса</label><span>${escapeHtml(item.address) || '—'}</span></div>
                <div class="info-item machine-info"><label>Обладнання</label><span class="${item.coffee_machine ? 'machine-tag' : ''}">${machineDisplay}</span></div>

                ${debtHtml}
            </div>

            <div class="card-actions">
                <button class="action-btn" data-action="open" data-id="${id}" ${meterBlocked ? 'disabled' : ''}>Показники</button>
                <button class="action-btn" data-action="assort" data-id="${id}">Поповнення</button>
                <button class="action-btn btn-success" data-action="pay" data-id="${id}" ${debt > 0 ? '' : 'disabled'}>ПКО (готівка)</button>
                <button class="action-btn" data-action="stock" data-id="${id}">Залишки</button>
                <button class="action-btn" data-action="shipment" data-id="${id}">Відвантаження</button>
                <button class="action-btn" data-action="recount" data-id="${id}">Перерахунок</button>
                <button class="action-btn" data-action="note" data-id="${id}">Примітка</button>
            </div>

            ${notes}
        </div>`;
}

function openStub(title, pointId) {
    showToast(`${title}: в розробці`, false);
    console.log('[stub]', title, 'pointId =', pointId);
}

function appendCards(container, replace) {
    const start = renderedCount;
    const end = Math.min(start + PAGE_SIZE, lastResults.length);
    const remaining = lastResults.length - end;

    let html = '';
    for (let i = start; i < end; i++) {
        html += cardHtml(lastResults[i], i - start);
    }
    if (remaining > 0) {
        html += `<div class="show-more-wrap"><button class="action-btn btn-secondary" data-action="more">Показати ще (${remaining})</button></div>`;
    }
    renderedCount = end;

    if (replace) container.innerHTML = html;
    else {
        const old = container.querySelector('.show-more-wrap');
        if (old) old.remove();
        container.insertAdjacentHTML('beforeend', html);
    }
}

function renderResults(data) {
    const container = document.getElementById('resultsContainer');
    if (!container) return;

    buildLockSnapshot();

    const searchInput = document.getElementById('searchInput');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
    const key = `${_dataRevision}:${_lockRevision}:${searchMode}:${query}:${isUnlimitedUser() ? 1 : 0}`;

    container.classList.toggle('single-result', data.length === 1);

    const first = container.firstElementChild;
    if (container.dataset.renderKey === key && first && first.hasAttribute('data-rendered')) return;
    container.dataset.renderKey = key;

    lastResults = data;
    renderedCount = 0;

    if (data.length === 0) {
        container.innerHTML = `<div class="empty-state" data-rendered="1">${SEARCH_MODES[searchMode].empty}</div>`;
    } else {
        appendCards(container, true);
    }
    container.scrollTop = 0;
}

// ─── модалка показателей ───────────────────────────────
function openMeterModal(pointId) {
    const item = globalData.find(i => String(i.id) === String(pointId));
    if (!item) return;
    if (isMeterBlocked(item)) {
        showToast('По цій точці показники вже зняті. Зміни — через 1С.', true);
        return;
    }
    rememberFocus();
    _meterErrors.clear();
    currentPointId = item.id;
    currentMeterRequestId = newRequestId();

    const modalSub = document.getElementById('modalSub');
    if (modalSub) {
        const subParts = [item.point_name || 'Точка', `код ${item.id}`];
        if (item.coffee_machine) {
            subParts.push(item.coffee_machine + (item.coffee_machine_code ? ` (${item.coffee_machine_code})` : ''));
        }
        modalSub.textContent = subParts.join(' · ');
    }

    let bodyHtml;
    if (item.assortment && item.assortment.length > 0) {
        const prices = item.assortment.map(d => Number(d.price) || 0);
        const min = Math.min(...prices), max = Math.max(...prices);
        const priceText = min === max ? `${fmt(min)} ₴` : `${fmt(min)}–${fmt(max)} ₴`;

        // общий счетчик показываем только если в 1С у оборудования стоит галочка
        const sumLast = item.assortment.reduce((s, d) => s + (Number(d.last_meter) || 0), 0);
        const serverTotal = item.total_counter == null ? NaN : Number(item.total_counter);
        const totalBase = Number.isFinite(serverTotal) ? serverTotal : sumLast;
        const totalPill = item.use_total_counter === true
            ? `<span class="assort-pill total">Загальний лічильник
                   <b id="totalCounterValue" data-base="${totalBase}">${fmt(totalBase)}</b>
                   <span class="pill-delta" id="totalCounterDelta"></span>
               </span>`
            : '';

        const rowsHtml = item.assortment.map(drink => {
            const price = Number(drink.price) || 0;
            const lastMeter = Number(drink.last_meter) || 0;
            return `
                <div class="meter-input-group assort-row" data-drink-row data-code="${escapeHtml(drink.code || '')}">
                    <div class="assort-row-head">
                        <strong class="assort-tile-name drink-name">${escapeHtml(drink.name) || 'Без назви'}</strong>
                        <span class="assort-row-price">Ціна: <strong>${fmt(price)} ₴</strong></span>
                    </div>
                    <div class="assort-row-fields">
                        <div>
                            <label>Було</label>
                            <div class="assort-field-static">${fmt(lastMeter)}</div>
                        </div>
                        <div>
                            <label>Новий</label>
                            <div class="qty">
                                <button type="button" class="qty-btn" data-step="-1" aria-label="Менше">−</button>
                                <input type="text" inputmode="numeric" pattern="[0-9]*"
                                       class="meter-input qty-input"
                                       value="${lastMeter}"
                                       data-price="${price}"
                                       data-last="${lastMeter}">
                                <button type="button" class="qty-btn" data-step="1" aria-label="Більше">+</button>
                            </div>
                        </div>
                        <div>
                            <label>Разом</label>
                            <div class="row-total assort-row-total">0 ₴</div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        bodyHtml = `
            <div class="assort-panel">
                <div class="assort-pills">
                    ${totalPill}
                    <span class="assort-pill">${item.assortment.length} поз.</span>
                    <span class="assort-pill price">${priceText}</span>
                </div>
                <div class="assort-grid">${rowsHtml}</div>
            </div>
        `;
    } else {
        bodyHtml = `<div class="empty-state" style="padding: 20px;">Для обладнання асортимент не заповнений в 1С.</div>`;
    }

    document.getElementById('modalBody').innerHTML = bodyHtml;
    document.getElementById('modalOverlay').classList.add('active');

    const hasAssortment = Array.isArray(item.assortment) && item.assortment.length > 0;
    const proceedBtn = document.querySelector('#modalOverlay .modal-footer .action-btn');
    if (proceedBtn) proceedBtn.disabled = !hasAssortment;

    document.querySelectorAll('#modalBody [data-drink-row] .meter-input')
        .forEach(inp => calculateRowTotal(inp));

    autofocusModal(document.getElementById('modalOverlay'));
}

function calculateRowTotal(input) {
    const row = input.closest('[data-drink-row]');
    const lastMeter = Number(input.getAttribute('data-last')) || 0;
    const price = Number(input.getAttribute('data-price')) || 0;
    const raw = input.value.trim();
    const isBlank = raw === '';
    const newVal = isBlank ? 0 : Number(raw) || 0;

    let errorHint = row.querySelector('.error-hint');
    if (!errorHint) {
        errorHint = document.createElement('div');
        errorHint.className = 'error-hint';
        errorHint.textContent = 'Менше попереднього!';
        const wrap = input.closest('.assort-row-fields > div') || input.parentNode;
        wrap.appendChild(errorHint);
    }

    const hasError = !isBlank && newVal < lastMeter;
    if (hasError) {
        input.classList.add('error');
        errorHint.classList.add('show');
        row.querySelector('.row-total').textContent = '0 ₴';
    } else {
        input.classList.remove('error');
        errorHint.classList.remove('show');
        const delta = newVal - lastMeter;
        const totalSum = delta > 0 ? delta * price : 0;
        row.querySelector('.row-total').textContent = `${fmt(totalSum)} ₴`;
    }

    if (hasError) _meterErrors.add(input);
    else _meterErrors.delete(input);
    const proceedBtn = document.querySelector('#modalOverlay .modal-footer .action-btn');
    if (proceedBtn) proceedBtn.disabled = _meterErrors.size > 0;

    updateTotalCounter();
}

// общий счетчик равен базовому значению из 1С плюс все приросты по строкам
function updateTotalCounter() {
    const valueEl = document.getElementById('totalCounterValue');
    if (!valueEl) return;

    const base = Number(valueEl.dataset.base) || 0;
    let added = 0;
    document.querySelectorAll('#modalBody [data-drink-row] .meter-input').forEach(inp => {
        const last = Number(inp.getAttribute('data-last')) || 0;
        const val = Number(inp.value.trim()) || 0;
        if (val > last) added += val - last;
    });

    valueEl.textContent = fmt(base + added);
    const deltaEl = document.getElementById('totalCounterDelta');
    if (deltaEl) deltaEl.textContent = added > 0 ? `+${fmt(added)}` : '';
}

function clearMeterFlowState() {
    currentPointId = null;
    currentMeterRequestId = null;
}

function clearPaymentFlowState() {
    currentPaymentPointId = null;
    currentPaymentRequestId = null;
}

function showConfirmModal() {
    const rows = document.querySelectorAll('#modalBody [data-drink-row]');
    let totalCups = 0;
    let totalMoney = 0;
    rows.forEach(row => {
        const price = Number(row.querySelector('.meter-input').getAttribute('data-price')) || 0;
        const value = Number(row.querySelector('.meter-input').value) || 0;
        const lastMeter = Number(row.querySelector('.meter-input').getAttribute('data-last')) || 0;
        const delta = value - lastMeter;
        if (delta > 0) { totalCups += delta; totalMoney += delta * price; }
    });
    document.getElementById('confirmTotalCups').textContent = `${fmt(totalCups)} шт`;
    document.getElementById('confirmTotalMoney').textContent = `${fmt(totalMoney)} ₴`;
    document.getElementById('confirmOverlay').classList.add('active');
    autofocusModal(document.getElementById('confirmOverlay'));
}
function closeConfirmModal() {
    document.getElementById('confirmOverlay').classList.remove('active');
    if (!getTopModal()) restoreFocus();
}
function closeModal() {
    document.getElementById('modalOverlay')?.classList.remove('active');
    _meterErrors.clear();
    clearMeterFlowState();
    if (!getTopModal()) restoreFocus();
}

// ─── оплата долга ──────────────────────────────────────
function openPaymentModal(pointId) {
    const item = globalData.find(i => String(i.id) === String(pointId));
    if (!item) return;
    rememberFocus();
    currentPaymentPointId = item.id;
    currentPaymentRequestId = newRequestId();
    const debt = Number(item.debt) || 0;

    document.getElementById('paymentPointName').textContent = item.point_name || 'Без назви';
    const debtEl = document.getElementById('paymentCurrentDebt');
    debtEl.textContent = `${fmt(debt)} ₴`;
    debtEl.className = debt > 0 ? 'debt-value red' : 'debt-value green';

    const input = document.getElementById('paymentAmount');
    input.value = debt > 0 ? debt : '';
    input.max = debt > 0 ? debt : '';

    document.getElementById('paymentError').style.display = 'none';
    document.querySelector('#paymentOverlay .btn-success').disabled = false;
    document.getElementById('paymentOverlay').classList.add('active');
    setTimeout(() => { input.focus(); input.select(); }, 100);
}
function closePaymentModal() {
    document.getElementById('paymentOverlay')?.classList.remove('active');
    clearPaymentFlowState();
    if (!getTopModal()) restoreFocus();
}

async function submitPayment() {
    const pointId = currentPaymentPointId;
    const item = globalData.find(i => String(i.id) === String(pointId));
    if (!item) { closePaymentModal(); return; }

    const input = document.getElementById('paymentAmount');
    const errorBox = document.getElementById('paymentError');
    const amount = Number(input.value);
    const currentDebt = Number(item.debt) || 0;

    if (!amount || amount <= 0) {
        errorBox.textContent = 'Сума має бути більше нуля';
        errorBox.style.display = 'block';
        return;
    }
    if (amount > currentDebt) {
        errorBox.textContent = `Сума не може перевищувати поточний борг (${fmt(currentDebt)} ₴)`;
        errorBox.style.display = 'block';
        return;
    }
    if (!navigator.onLine) {
        errorBox.textContent = 'Немає мережі! Оплату можна провести тільки онлайн.';
        errorBox.style.display = 'block';
        return;
    }

    const btn = document.querySelector('#paymentOverlay .btn-success');
    const cancelBtn = document.querySelector('#paymentOverlay .btn-secondary');
    if (cancelBtn) cancelBtn.disabled = true;
    setBtnLoading(btn, 'Відправка...');
    errorBox.style.display = 'none';

    const payload = {
        point_id: pointId,
        technician_id: currentUser ? currentUser.id : '',
        amount,
        request_id: currentPaymentRequestId || newRequestId()
    };

    try {
        const response = await postPayment(payload);
        if (!response.ok) {
            const errText = await response.text();
            throw new Error((errText && errText.slice(0, 150)) || 'Помилка сервера 1С');
        }

        let body = null;
        try { body = await response.json(); } catch (e) {}

        invalidateLockSnapshot();

        // 1С может вернуть " / " или пробелы даже когда ошибок нет
        const rawConduct = (body && body.conduct_error != null) ? String(body.conduct_error) : '';
        const conductError = rawConduct.replace(/[\s\/]+/g, '').length ? rawConduct : '';

        if (conductError) {
            console.error('[1С] помилка проведення ПКО:', conductError);
            showToast('Оплата створена, але НЕ ПРОВЕДЕНА: ' + conductError.slice(0, 150), true);
        } else {
            showSuccessAnimation();
            showToast(`Оплата ${fmt(amount)} ₴ успішно проведена!`);
        }

        closePaymentModal();

        if (!conductError) refreshAfterSubmit(pointId, -amount);
        else refreshResults();

    } catch (error) {
        const msg = error && error.message ? error.message : String(error);
        if (msg.includes('Failed to fetch') || msg.toLowerCase().includes('timeout')) {
            errorBox.textContent = '1С не відповідає. Перевірте інтернет і спробуйте знову.';
        } else {
            errorBox.textContent = `Не вдалося провести: ${msg}`;
        }
        errorBox.style.display = 'block';
    } finally {
        resetBtn(btn, 'Провести оплату');
        if (cancelBtn) cancelBtn.disabled = false;
    }
}

// ─── отправка показателей ──────────────────────────────
async function applyDebtDelta(pointId, delta) {
    if (!delta) return;
    const item = globalData.find(i => String(i.id) === String(pointId));
    if (!item) return;
    item.debt = Math.max(0, (Number(item.debt) || 0) + delta);
    try { await localDB.save('cachedNomenclature', globalData); }
    catch (e) { console.warn('не зберегли кеш боргу', e); }
}

function refreshAfterSubmit(pointId, debtDelta) {
    if (debtDelta && pointId) applyDebtDelta(pointId, debtDelta);
    refreshResults();
    setTimeout(() => loadData({ silent: true }), 600);
}

async function submitMeters() {
    const pointId = currentPointId;
    const currentItem = globalData.find(i => String(i.id) === String(pointId));
    if (currentItem && isMeterBlocked(currentItem)) {
        showToast('По цій точці показники вже зняті. Зміни — через 1С.', true);
        finishSubmission({ logout: false });
        return;
    }

    const rows = document.querySelectorAll('#modalBody [data-drink-row]');
    const metersData = [];
    let sessionTotal = 0;

    rows.forEach(row => {
        const nameEl = row.querySelector('.drink-name');
        const name = nameEl ? nameEl.textContent.trim() : '';
        const code = row.dataset.code || '';
        const meterInput = row.querySelector('.meter-input');
        if (!meterInput) return;
        const price = Number(meterInput.getAttribute('data-price')) || 0;
        const value = Number(meterInput.value) || 0;
        const lastMeter = Number(meterInput.getAttribute('data-last')) || 0;
        const delta = value - lastMeter;

        if (code || name) {
            const itemTotal = delta > 0 ? delta * price : 0;
            sessionTotal += itemTotal;
            metersData.push({ code, name, price, value, delta: delta > 0 ? delta : 0, total: itemTotal });
        }
    });

    const payload = {
        point_id: pointId,
        technician_id: currentUser ? currentUser.id : "",
        request_id: currentMeterRequestId || newRequestId(),
        meters: metersData
    };

    const confirmBtn = document.querySelector('#confirmOverlay .btn-success');
    if (!confirmBtn) return;
    setBtnLoading(confirmBtn, 'Відправка...');

    if (!navigator.onLine) {
        saveOffline(payload);
        finishSubmission();
        refreshResults();
        resetBtn(confirmBtn, 'Відправити в 1С');
        return;
    }

    try {
        const response = await postMeters(payload);

        if (response.status === 409) {
            lockPoint(pointId);
            invalidateLockSnapshot();
            showToast('По цій точці показники вже внесені. Для змін телефонуйте в 1С.', true);
            finishSubmission();
            refreshResults();
            return;
        }
        if (!response.ok) {
            const errText = await response.text();
            throw new Error((errText && errText.slice(0, 200)) || 'Помилка сервера 1С');
        }

        let body = null;
        try { body = await response.json(); } catch (e) {}

        if (body && body.ok === false) {
            showToast(body.error || body.debt_error || '1С відхилила документ.', true);
            return;
        }

        lockPoint(pointId);
        invalidateLockSnapshot();

        const hasDebtError = body && body.debt_error;
        if (hasDebtError) {
            console.error('[1С] борг не нарахований:', body.debt_error);
            showToast('Документ створено, але БОРГ НЕ НАРАХОВАНО: ' + String(body.debt_error).slice(0, 150), true);
        } else {
            showSuccessAnimation();
            showToast('Документ в 1С успішно створено!');
        }

        finishSubmission();

        if (!hasDebtError) refreshAfterSubmit(pointId, sessionTotal);
        else refreshResults();

    } catch (error) {
        const msg = error && error.message ? error.message : String(error);
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
            saveOffline(payload);
            finishSubmission();
            refreshResults();
        } else {
            showToast(`Помилка: ${msg}`, true);
        }
    } finally {
        resetBtn(confirmBtn, 'Відправити в 1С');
    }
}

function finishSubmission({ logout: doLogout = AUTO_LOGOUT_AFTER_SUBMIT } = {}) {
    closeConfirmModal();
    closeModal();
    clearMeterFlowState();
    clearPaymentFlowState();

    if (doLogout && typeof logout === 'function') {
        setTimeout(() => logout(), 1800);
    }
}

function setBtnLoading(btn, text) {
    if (!btn) return;
    if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent.trim();
    btn.disabled = true;
    btn.textContent = text;
    btn.classList.add('btn-loading');
}
function resetBtn(btn, text) {
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = text || btn.dataset.originalText || 'OK';
    btn.classList.remove('btn-loading');
}

// ─── офлайн очередь ────────────────────────────────────
function saveOffline(payload) {
    const queue = readQueue().slice();
    queue.push(payload);
    saveQueue(queue);
    lockPoint(payload.point_id, true);
    invalidateLockSnapshot();
    showToast('Немає зв\'язку з 1С. Збережено на пристрої, відправимо автоматично.', true);
    retryAttempt = 0;
    setConnectionStatus(false);
    scheduleSyncRetry();
}

function scheduleSyncRetry() {
    clearTimeout(retryTimer);
    if (readQueue().length === 0) { retryAttempt = 0; return; }
    const max = APP_CONFIG.syncRetrySeconds * 1000;
    const delay = Math.min(5000 * Math.pow(2, retryAttempt), max);
    retryAttempt++;
    retryTimer = setTimeout(() => syncOfflineMeters({ quiet: true }), delay);
}

async function syncOfflineMeters(opts) {
    const manual = !!(opts && opts.manual === true);
    const quiet = !!(opts && opts.quiet === true);
    if (isSyncing) {
        if (manual) showToast('Відправка вже йде...');
        return;
    }
    isSyncing = true;
    try { await runSync({ manual, quiet }); }
    finally {
        isSyncing = false;
        renderStatus();
        scheduleSyncRetry();
    }
}

// ─── уведомления и статус ──────────────────────────────
function showSuccessAnimation() {
    const el = document.createElement('div');
    el.className = 'success-burst';
    el.innerHTML = '<svg viewBox="0 0 52 52"><path fill="none" d="M14 27l8 8 16-17"/></svg>';
    document.body.appendChild(el);
    if (navigator.vibrate) navigator.vibrate(40);
    setTimeout(() => el.classList.add('out'), 1000);
    setTimeout(() => el.remove(), 1450);
}

function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    const msgEl = document.getElementById('toastMessage');
    if (msgEl) msgEl.textContent = message;

    clearTimeout(toastTimer);
    toast.classList.remove('show');
    void toast.offsetWidth;
    toast.className = `toast show ${isError ? 'error' : ''}`;
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

function setConnectionStatus(isOnline) {
    connectionOnline = isOnline;
    renderStatus();
}

function renderStatus() {
    const box = document.getElementById('connectionStatus');
    if (!box) return;
    const queued = readQueue().length;
    const failedCount = readFailed().length;

    let timeText = '';
    if (lastLoadedAt) {
        const sec = Math.floor((Date.now() - lastLoadedAt) / 1000);
        timeText = sec < 5 ? 'щойно'
            : sec < 60 ? `${sec} сек тому`
            : sec < 3600 ? `${Math.floor(sec / 60)} хв тому`
            : `${Math.floor(sec / 3600)} год тому`;
    }

    const timeEl = box.querySelector('.status-time');
    if (timeEl) timeEl.textContent = timeText;

    const stateKey = `${connectionOnline}|${queued}|${failedCount}|${lastSyncError}|${isLoading ? 1 : 0}`;
    if (stateKey === _lastStatusKey) return;
    _lastStatusKey = stateKey;

    box.className = 'connection-status'
        + (connectionOnline === true ? ' online' : connectionOnline === false ? ' offline' : '')
        + ((queued || failedCount) ? ' has-queue' : '')
        + (isLoading ? ' syncing' : '');

    let text = connectionOnline === null ? 'Перевірка зв\'язку...'
        : connectionOnline ? '1С підключена' : 'Немає зв\'язку з 1С';
    if (queued) text += ` · Не відправлено: ${queued}`;
    if (failedCount) text += ` · Відхилено: ${failedCount}`;

    const textEl = box.querySelector('.status-text');
    if (textEl) textEl.textContent = text;

    box.title = 'Натисніть для оновлення' + (lastSyncError ? ` (${lastSyncError})` : '');
}

// ─── блокировки ────────────────────────────────────────
function computeLockUntil() {
    const now = new Date();
    if (LOCK_MODE === 'hours') return now.getTime() + LOCK_HOURS * 3600 * 1000;
    const end = new Date(now);
    end.setHours(24, 0, 0, 0);
    return end.getTime();
}

function lockPoint(pointId, pending = false) {
    const locks = getLocks();
    locks[String(pointId)] = {
        at: Date.now(),
        until: computeLockUntil(),
        pending: pending,
        user: currentUser ? currentUser.name : ''
    };
    saveLocks(locks);
    invalidateLockSnapshot();
}

function markSynced(pointId) {
    const locks = getLocks();
    const lock = locks[String(pointId)];
    if (lock) { lock.pending = false; saveLocks(locks); invalidateLockSnapshot(); }
}

function isUnlimitedUser() {
    return !!currentUser && currentUser.isAdmin === true;
}

function isMeterBlocked(item) {
    return !!getMeterLock(item) && !isUnlimitedUser();
}

function isOrderBlocked(item) {
    return !!getOrderLock(item) && !isUnlimitedUser();
}

function lockTimeText(lock) {
    if (!lock.at) return '';
    if (typeof lock.at === 'number') {
        const t = new Date(lock.at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
        return ` о ${t}`;
    }
    return ` (${lock.at})`;
}

// ─── сброс ─────────────────────────────────────────────
function resetAppState() {
    globalData = [];
    _dataRevision++;
    lastResults = [];
    renderedCount = 0;
    lastLoadedAt = 0;
    isLoading = false;
    reloadQueued = false;
    isSyncing = false;
    retryAttempt = 0;
    lastSyncError = '';
    connectionOnline = null;
    serverDataFresh = false;
    currentPointId = null;
    currentMeterRequestId = null;
    currentPaymentPointId = null;
    currentPaymentRequestId = null;
    isAtTop = false;
    _lastStatusKey = '';
    _locksCache = null;
    _queueCache = null;
    invalidateLockSnapshot();
    clearTimeout(searchTimer);
    cancelAnimationFrame(renderFrame);
    clearTimeout(retryTimer);
    clearTimeout(toastTimer);
    if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
    }
    stopAutoRefresh();

    const results = document.getElementById('resultsContainer');
    if (results) {
        results.innerHTML = '';
        results.classList.remove('active');
        delete results.dataset.renderKey;
    }
    const searchContainer = document.getElementById('searchContainer');
    if (searchContainer) {
        searchContainer.classList.remove('top');
        searchContainer.classList.add('center');
    }
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = '';

    renderStatus();
}

// ─── фокус модалок ─────────────────────────────────────
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getTopModal() {
    const modals = document.querySelectorAll('.modal-overlay.active');
    if (!modals.length) return null;

    let top = null;
    let topZ = -Infinity;

    for (const m of modals) {
        const rawZ = getComputedStyle(m).zIndex;
        const z = Number(rawZ);
        const zz = Number.isFinite(z) ? z : 1000;
        if (zz > topZ) { topZ = zz; top = m; }
    }
    return top;
}

function closeTopModal() {
    const m = getTopModal();
    if (!m) return;
    if (m.id === 'modalOverlay') closeModal();
    else if (m.id === 'confirmOverlay') closeConfirmModal();
    else if (m.id === 'paymentOverlay') closePaymentModal();
    else if (m.id === 'assortOverlay') closeAssortModal();
    else if (m.id === 'stockOverlay') closeStockModal();
    else if (m.id === 'recountOverlay') closeRecountModal();
}

let _focusBeforeModal = null;

function rememberFocus() {
    _focusBeforeModal = document.activeElement;
}
function restoreFocus() {
    if (_focusBeforeModal && document.contains(_focusBeforeModal)) {
        try { _focusBeforeModal.focus(); } catch (e) {}
    }
    _focusBeforeModal = null;
}

function trapFocus(e) {
    if (e.key !== 'Tab') return;
    const modal = getTopModal();
    if (!modal) return;
    const box = modal.querySelector('.modal-box');
    if (!box) return;
    const focusables = Array.from(box.querySelectorAll(FOCUSABLE)).filter(el => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

function onKeyDown(e) {
    if (e.key === 'Escape') {
        if (getTopModal()) {
            e.preventDefault();
            closeTopModal();
        }
        return;
    }
    trapFocus(e);
}

function autofocusModal(modal) {
    if (!modal) return;
    const box = modal.querySelector('.modal-box');
    if (!box) return;

    // Сначала пробуем сфокусировать текстовое поле — это удобнее для оператора
    const inputs = Array.from(box.querySelectorAll(
        'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])'
    )).filter(el => el.offsetParent !== null);

    if (inputs.length) {
        const firstInput = inputs[0];
        try {
            firstInput.focus();
            if (typeof firstInput.select === 'function') firstInput.select();
        } catch (e) {}
        return;
    }

    const focusables = Array.from(box.querySelectorAll(FOCUSABLE)).filter(el => el.offsetParent !== null);
    if (focusables.length) focusables[0].focus();
}

// ─── автообновление ────────────────────────────────────
function startAutoRefresh() {
    stopAutoRefresh();
    autoRefreshTimer = setInterval(autoRefreshTick, AUTO_REFRESH_INTERVAL);
}

function stopAutoRefresh() {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
}

async function autoRefreshTick() {
    if (document.visibilityState !== 'visible') return;
    if (getTopModal()) return;
    if (isLoading || isSyncing) return;
    if (!currentUser) return;

    if (readQueue().length) {
        retryAttempt = 0;
        await syncOfflineMeters({ quiet: true });
        return;
    }
    await loadData({ silent: true });
}

async function manualRefresh() {
    if (isLoading) return;
    if (readFailed().length) await reviewFailedQueue();
    const box = document.getElementById('connectionStatus');
    if (box) box.classList.add('syncing');
    retryAttempt = 0;
    try {
        if (readQueue().length) await syncOfflineMeters({ manual: true });
        await loadData({ silent: false });
    } catch (err) {
        console.warn('[manualRefresh]', err);
        showToast('Не вдалося оновити дані', true);
    } finally {
        if (box) setTimeout(() => box.classList.remove('syncing'), 400);
    }
}

// ─── модалка остатков ──────────────────────────────────
function ensureStockModal() {
    let el = document.getElementById('stockOverlay');
    if (el) return el;

    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'stockOverlay';
    el.style.zIndex = '1005';

    el.innerHTML = `
        <div class="modal-box assort-box">
            <div class="modal-header">
                <div class="assort-head">
                    <h3>Залишки по апарату</h3>
                    <div class="assort-sub" id="stockSub"></div>
                </div>
                <button class="modal-close" type="button" aria-label="Закрити">✕</button>
            </div>
            <div class="modal-body" id="stockBody"></div>
            <div class="modal-footer">
                <button class="action-btn btn-secondary" type="button" id="stockCloseBtn">Закрити</button>
            </div>
        </div>
    `;

    document.body.appendChild(el);

    el.querySelector('.modal-close').addEventListener('click', closeStockModal);
    el.querySelector('#stockCloseBtn').addEventListener('click', closeStockModal);
    el.addEventListener('click', (e) => { if (e.target === el) closeStockModal(); });

    return el;
}

function closeStockModal() {
    document.getElementById('stockOverlay')?.classList.remove('active');
    if (!getTopModal()) restoreFocus();
}

async function openStockModal(pointId) {
    const point = globalData.find(i => String(i.id) === String(pointId));
    if (!point) return;

    rememberFocus();

    const overlay = ensureStockModal();
    const sub = document.getElementById('stockSub');
    const body = document.getElementById('stockBody');

    sub.textContent = `${point.point_name || 'Точка'} · код ${point.id}`;
    body.innerHTML = `
        <div class="assort-loading">
            <div class="skeleton skeleton-text" style="width:60%;"></div>
            <div class="skeleton skeleton-text" style="width:80%;"></div>
            <div class="skeleton skeleton-text" style="width:50%;"></div>
        </div>
    `;

    overlay.classList.add('active');

    try {
        const res = await fetchWithTimeout(
            `${apiBase}/stock?point=${encodeURIComponent(point.id)}&t=${Date.now()}`,
            { method: 'GET', cache: 'no-store' },
            APP_CONFIG.loadTimeoutMs
        );

        if (!res.ok) throw new Error('Помилка мережі');

        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Невірна відповідь 1С');

        if (data.length === 1 && String(data[0].Code) === '0') {
            body.innerHTML = `
                <div class="empty-state" style="padding: 28px 20px;">
                    ${escapeHtml(data[0].Name)}
                </div>
            `;
            return;
        }

        if (!data.length) {
            body.innerHTML = `<div class="empty-state" style="padding: 28px 20px;">Залишки відсутні</div>`;
            return;
        }

        const sorted = data.slice().sort((a, b) =>
            String(a.Name || '').localeCompare(String(b.Name || ''), 'uk')
        );

        body.innerHTML = `
            <div class="assort-panel">
                <div class="assort-pills" style="margin-top:0;">
                    <span class="assort-pill">${sorted.length} поз.</span>
                </div>
                <div class="stock-list">
                    ${sorted.map(it => {
                        const qty = Number(it.quantity) || 0;
                        const qtyClass = qty <= 0 ? 'zero' : (qty < 10 ? 'low' : 'ok');
                        return `
                            <div class="stock-row">
                                <span class="stock-name">${escapeHtml(it.Name || '—')}</span>
                                <span class="stock-qty ${qtyClass}">${fmt(qty)}</span>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;

    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        body.innerHTML = `
            <div class="assort-error">
                Не вдалося завантажити залишки: ${escapeHtml(message)}
            </div>
        `;
    }
}