const GOODS_MIN_QUERY = 1;

let goodsRendered = false;
let goodsCurrentParent = '';
let goodsSearchSeq = 0;
let goodsTimer = null;
let goodsAbortController = null;
const goodsSearchCache = new Map(); // кэш предыдущих поисковых фраз

function goodsUrl(params) {
    const u = currentUser ? encodeURIComponent(currentUser.id) : '';
    const extra = Object.keys(params)
        .map(k => `&${k}=${encodeURIComponent(params[k])}`)
        .join('');
    return `${apiBase}/goods?u=${u}${extra}&t=${Date.now()}`;
}

async function goodsFetch(params) {
    const res = await fetchWithTimeout(
        goodsUrl(params),
        { method: 'GET', cache: 'no-store' },
        APP_CONFIG.loadTimeoutMs
    );
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error((t && t.slice(0, 160)) || 'Помилка мережі');
    }
    return res.json();
}

const goodsSkeleton = `
    <div class="assort-loading" style="padding: 12px 16px;">
        <div class="skeleton skeleton-text" style="width:70%;"></div>
        <div class="skeleton skeleton-text" style="width:90%;"></div>
        <div class="skeleton skeleton-text" style="width:55%;"></div>
    </div>
`;

// цена товара: "45,00 ₴"; если цены нет, ничего не показываем
function goodsPriceHtml(it) {
    const p = Number(it.price);
    if (!p || p <= 0) return '';
    const txt = p.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `<span class="dg-price">${escapeHtml(txt)} ₴</span>`;
}

function goodsIconMarkup(kind) {
    const paths = kind === 'folder'
        ? '<path d="M3.5 7h6l2 2h9v9.5a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 18.5V7Z"/><path d="M3.5 9h17"/>'
        : '<path d="M6 8h11v8a4 4 0 0 1-4 4h-3a4 4 0 0 1-4-4V8Z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 4c0 1 1 1 1 2M12 4c0 1 1 1 1 2"/>';
    return `<svg class="dg-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// одна строка товара (общая для дерева и для поиска)
function goodsItemHtml(it) {
    const rawName = String(it.name || '').trim();
    const displayName = rawName.length ? rawName : 'Позиція без назви';
    const rawCode = String(it.code || '').trim();
    const cleanCode = rawCode.replace(/\s+/g, '');

    return `
        <div class="dg-row dg-item" data-id="${escapeHtml(it.id)}" data-type="item">
            <div class="dg-item-icon">${goodsIconMarkup('product')}</div>
            <div class="dg-item-info">
                <span class="dg-name${rawName ? '' : ' unnamed'}">${escapeHtml(displayName)}</span>
                ${goodsPriceHtml(it)}
            </div>
            ${cleanCode ? `
                <button type="button" class="dg-code-chip" data-copy="${escapeHtml(cleanCode)}" title="Натисніть, щоб скопіювати">
                    <span class="dg-code-prefix">код</span>
                    <span class="dg-code-val">${escapeHtml(cleanCode)}</span>
                </button>
            ` : ''}
        </div>
    `;
}

function goodsErrorHtml(err, withRetry) {
    const message = err && err.message ? err.message : String(err);
    return `
        <div class="dg-error">
            Не вдалося завантажити: ${escapeHtml(message)}
            ${withRetry ? '<button type="button" class="dg-retry">Повторити</button>' : ''}
        </div>
    `;
}

// каркас
function initDrawerGoods() {
    const host = document.getElementById('drawerGoods');
    if (!host || host.dataset.ready) return;
    host.dataset.ready = '1';

    host.innerHTML = `
        <div class="dg-title">Номенклатура</div>
        <div class="dg-search">
            <input type="search" id="goodsSearch" autocomplete="off"
                placeholder="Пошук за назвою або кодом" aria-label="Пошук номенклатури">
        </div>
        <div class="dg-nav" id="goodsNav"></div>
        <div id="goodsList"></div>
    `;

    // привязываем поиск с дебаунсом
    const searchInput = host.querySelector('#goodsSearch');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(goodsTimer);
            goodsTimer = setTimeout(goodsOnSearch, 250);
        });
    }

    // обработка кликов по списку
    host.querySelector('#goodsList').addEventListener('click', e => {
        // копирование кода по клику
        const chip = e.target.closest('.dg-code-chip');
        if (chip) {
            e.stopPropagation();
            const code = chip.dataset.copy;
            if (code && navigator.clipboard) {
                navigator.clipboard.writeText(code).then(() => {
                    if (typeof showToast === 'function') showToast(`Код скопійовано: ${code}`);
                }).catch(() => {});
            }
            return;
        }

        if (e.target.closest('.dg-retry')) {
            loadGoodsLevel(goodsCurrentParent);
            return;
        }

        const row = e.target.closest('.dg-row');
        if (!row) return;
        if (row.dataset.type === 'folder') {
            loadGoodsLevel(row.dataset.id);
        }
    });

    // кнопка назад по папкам
    host.querySelector('#goodsNav').addEventListener('click', e => {
        const back = e.target.closest('.dg-back');
        if (!back) return;
        loadGoodsLevel(back.dataset.id || '');
    });
}

// вызывается во время открытия боковой панели, чтобы обновить содержимое
function refreshDrawerGoods() {
    initDrawerGoods();

    const input = document.getElementById('goodsSearch');
    if (input && input.value.trim().length >= GOODS_MIN_QUERY) return;
    if (goodsRendered) return;

    loadGoodsLevel('');
}

// загрузка дерева
async function loadGoodsLevel(parentId) {
    const box = document.getElementById('goodsList');
    const navBox = document.getElementById('goodsNav');
    if (!box) return;

    goodsCurrentParent = parentId || '';
    goodsRendered = false;
    box.innerHTML = goodsSkeleton;

    try {
        const data = await goodsFetch({ parent: goodsCurrentParent });
        renderGoodsNav(Array.isArray(data.breadcrumb) ? data.breadcrumb : []);
        renderGoodsItems(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
        if (navBox) navBox.innerHTML = '';
        box.innerHTML = goodsErrorHtml(err, true);
    }
}

// назад
function renderGoodsNav(breadcrumb) {
    const navBox = document.getElementById('goodsNav');
    if (!navBox) return;

    if (!breadcrumb.length) {
        navBox.innerHTML = '<div class="dg-nav-title">Всі товари</div>';
        return;
    }

    const prevId = breadcrumb.length >= 2 ? breadcrumb[breadcrumb.length - 2].id : '';
    const current = breadcrumb[breadcrumb.length - 1];

    navBox.innerHTML = `
        <button type="button" class="dg-back" data-id="${escapeHtml(prevId)}" aria-label="Назад">←</button>
        <div class="dg-nav-title">${escapeHtml(current.name)}</div>
    `;
}

// рендер эл папки
function renderGoodsItems(items) {
    const box = document.getElementById('goodsList');
    if (!box) return;
    goodsRendered = true;

    if (!items.length) {
        box.innerHTML = '<div class="dg-note">Тут поки нічого немає</div>';
        return;
    }

    // Разделяем папки и товары, чтобы папки всегда шли сверху
    const folders = items.filter(it => it.type === 'folder');
    const products = items.filter(it => it.type !== 'folder');

    let html = '';

    if (folders.length) {
        html += `<div class="dg-section-label">Папки</div>`;
        html += folders.map(it => `
            <button type="button" class="dg-row dg-folder" data-id="${escapeHtml(it.id)}" data-type="folder">
                <div class="dg-folder-badge">${goodsIconMarkup('folder')}</div>
                <span class="dg-name">${escapeHtml(it.name || 'Без назви')}</span>
                <span class="dg-chev">›</span>
            </button>
        `).join('');
    }

    if (products.length) {
        if (folders.length) {
            html += `<div class="dg-section-label" style="margin-top: 14px;">Товари (${products.length})</div>`;
        }
        html += products.map(goodsItemHtml).join('');
    }

    box.innerHTML = html;
}

// поиск по номенклатуре
async function goodsOnSearch() {
    const input = document.getElementById('goodsSearch');
    const box = document.getElementById('goodsList');
    const navBox = document.getElementById('goodsNav');
    if (!input || !box) return;

    const q = input.value.trim();
    const seq = ++goodsSearchSeq;

    if (q.length < GOODS_MIN_QUERY) {
        if (navBox) navBox.style.display = '';
        if (goodsAbortController) goodsAbortController.abort();
        loadGoodsLevel(goodsCurrentParent);
        return;
    }

    if (navBox) navBox.style.display = 'none';

    // мгновенная отдача из кэша, если эту строку уже искали
    if (goodsSearchCache.has(q)) {
        const cached = goodsSearchCache.get(q);
        renderGoodsSearchResults(cached.items, cached.truncated);
        return;
    }

    box.innerHTML = goodsSkeleton;

    // отменяем предыдущий незаконченный HTTP-запрос
    if (goodsAbortController) {
        goodsAbortController.abort();
    }
    goodsAbortController = new AbortController();

    try {
        const url = goodsUrl({ q });
        const res = await fetch(url, {
            method: 'GET',
            cache: 'no-store',
            signal: goodsAbortController.signal
        });

        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error((t && t.slice(0, 300)) || ('HTTP ' + res.status));
        }
        const data = await res.json();

        if (seq !== goodsSearchSeq) return;

        const items = Array.isArray(data.items) ? data.items : [];
        goodsSearchCache.set(q, { items, truncated: !!data.truncated });

        renderGoodsSearchResults(items, !!data.truncated);
        goodsRendered = false;
    } catch (err) {
        if (err.name === 'AbortError') return; // игнорируем штатную отмену
        if (seq !== goodsSearchSeq) return;
        box.innerHTML = goodsErrorHtml(err, false);
    }
}

function renderGoodsSearchResults(items, truncated) {
    const box = document.getElementById('goodsList');
    if (!box) return;

    if (!items.length) {
        box.innerHTML = '<div class="dg-note">Нічого не знайдено</div>';
        return;
    }

    const countHeader = `<div class="dg-section-label">Знайдено: ${items.length}${truncated ? '+' : ''}</div>`;
    const rows = items.map(goodsItemHtml).join('');

    const note = truncated
        ? `<div class="dg-note" style="padding: 16px 12px; font-size: 0.8rem;">Показано перші ${items.length}. Уточніть запит для точного пошуку.</div>`
        : '';

    box.innerHTML = countHeader + rows + note;
}