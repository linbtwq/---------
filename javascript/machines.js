// javascript/machines.js
// раскрывающийся inline-блок остатков под карточкой точки (без модалки)
//
// состояние одного активного блока: держим его в памяти,
// при клике на другую карточку закрываем предыдущий
// и открываем новый — иначе фильтры/поиск запутаются

let _me = null;
// _me = { pointId, card, box, data, query, filter, sort }
let _meLoading = false;

async function toggleMachineExpand(pointId) {
    const pid = String(pointId);
    // ищем карточку в любом режиме (Всі / Точка / Машина)
    const card = Array
        .from(document.querySelectorAll('.point-card'))
        .find(el => el.dataset.id === pid);

    if (!card) return;

    // клик по той же карточке — закрываем
    if (_me && _me.pointId === pid) {
        closeMachineExpand();
        return;
    }

    // была открыта другая — закрываем её
    if (_me) closeMachineExpand();

    const box = card.querySelector('.machine-expand');
    if (!box) return;

    box.hidden = false;
    card.classList.add('machine-card-open');
    box.innerHTML = `
        <div class="mt-loading">
            <div class="skeleton skeleton-text" style="width:70%;"></div>
            <div class="skeleton skeleton-text" style="width:90%;"></div>
            <div class="skeleton skeleton-text" style="width:55%;"></div>
        </div>
    `;

    _me = {
        pointId: pid,
        card,
        box,
        data: [],
        query: '',
        filter: 'all',
        sort: 'name'
    };

    if (_meLoading) return;
    _meLoading = true;

    try {
        const u = currentUser ? encodeURIComponent(currentUser.id) : '';
        const res = await fetchWithTimeout(
            `${apiBase}/machines?u=${u}&t=${Date.now()}`,
            { method: 'GET', cache: 'no-store' },
            APP_CONFIG.loadTimeoutMs
        );

        if (!res.ok) throw new Error('Помилка мережі');
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Невірна відповідь 1С');

        // пользователь мог закрыть блок или открыть другой, пока шёл запрос
        if (!_me || _me.pointId !== pid) return;

        if (data.length === 1 && String(data[0].Code) === '0') {
            box.innerHTML = `<div class="empty-state" style="padding:24px 16px;">${escapeHtml(data[0].Name)}</div>`;
            return;
        }

        if (!data.length) {
            box.innerHTML = `<div class="empty-state" style="padding:24px 16px;">Залишки відсутні</div>`;
            return;
        }

        _me.data = data;
        renderMachineExpand();

    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (_me && _me.pointId === pid) {
            box.innerHTML = `<div class="assort-error" style="margin:0;">Не вдалося завантажити: ${escapeHtml(message)}</div>`;
        }
    } finally {
        _meLoading = false;
    }
}

function closeMachineExpand() {
    if (!_me) return;

    const { card, box } = _me;
    box.hidden = true;
    box.innerHTML = '';
    box.removeAttribute('data-ready');
    if (card) card.classList.remove('machine-card-open');

    _me = null;
}

// первичный рендер: тулбар (поиск/чипы/сортировка) + список
function renderMachineExpand() {
    if (!_me) return;
    const { box, data } = _me;

    const total   = data.length;
    const cntIn   = data.filter(it => (Number(it.quantity) || 0) > 0).length;
    const cntZero = data.filter(it => (Number(it.quantity) || 0) === 0).length;
    const cntNeg  = data.filter(it => (Number(it.quantity) || 0) < 0).length;

    box.innerHTML = `
        <div class="machines-toolbar">
            <div class="machines-search-wrap">
                <input
                    type="search"
                    class="machines-search"
                    placeholder="Пошук товару за назвою або кодом..."
                    autocomplete="off"
                    data-me="search"
                >
            </div>

            <div class="machines-filters" data-me="filters">
                <button type="button" class="mf-chip active" data-filter="all">Всі<span class="mf-chip-count">${total}</span></button>
                <button type="button" class="mf-chip" data-filter="in">В наявності<span class="mf-chip-count">${cntIn}</span></button>
                <button type="button" class="mf-chip" data-filter="zero">Немає<span class="mf-chip-count">${cntZero}</span></button>
                <button type="button" class="mf-chip" data-filter="neg">Від'ємні<span class="mf-chip-count">${cntNeg}</span></button>
            </div>

            <div class="machines-sort">
                <span class="machines-sort-label">Сортування</span>
                <div class="machines-sort-control">
                    <button type="button" class="machines-sort-select" data-me="sort-btn" aria-haspopup="listbox" aria-expanded="false">
                        <span data-me="sort-value">За назвою (А–Я)</span>
                        <svg class="machines-sort-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
                    </button>
                    <div class="machines-sort-menu" data-me="sort-menu" role="listbox" hidden>
                        <button type="button" class="machines-sort-option active" role="option" aria-selected="true" data-sort="name">За назвою (А–Я)</button>
                        <button type="button" class="machines-sort-option" role="option" aria-selected="false" data-sort="qty_desc">Спочатку більше</button>
                        <button type="button" class="machines-sort-option" role="option" aria-selected="false" data-sort="qty_asc">Спочатку менше</button>
                        <button type="button" class="machines-sort-option" role="option" aria-selected="false" data-sort="price_desc">Дорожче спочатку</button>
                        <button type="button" class="machines-sort-option" role="option" aria-selected="false" data-sort="price_asc">Дешевше спочатку</button>
                    </div>
                </div>
            </div>
        </div>

        <div data-me="list"></div>
    `;

    // поиск
    const searchInput = box.querySelector('[data-me="search"]');
    searchInput.addEventListener('input', () => {
        _me.query = searchInput.value.trim().toLowerCase();
        renderMachineList();
    });

    // чипы фильтра
    const filtersBox = box.querySelector('[data-me="filters"]');
    filtersBox.addEventListener('click', (e) => {
        const chip = e.target.closest('.mf-chip');
        if (!chip) return;
        _me.filter = chip.dataset.filter;
        filtersBox.querySelectorAll('.mf-chip').forEach(c => c.classList.toggle('active', c === chip));
        renderMachineList();
    });

    // сортировка
    const sortBtn   = box.querySelector('[data-me="sort-btn"]');
    const sortMenu  = box.querySelector('[data-me="sort-menu"]');
    const sortValue = box.querySelector('[data-me="sort-value"]');

    const closeSortMenu = (restoreFocus = false) => {
        sortMenu.hidden = true;
        sortBtn.setAttribute('aria-expanded', 'false');
        if (restoreFocus) sortBtn.focus();
    };
    const openSortMenu = () => {
        sortMenu.hidden = false;
        sortBtn.setAttribute('aria-expanded', 'true');
    };

    sortBtn.addEventListener('click', () => {
        if (sortMenu.hidden) openSortMenu();
        else closeSortMenu();
    });

    sortMenu.addEventListener('click', (e) => {
        const option = e.target.closest('.machines-sort-option');
        if (!option) return;
        _me.sort = option.dataset.sort;

        sortMenu.querySelectorAll('.machines-sort-option').forEach(item => {
            const selected = item === option;
            item.classList.toggle('active', selected);
            item.setAttribute('aria-selected', String(selected));
        });
        sortValue.textContent = option.textContent;
        closeSortMenu(true);
        renderMachineList();
    });

    // клик снаружи меню сортировки — закрыть
    box.addEventListener('click', (e) => {
        if (!e.target.closest('.machines-sort-control')) closeSortMenu();
    });

    renderMachineList();
}

// рендер только списка — при фильтрации/поиске/сортировке
function renderMachineList() {
    if (!_me) return;
    const listBox = _me.box.querySelector('[data-me="list"]');
    if (!listBox) return;

    let list = _me.data.slice();

    if (_me.filter === 'in')   list = list.filter(it => (Number(it.quantity) || 0) > 0);
    if (_me.filter === 'zero') list = list.filter(it => (Number(it.quantity) || 0) === 0);
    if (_me.filter === 'neg')  list = list.filter(it => (Number(it.quantity) || 0) < 0);

    if (_me.query) {
        list = list.filter(it => {
            const name = String(it.Name || '').toLowerCase();
            const code = String(it.Code || '').toLowerCase();
            return name.includes(_me.query) || code.includes(_me.query);
        });
    }

    if (_me.sort === 'name') {
        list.sort((a, b) => String(a.Name || '').localeCompare(String(b.Name || ''), 'uk'));
    } else if (_me.sort === 'qty_desc') {
        list.sort((a, b) => (Number(b.quantity) || 0) - (Number(a.quantity) || 0));
    } else if (_me.sort === 'qty_asc') {
        list.sort((a, b) => (Number(a.quantity) || 0) - (Number(b.quantity) || 0));
    } else if (_me.sort === 'price_desc') {
        list.sort((a, b) => (Number(b.price) || 0) - (Number(a.price) || 0));
    } else if (_me.sort === 'price_asc') {
        list.sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
    }

    if (!list.length) {
        listBox.innerHTML = `<div class="empty-state" style="padding:24px 16px;">Нічого не знайдено</div>`;
        return;
    }

    let sumQty = 0;
    let sumMoney = 0;
    list.forEach(it => {
        const q = Number(it.quantity) || 0;
        const p = Number(it.price) || 0;
        sumQty += q;
        sumMoney += q * p;
    });

    listBox.innerHTML = `
        <div class="mt-list">
            ${list.map((it, index) => {
                const qty = Number(it.quantity) || 0;
                const price = Number(it.price) || 0;
                const code = it.Code ? String(it.Code) : '';
                const cls = qty > 0 ? 'has' : (qty < 0 ? 'neg' : 'zero');
                const priceHtml = price > 0 ? `<div class="mt-row-price">${fmt(price)} ₴</div>` : '';
                return `
                    <div class="mt-row mt-row-${cls}" style="--machine-row-index:${Math.min(index, 7)}">
                        <div class="mt-row-main">
                            <div class="mt-row-name">${escapeHtml(it.Name || '—')}</div>
                            ${code ? `<div class="mt-row-code">код ${escapeHtml(code)}</div>` : ''}
                        </div>
                        <div class="mt-row-side">
                            ${priceHtml}
                            <div class="mt-row-qty ${cls}">${fmt(qty)}</div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>

        <div class="mt-summary">
            <div class="mt-summary-row">
                <span>Всього на складі:</span>
                <b>${fmt(sumQty)}</b>
            </div>
            <div class="mt-summary-row">
                <span>Сума за цінами:</span>
                <b>${fmt(sumMoney)} ₴</b>
            </div>
        </div>
    `;
}