

const GOODS_MIN_QUERY = 2;

let goodsRendered = false;
let goodsCurrentParent = '';
let goodsSearchSeq = 0;
let goodsTimer = null;

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

    host.querySelector('#goodsList').addEventListener('click', e => {
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
                <div class="dg-folder-badge">📁</div>
                <span class="dg-name">${escapeHtml(it.name || 'Без назви')}</span>
                <span class="dg-chev">›</span>
            </button>
        `).join('');
    }

    if (products.length) {
        if (folders.length) {
            html += `<div class="dg-section-label" style="margin-top: 14px;">Товари (${products.length})</div>`;
        }
        html += products.map(it => {
            const rawName = String(it.name || '').trim();
            const displayName = rawName.length ? rawName : 'Позиція без назви';
            const rawCode = String(it.code || '').trim();
            const cleanCode = rawCode.replace(/\s+/g, '');

            return `
                <div class="dg-row dg-item" data-id="${escapeHtml(it.id)}" data-type="item">
                    <div class="dg-item-icon">☕</div>
                    <div class="dg-item-info">
                        <span class="dg-name${rawName ? '' : ' unnamed'}">${escapeHtml(displayName)}</span>
                    </div>
                    ${cleanCode ? `
                        <button type="button" class="dg-code-chip" data-copy="${escapeHtml(cleanCode)}" title="Натисніть, щоб скопіювати">
                            <span class="dg-code-prefix">код</span>
                            <span class="dg-code-val">${escapeHtml(cleanCode)}</span>
                        </button>
                    ` : ''}
                </div>
            `;
        }).join('');
    }

    box.innerHTML = html;
}

// Пошук формує плаский список результатів
async function goodsOnSearch() {
    const input = document.getElementById('goodsSearch');
    const box = document.getElementById('goodsList');
    const navBox = document.getElementById('goodsNav');
    if (!input || !box) return;

    const q = input.value.trim();
    const seq = ++goodsSearchSeq;

    if (q.length < GOODS_MIN_QUERY) {
        if (navBox) navBox.style.display = '';
        loadGoodsLevel(goodsCurrentParent);
        return;
    }

    if (navBox) navBox.style.display = 'none';
    box.innerHTML = goodsSkeleton;

    try {
        const data = await goodsFetch({ q });
        if (seq !== goodsSearchSeq) return;

        const items = Array.isArray(data.items) ? data.items : [];
        renderGoodsSearchResults(items, !!data.truncated);
        goodsRendered = false;
    } catch (err) {
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

    const rows = items.map(it => `
        <div class="dg-row dg-item" data-id="${escapeHtml(it.id)}" data-type="item">
            <span class="dg-name">${escapeHtml(it.name)}</span>
            <span class="dg-code">${escapeHtml(it.code || '')}</span>
        </div>
    `).join('');

    const note = truncated
        ? `<div class="dg-note">Показано перші ${items.length}. Уточніть пошук.</div>`
        : '';

    box.innerHTML = rows + note;
}