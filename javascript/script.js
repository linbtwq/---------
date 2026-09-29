// блок 1
// базовые настройки и состояние
// здесь задаются основные параметры работы интерфейса
// и хранится глобальный контекст данных и режимов поиска

if (typeof APP_CONFIG === 'undefined') {
    throw new Error('Не найден config.js — подключите его в index.html перед script.js');
}
const apiBase = String(APP_CONFIG.apiBase).replace(/\/+$/, '');
const LOCK_MODE = APP_CONFIG.lockMode;
const LOCK_HOURS = APP_CONFIG.lockHours;
const AUTO_LOGOUT_AFTER_SUBMIT = APP_CONFIG.autoLogoutAfterSubmit;
const UNLIMITED_USER_IDS = APP_CONFIG.unlimitedUserIds;

const SEARCH_MODES = {
    all:     { placeholder: 'Номер точки, номер машины или название...',
               hint: 'Номер точки или код машины, либо название. 0 покажет все точки',
               empty: 'Ничего не найдено' },
    point:   { placeholder: 'Введите номер точки...',
               hint: 'Номер точки без нулей. 0 покажет все точки',
               empty: 'Торговая точка с таким кодом не найдена' },
    machine: { placeholder: 'Введите номер или название аппарата...',
               hint: 'Код машины или название оборудования. 0 покажет аппараты',
               empty: 'Оборудование с таким номером не найдено' }
};

const fmt = (num) => new Intl.NumberFormat('ru-RU').format(num);
const stripZeros = (v) => String(v ?? '').trim().replace(/^0+/, '');
const normalizeCode = (v) => String(v ?? '').replace(/\s+/g, '').replace(/^0+/, '');

let globalData = [];
let lastDeleteTime = 0;
let isAtTop = false;
let currentPointId = null;
let currentPaymentPointId = null;
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
const PAGE_SIZE = APP_CONFIG.pageSize;
let lastResults = [];
let renderedCount = 0;
let serverDataFresh = false;
let toastTimer = null;
let _lastStatusKey = '';

const AUTO_REFRESH_INTERVAL = 60 * 1000;
let autoRefreshTimer = null;

// блок 2
// утилиты
// здесь собраны служебные функции для форматирования
// и безопасной работы с данными и сетью

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

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

// блок 3
// хранилище
// здесь сохраняются кэш данных и очередь офлайн отправки
// чтобы приложение могло работать без связи с 1с

const localDB = {
    name: 'CoffeeMetersDB',
    store: 'cache',
    async getDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.name, 1);
            req.onupgradeneeded = e => e.target.result.createObjectStore(this.store);
            req.onsuccess = () => resolve(req.result);
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

const readQueue = () => {
    try { return JSON.parse(localStorage.getItem('offlineMetersQueue')) || []; }
    catch (e) { return []; }
};

function getLocks() {
    try { return JSON.parse(localStorage.getItem('pointLocks')) || {}; }
    catch (e) { return {}; }
}
function saveLocks(locks) {
    localStorage.setItem('pointLocks', JSON.stringify(locks));
}

// блок 4
// инициализация
// после загрузки страницы подключаются события
// запускается тема интерфейса и стартовые проверки

document.addEventListener('DOMContentLoaded', () => {
    initServiceWorker();
    initTheme();
    initEventListeners();
    initSearchFilters();
    showVersion();
});

function startApp() {
    loadData();
    if (navigator.onLine) syncOfflineMeters();
    startAutoRefresh();
    setTimeout(() => {
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.focus();
    }, 250);
}

function initServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(err => console.error('ошибка sw:', err));
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
            else if (action === 'unlock') adminUnlock(id);
            else if (action === 'more') appendCards(results, false);
            else if (action === 'pay') openPaymentModal(id);
            else if (action === 'btn2') alert('Нажата Кнопка 2 для точки: ' + id);
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

    setInterval(() => {
        if (document.visibilityState === 'visible' && currentUser) renderStatus();
    }, 15000);

    initBackToTop();
    renderStatus();
    scheduleSyncRetry();
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

// блок 5
// загрузка справочника
// здесь берутся данные из 1с и сохраняются в кэш
// при отсутствии сети показываются последние сохранённые значения

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
                serverDataFresh = false;
                refreshResults();
            }
        } catch (e) { console.warn('Ошибка чтения кэша', e); }
    }

    try {
        const response = await fetchWithTimeout(`${apiBase}/nomenclature?t=${Date.now()}&v=${APP_CONFIG.apiVersion}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'X-User-Code': currentUser ? currentUser.id : '' },
            cache: 'no-store'
        }, APP_CONFIG.loadTimeoutMs);

        if (!response.ok) throw new Error('Ошибка сети');
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error('Неверный ответ 1С');

        globalData = data;
        serverDataFresh = true;
        lastLoadedAt = Date.now();

        try { await localDB.save('cachedNomenclature', data); }
        catch (e) { console.error('Ошибка записи в БД', e); }

        setConnectionStatus(true);
        if (readQueue().length && !isSyncing) syncOfflineMeters({ quiet: true });

    } catch (error) {
        setConnectionStatus(false);
        serverDataFresh = false;

        if (!globalData.length) {
            try {
                const cached = await localDB.load('cachedNomenclature');
                globalData = (cached && Array.isArray(cached)) ? cached : [];
            } catch (e) {}
        }

        if (!silent) {
            showToast(globalData.length ? 'Оффлайн. Показаны сохраненные данные'
                                        : 'Нет связи и нет сохраненных данных', !globalData.length);
        }
    } finally {
        isLoading = false;
        refreshResults();
        hideTopProgress();
        renderStatus();
        if (reloadQueued) { reloadQueued = false; loadData({ silent: true }); }
    }
}

// блок 6
// поиск
// здесь идет отбор данных по точке, машине или общему запросу
// и формируется список совпадений для страницы

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
            resultsContainer.innerHTML = `<div class="empty-state">Введите код точки для поиска</div>`;
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
    if (!item._ix) {
        const name = [item.point_name, item.counterparty, item.address].join('\n').toLowerCase();
        const machine = [item.coffee_machine, item.coffee_machine_code].join('\n').toLowerCase();
        Object.defineProperty(item, '_ix', {
            enumerable: false,
            value: {
                id: stripZeros(item.id),
                mc: normalizeCode(item.coffee_machine_code),
                mcRaw: String(item.coffee_machine_code ?? '').toLowerCase().replace(/\s+/g, ''),
                name, machine, all: name + '\n' + machine
            }
        });
    }
    return item._ix;
}

function filterPoints(query, mode = searchMode) {
    const q = String(query || '').trim().toLowerCase();
    const isDigits = /^\d+$/.test(q);
    const num = stripZeros(q);

    // "0" или пустой запрос цифрами - показываем все
    if (isDigits && num === '') {
        const list = mode === 'machine'
            ? globalData.filter(i => i.coffee_machine_code || i.coffee_machine)
            : globalData;
        return [...list].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    }

    let results = globalData.filter(i => {
        const data = ix(i);
        
        // проверяем все возможные совпадения
        const matchId = isDigits && (data.id === num);
        const matchMachineCode = isDigits && (data.mc === num);
        const matchMachineRaw = data.mcRaw.includes(q);
        
        if (mode === 'machine') {
            return data.machine.includes(q) || matchMachineCode || matchMachineRaw;
        }
        if (mode === 'point') {
            return data.name.includes(q) || matchId;
        }
        
        // вежим "Все" ищем по тексту, ID точки, коду машины и части кода
        return data.all.includes(q) || matchId || matchMachineCode || matchMachineRaw;
    });

    // сортировка точные совпадения по номеру точки или коду машины всплывают наверх
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

// блок 7
// рендер карточек
// после фильтрации создаются карточки точек
// с данными по адресу, долгу и состоянию блокировки

function cardHtml(item, idx) {
    const lock = getPointLock(item);
    const blocked = lock && !isUnlimitedUser();
    const id = escapeHtml(item.id);
    
    const debt = Number(item.debt) || 0;
    const debtHtml = debt > 0 
        ? `<div class="info-item"><span class="debt-label">Борг</span><span class="debt-value red">${fmt(debt)} ₴</span></div>` 
        : `<div class="info-item"><span class="debt-label">Борг</span><span class="debt-value green">0 ₴</span></div>`;

    // ДОБАВЛЕНО: Формируем вывод оборудования ВМЕСТЕ С КОДОМ из 1С
    let machineDisplay = escapeHtml(item.coffee_machine) || '—';
    if (item.coffee_machine && item.coffee_machine_code) {
        machineDisplay += ` <span style="color:#94a3b8; font-size:0.85rem; white-space:nowrap;">[${escapeHtml(item.coffee_machine_code)}]</span>`;
    }

    return `
        <div class="point-card${lock ? ' locked' : ''}" style="--i:${idx}" data-rendered="1">
            <div class="point-header">
                <div>
                    <span class="point-title">${escapeHtml(item.point_name) || 'Без названия'}</span>
                    <span class="point-code" style="margin-left: 10px;">Код: ${id}</span>
                </div>
                ${blocked ? `<span class="lock-badge">🔒 Снято</span>` : ''}
            </div>
            
            <div class="point-grid">
                <div class="info-item"><label>Контрагент</label><span>${escapeHtml(item.counterparty) || '—'}</span></div>
                <div class="info-item"><label>Адрес</label><span>${escapeHtml(item.address) || '—'}</span></div>
                <div class="info-item"><label>Оборудование</label><span class="${item.coffee_machine ? 'machine-tag' : ''}">${escapeHtml(item.coffee_machine) || '—'}</span></div>
                
                <div class="info-item"><label>Код машины</label><span><code>${escapeHtml(item.coffee_machine_code) || '—'}</code></span></div>
                
                ${debtHtml}
            </div>

            <!-- Три кнопки внизу -->
            <div class="card-actions">
                <button class="action-btn" data-action="open" data-id="${id}" ${blocked ? 'disabled' : ''}>Показатели</button>
                <button class="action-btn btn-success" data-action="pay" data-id="${id}" ${debt > 0 ? '' : 'disabled'}>Оплата боргу</button>
                <button class="action-btn btn-secondary" data-action="btn2" data-id="${id}">Кнопка 2</button>
            </div>

            ${lock ? `
            <div class="lock-note">
                Показатели по этой точке уже внесены${lockTimeText(lock)}.${isUnlimitedUser() ? ' На вас лимит не распространяется.' : ' Для изменений позвоните в 1С.'}
                ${lock.pending ? '<br><b>Ожидает отправки в 1С (нет связи).</b>' : ''}
                ${isUnlimitedUser() && !lock.server ? `<br><button class="action-btn btn-secondary" style="margin-top:8px" data-action="unlock" data-id="${id}">Снять блок</button>` : ''}
            </div>` : ''}
        </div>`;
}

function appendCards(container, replace) {
    const start = renderedCount;
    const slice = lastResults.slice(start, start + PAGE_SIZE);
    renderedCount = start + slice.length;
    const remaining = lastResults.length - renderedCount;

    const html = slice.map((item, i) => cardHtml(item, i)).join('')
        + (remaining > 0
            ? `<div class="show-more-wrap"><button class="action-btn btn-secondary" data-action="more">Показать еще (${remaining})</button></div>`
            : '');

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

    const key = data.map(i => `${i.id}:${getPointLock(i) ? 1 : 0}`).join('|')
        + (isUnlimitedUser() ? '|u' : '') + '|' + searchMode;
    const first = container.firstElementChild;
    if (container.dataset.renderKey === key && first && first.hasAttribute('data-rendered')) return;
    container.dataset.renderKey = key;
    container.scrollTop = 0;

    lastResults = data;
    renderedCount = 0;

    if (data.length === 0) {
        container.innerHTML = `<div class="empty-state" data-rendered="1">${SEARCH_MODES[searchMode].empty}</div>`;
        return;
    }
    appendCards(container, true);
}

// блок 8
// модалки ввода показателей
// здесь пользователь вводит новые значения по ассортименту
// и проверяется корректность данных перед отправкой

function openMeterModal(pointId) {
    const item = globalData.find(i => String(i.id) === String(pointId));
    if (!item) return;
    if (isPointBlocked(item)) {
        showToast('По этой точке показатели уже сняты. Изменения — через 1С.', true);
        return;
    }
    rememberFocus();
    currentPointId = item.id;
    document.getElementById('modalTitle').textContent = `Точка: ${item.point_name}`;

    let assortmentHtml = '';
    if (item.assortment && item.assortment.length > 0) {
        assortmentHtml = item.assortment.map(drink => {
            const price = drink.price || 0;
            const lastMeter = drink.last_meter || 0;
            return `
                <div class="meter-input-group" data-drink-row style="margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px dashed #e2e8f0;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 6px; align-items: center;">
                        <strong class="drink-name" style="color: #0f172a; font-size: 0.95rem;">${escapeHtml(drink.name) || 'Без названия'}</strong>
                        <span style="font-size: 0.85rem; color: #64748b;">Цена: <strong>${fmt(price)} ₴</strong></span>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; align-items: flex-start;">
                        <div>
                            <label style="font-size: 0.75rem; color: #64748b;">Было</label>
                            <div style="font-weight: 600; padding: 8px 0;">${fmt(lastMeter)}</div>
                        </div>
                        <div>
                            <label style="font-size: 0.75rem; color: #64748b;">Новый счетчик</label>
                            <input type="number" inputmode="numeric" pattern="[0-9]*" class="meter-input" placeholder="0" value="${lastMeter}"
                                   data-price="${price}" data-last="${lastMeter}" oninput="calculateRowTotal(this)" onfocus="this.select()">
                        </div>
                        <div>
                            <label style="font-size: 0.75rem; color: #64748b;">Итого сумма</label>
                            <div class="row-total" style="font-weight: 700; color: #10b981; padding: 8px 0;">0 ₴</div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    } else {
        assortmentHtml = `<div class="empty-state" style="padding: 20px;">Для оборудования ассортимент не заполнен в 1С.</div>`;
    }

    document.getElementById('modalBody').innerHTML = `<div style="max-height: 50vh; overflow-y: auto; padding-right: 5px;">${assortmentHtml}</div>`;
    document.getElementById('modalOverlay').classList.add('active');

    const hasAssortment = Array.isArray(item.assortment) && item.assortment.length > 0;
    const proceedBtn = document.querySelector('#modalOverlay .modal-footer .action-btn');
    if (proceedBtn) proceedBtn.disabled = !hasAssortment;

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
        errorHint.textContent = 'Меньше предыдущего!';
        input.parentNode.appendChild(errorHint);
    }

    if (!isBlank && newVal < lastMeter) {
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

    const hasErrors = document.querySelectorAll('.meter-input.error').length > 0;
    const proceedBtn = document.querySelector('#modalOverlay .modal-footer .action-btn');
    if (proceedBtn) proceedBtn.disabled = hasErrors;
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
    if (!getTopModal()) restoreFocus();
}

// блок 9
// оплата долга
// здесь проверяется сумма оплаты и отправляется запрос на уменьшение долга

function openPaymentModal(pointId) {
    const item = globalData.find(i => String(i.id) === String(pointId));
    if (!item) return;
    rememberFocus();
    currentPaymentPointId = item.id;
    const debt = Number(item.debt) || 0;

    document.getElementById('paymentPointName').textContent = item.point_name || 'Без названия';
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
    currentPaymentPointId = null;
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
        errorBox.textContent = 'Сумма должна быть больше нуля';
        errorBox.style.display = 'block';
        return;
    }
    if (amount > currentDebt) {
        errorBox.textContent = `Сумма не может превышать текущий борг (${fmt(currentDebt)} ₴)`;
        errorBox.style.display = 'block';
        return;
    }
    if (!navigator.onLine) {
        errorBox.textContent = 'Нет сети! Оплату можно провести только онлайн.';
        errorBox.style.display = 'block';
        return;
    }

    const btn = document.querySelector('#paymentOverlay .btn-success');
    const cancelBtn = document.querySelector('#paymentOverlay .btn-secondary');
    cancelBtn.disabled = true;
    setBtnLoading(btn, 'Отправка...');
    errorBox.style.display = 'none';

    const payload = {
        point_id: pointId,
        technician_id: currentUser ? currentUser.id : '',
        amount,
        request_id: newRequestId()
    };

    try {
        const response = await postPayment(payload);
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(errText.slice(0, 150) || 'Ошибка сервера 1С');
        }

        item.debt = Math.max(0, currentDebt - amount);
        try { await localDB.save('cachedNomenclature', globalData); } catch (e) {}

        showSuccessAnimation();
        showToast(`Оплата ${fmt(amount)} ₴ успешно проведена!`);
        closePaymentModal();
        refreshResults();
        loadData({ silent: true });

    } catch (error) {
        if (error.message.includes('Failed to fetch') || error.message.includes('timeout')) {
            errorBox.textContent = '1С не отвечает. Проверьте интернет и попробуйте снова.';
        } else {
            errorBox.textContent = `Не удалось провести: ${error.message}`;
        }
        errorBox.style.display = 'block';
    } finally {
        resetBtn(btn, 'Провести оплату');
        cancelBtn.disabled = false;
    }
}

// блок 10
// отправка показателей
// формируется запрос на сохранение данных и выполняется
// обычная или офлайн отправка в 1с

async function applyDebtDelta(pointId, delta) {
    if (!delta) return;
    const item = globalData.find(i => String(i.id) === String(pointId));
    if (!item) return;
    item.debt = (Number(item.debt) || 0) + delta;
    try { await localDB.save('cachedNomenclature', globalData); }
    catch (e) { console.warn('не сохранили кэш долга', e); }
}

async function submitMeters() {
    const pointId = currentPointId;
    const currentItem = globalData.find(i => String(i.id) === String(pointId));
    if (currentItem && isPointBlocked(currentItem)) {
        showToast('По этой точке показатели уже сняты. Изменения — через 1С.', true);
        finishSubmission();
        return;
    }

    const rows = document.querySelectorAll('#modalBody [data-drink-row]');
    const metersData = [];
    let sessionTotal = 0;

    rows.forEach(row => {
        const name = row.querySelector('.drink-name').textContent.trim();
        const price = Number(row.querySelector('.meter-input').getAttribute('data-price')) || 0;
        const value = Number(row.querySelector('.meter-input').value) || 0;
        const lastMeter = Number(row.querySelector('.meter-input').getAttribute('data-last')) || 0;
        const delta = value - lastMeter;

        if (name) {
            const itemTotal = delta > 0 ? delta * price : 0;
            sessionTotal += itemTotal;
            metersData.push({ name, price, value, delta: delta > 0 ? delta : 0, total: itemTotal });
        }
    });

    const payload = {
        point_id: pointId,
        technician_id: currentUser ? currentUser.id : "",
        request_id: newRequestId(),
        meters: metersData
    };

    const confirmBtn = document.querySelector('#confirmOverlay .btn-success');
    if (!confirmBtn) return;
    setBtnLoading(confirmBtn, 'Отправка...');

    if (!navigator.onLine) {
        saveOffline(payload);
        await applyDebtDelta(pointId, sessionTotal);
        finishSubmission();
        refreshResults();
        resetBtn(confirmBtn, 'Отправить в 1С');
        return;
    }

    try {
        const response = await postMeters(payload);

        if (response.status === 409) {
            lockPoint(pointId);
            showToast('По этой точке показатели уже внесены. Для изменений звоните в 1С.', true);
            finishSubmission();
            refreshResults();
            return;
        }
        if (!response.ok) throw new Error(await response.text() || 'Ошибка сервера 1С');

        // ответ 1С: { ok, sum, debt_error }
        let body = null;
        try { body = await response.json(); } catch (e) {}

        lockPoint(pointId);

        if (body && body.debt_error) {
            // документ создан, но долг в регистре не записался
            console.error('[1С] долг не начислен:', body.debt_error);
            showToast('Документ создан, но ДОЛГ НЕ НАЧИСЛЕН: ' + String(body.debt_error).slice(0, 150), true);
        } else {
            await applyDebtDelta(pointId, sessionTotal);
            showSuccessAnimation();
            showToast('Документ в 1С успешно создан!');
        }

        finishSubmission();
        loadData({ silent: true });

    } catch (error) {
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            saveOffline(payload);
            await applyDebtDelta(pointId, sessionTotal);
            finishSubmission();
            refreshResults();
        } else {
            showToast(`Ошибка: ${error.message}`, true);
        }
    } finally {
        resetBtn(confirmBtn, 'Отправить в 1С');
    }
}

function finishSubmission() {
    closeConfirmModal();
    closeModal();
    currentPointId = null;

    const searchInput = document.getElementById('searchInput');
    const searchContainer = document.getElementById('searchContainer');
    const resultsContainer = document.getElementById('resultsContainer');
    if (searchInput) searchInput.value = '';
    if (searchContainer) {
        searchContainer.classList.remove('top');
        searchContainer.classList.add('center');
    }
    if (resultsContainer) {
        resultsContainer.classList.remove('active');
        resultsContainer.innerHTML = '';
        delete resultsContainer.dataset.renderKey;
    }
    isAtTop = false;

    if (AUTO_LOGOUT_AFTER_SUBMIT && typeof logout === 'function') logout();
}

function setBtnLoading(btn, text) {
    btn.disabled = true;
    btn.dataset.originalText = btn.textContent;
    btn.textContent = text;
    btn.classList.add('btn-loading');
}
function resetBtn(btn, text) {
    btn.disabled = false;
    btn.textContent = text;
    btn.classList.remove('btn-loading');
}

// блок 11
// офлайн очередь
// если связь пропадает данные сохраняются локально
// и потом отправляются автоматически при восстановлении соединения

function saveOffline(payload) {
    const offlineQueue = readQueue();
    offlineQueue.push(payload);
    localStorage.setItem('offlineMetersQueue', JSON.stringify(offlineQueue));
    lockPoint(payload.point_id, true);
    showToast('Нет связи с 1С. Сохранено на устройстве, отправим автоматически.', true);
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
        if (manual) showToast('Отправка уже идет...');
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

async function runSync({ manual, quiet }) {
    const queue = readQueue();
    if (queue.length === 0) return;

    if (queue.some(p => !p.request_id)) {
        queue.forEach(p => { if (!p.request_id) p.request_id = newRequestId(); });
        localStorage.setItem('offlineMetersQueue', JSON.stringify(queue));
    }

    if (!quiet) showToast(`Отправка записей из очереди: ${queue.length}...`);
    const done = new Set();
    let netFail = false;
    let serverError = '';

    for (const payload of queue) {
        try {
            const response = await postMeters(payload);
            if (response.ok || response.status === 409) {
                markSynced(payload.point_id);
                done.add(payload.request_id);
                setConnectionStatus(true);
            } else {
                const body = (await response.text().catch(() => '')).slice(0, 120);
                serverError = `1С ответила ${response.status}${body ? ': ' + body : ''}`;
                console.warn('[sync] ошибка сервера:', response.status, body, payload);
            }
        } catch (err) {
            netFail = true;
            console.warn('[sync] нет связи с 1С:', err.message);
            setConnectionStatus(false);
            break;
        }
    }

    const rest = readQueue().filter(p => !done.has(p.request_id));
    if (rest.length) localStorage.setItem('offlineMetersQueue', JSON.stringify(rest));
    else localStorage.removeItem('offlineMetersQueue');

    lastSyncError = rest.length ? (netFail ? 'нет связи с 1С' : serverError) : '';
    if (done.size) retryAttempt = 0;

    if (done.size && rest.length === 0) {
        showToast('Все записи из очереди отправлены в 1С.');
        loadData({ silent: true });
    } else if (done.size) {
        showToast(`Отправлено: ${done.size}, осталось: ${rest.length}`, true);
    } else if (rest.length && !quiet) {
        showToast(`Не отправлено: ${rest.length}. ${lastSyncError || 'нет связи с 1С'}`, true);
    }
}

// блок 12
// уведомления и статус
// здесь показываются сообщения о результате действий
// и текущем состоянии соединения с 1с

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

    let timeText = '';
    if (lastLoadedAt) {
        const sec = Math.floor((Date.now() - lastLoadedAt) / 1000);
        timeText = sec < 5 ? 'только что'
            : sec < 60 ? `${sec} сек назад`
            : sec < 3600 ? `${Math.floor(sec / 60)} мин назад`
            : `${Math.floor(sec / 3600)} ч назад`;
    }

    const key = `${connectionOnline}|${queued}|${lastSyncError}|${timeText}|${isLoading ? 1 : 0}`;
    _lastStatusKey = key;

    box.className = 'connection-status'
        + (connectionOnline === true ? ' online' : connectionOnline === false ? ' offline' : '')
        + (queued ? ' has-queue' : '')
        + (isLoading ? ' syncing' : '');

    let text = connectionOnline === null ? 'Проверка связи...'
        : connectionOnline ? '1С подключена' : 'Нет связи с 1С';
    if (queued) text += ` · Не отправлено: ${queued}`;

    const textEl = box.querySelector('.status-text');
    if (textEl) textEl.textContent = text;

    const timeEl = box.querySelector('.status-time');
    if (timeEl) timeEl.textContent = timeText;

    box.title = 'Нажмите для обновления' + (lastSyncError ? ` (${lastSyncError})` : '');
}

// блок 13
// блокировка точек
// после успешного внесения показателей точка становится недоступной
// для повторного ввода до истечения лимита или до сброса админом

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
}

function markSynced(pointId) {
    const locks = getLocks();
    const lock = locks[String(pointId)];
    if (lock) { lock.pending = false; saveLocks(locks); }
}

function getPointLock(item) {
    const id = String(item.id);
    const locks = getLocks();
    let local = locks[id] || null;

    if (local && !local.pending && local.until <= Date.now()) {
        delete locks[id];
        saveLocks(locks);
        local = null;
    }

    if (serverDataFresh && typeof item.locked === 'boolean') {
        if (item.locked) return { server: true, at: item.locked_at || null };
        if (local && !local.pending) {
            delete locks[id];
            saveLocks(locks);
            local = null;
        }
    }
    return local;
}

function isUnlimitedUser() {
    return !!currentUser && UNLIMITED_USER_IDS.includes(String(currentUser.id));
}

function isPointBlocked(item) {
    return !!getPointLock(item) && !isUnlimitedUser();
}

function lockTimeText(lock) {
    if (!lock.at) return '';
    if (typeof lock.at === 'number') {
        const t = new Date(lock.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        return ` в ${t}`;
    }
    return ` (${lock.at})`;
}

function unlockTimeText(lock) {
    if (!lock || lock.pending || lock.server) return '';
    if (!lock.until || lock.until <= Date.now()) return '';

    const until = new Date(lock.until);
    const hh = String(until.getHours()).padStart(2, '0');
    const mm = String(until.getMinutes()).padStart(2, '0');

    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    let dayLabel;
    if (until.toDateString() === today.toDateString()) dayLabel = 'сегодня';
    else if (until.toDateString() === tomorrow.toDateString()) dayLabel = 'завтра';
    else dayLabel = until.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

    return `${dayLabel} в ${hh}:${mm}`;
}

function adminUnlock(pointId) {
    if (!isUnlimitedUser()) return;
    const locks = getLocks();
    delete locks[String(pointId)];
    saveLocks(locks);
    showToast('Локальная блокировка снята');
    const searchInput = document.getElementById('searchInput');
    if (searchInput && searchInput.value.trim() !== '') {
        handleSearch({ target: { value: searchInput.value } });
    }
}

// блок 14
// сброс при выходе
// здесь очищается пользовательское состояние
// и интерфейс чтобы следующий вход не оставлял лишних данных

function resetAppState() {
    globalData = [];
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
    currentPaymentPointId = null;
    isAtTop = false;
    _lastStatusKey = '';
    clearTimeout(searchTimer);
    cancelAnimationFrame(renderFrame);
    clearTimeout(retryTimer);
    clearTimeout(toastTimer);
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

// блок 15
// esc и фокус модалок
// здесь обеспечивается корректная работа клавиатуры и возврат фокуса
// после закрытия окна

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getTopModal() {
    const modals = Array.from(document.querySelectorAll('.modal-overlay.active'));
    if (!modals.length) return null;
    return modals.reduce((top, m) => {
        const z = Number(m.style.zIndex) || 0;
        const topZ = top ? (Number(top.style.zIndex) || 0) : -1;
        return z > topZ ? m : top;
    }, null);
}

function closeTopModal() {
    const m = getTopModal();
    if (!m) return;
    if (m.id === 'modalOverlay') closeModal();
    else if (m.id === 'confirmOverlay') closeConfirmModal();
    else if (m.id === 'paymentOverlay') closePaymentModal();
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
    const focusables = Array.from(box.querySelectorAll(FOCUSABLE)).filter(el => el.offsetParent !== null);
    if (focusables.length) focusables[0].focus();
}

// блок 16
// автообновление и ручное обновление
// периодически обновляются данные и синхронизируется очередь
// при необходимости пользователь может обновить их вручную

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
    const box = document.getElementById('connectionStatus');
    if (box) box.classList.add('syncing');
    retryAttempt = 0;
    try {
        if (readQueue().length) await syncOfflineMeters({ manual: true });
        await loadData({ silent: false });
    } finally {
        if (box) setTimeout(() => box.classList.remove('syncing'), 400);
    }
}
