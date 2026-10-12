// модалка залишків по точці

let machinesLoading = false;
let machinesQuery = '';
let machinesFilter = 'all'; // all | in | zero | neg
let machinesSort = 'name'; // name | qty_desc | qty_asc
let machinesData = [];

function ensureMachinesModal() {
    let el = document.getElementById('machinesOverlay');
    if (el) return el;

    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'machinesOverlay';
    el.style.zIndex = '1005';

    el.innerHTML = `
        <div class="modal-box assort-box machines-box">
            <div class="modal-header machines-header">
                <div class="machines-head-left">
                    <div class="machines-avatar">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M5 8h14v9a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8Z"/>
                            <path d="M9 8V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v3"/>
                            <path d="M9 13h6"/>
                            <path d="M10 16h4"/>
                        </svg>
                    </div>
                    <div class="machines-head-text">
                        <h3 id="machinesTitle">Точка</h3>
                        <div class="assort-sub" id="machinesSub"></div>
                    </div>
                </div>
                <button class="modal-close" type="button" aria-label="Закрити">✕</button>
            </div>

            <div class="machines-toolbar">
                <div class="machines-search-wrap">
                    <input
                        type="search"
                        id="machinesSearch"
                        class="machines-search"
                        placeholder="Пошук товару за назвою або кодом..."
                        autocomplete="off"
                    >
                </div>

                <div class="machines-filters" id="machinesFilters">
                    <button type="button" class="mf-chip active" data-filter="all">Всі</button>
                    <button type="button" class="mf-chip" data-filter="in">В наявності</button>
                    <button type="button" class="mf-chip" data-filter="zero">Немає</button>
                    <button type="button" class="mf-chip" data-filter="neg">Від'ємні</button>
                </div>

                <div class="machines-sort">
                    <span class="machines-sort-label">Сортування</span>
                    <div class="machines-sort-control">
                        <button
                            type="button"
                            id="machinesSort"
                            class="machines-sort-select"
                            aria-haspopup="listbox"
                            aria-expanded="false"
                            aria-controls="machinesSortMenu"
                        >
                            <span id="machinesSortValue">За назвою (А–Я)</span>
                            <svg class="machines-sort-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
                        </button>
                        <div class="machines-sort-menu" id="machinesSortMenu" role="listbox" aria-label="Сортування товарів" hidden>
                            <button type="button" class="machines-sort-option active" role="option" aria-selected="true" data-sort="name">За назвою (А–Я)</button>
                            <button type="button" class="machines-sort-option" role="option" aria-selected="false" data-sort="qty_desc">Спочатку більше</button>
                            <button type="button" class="machines-sort-option" role="option" aria-selected="false" data-sort="qty_asc">Спочатку менше</button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="modal-body machines-body" id="machinesBody"></div>
        </div>
    `;

    document.body.appendChild(el);

    const sortButton = el.querySelector('#machinesSort');
    const sortMenu = el.querySelector('#machinesSortMenu');
    const sortControl = el.querySelector('.machines-sort-control');

    const closeSortMenu = (restoreFocus = false) => {
        sortMenu.hidden = true;
        sortButton.setAttribute('aria-expanded', 'false');
        sortControl.classList.remove('is-open');
        if (restoreFocus) sortButton.focus();
    };

    const openSortMenu = (focusSelected = false) => {
        sortMenu.hidden = false;
        sortButton.setAttribute('aria-expanded', 'true');
        sortControl.classList.add('is-open');
        if (focusSelected) {
            sortMenu.querySelector('[aria-selected="true"]')?.focus();
        }
    };

    el.querySelector('.modal-close').addEventListener('click', closeMachinesModal);
    el.addEventListener('click', (e) => {
        if (e.target === el) {
            closeMachinesModal();
            return;
        }
        if (!e.target.closest('.machines-sort-control')) closeSortMenu();
    });
    el.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !sortMenu.hidden) {
            e.stopPropagation();
            closeSortMenu(true);
        }
    });

    const search = el.querySelector('#machinesSearch');
    search.addEventListener('input', () => {
        machinesQuery = search.value.trim().toLowerCase();
        renderMachinesList();
    });

    el.querySelector('#machinesFilters').addEventListener('click', (e) => {
        const chip = e.target.closest('.mf-chip');
        if (!chip) return;
        machinesFilter = chip.dataset.filter;
        el.querySelectorAll('.mf-chip').forEach(c => c.classList.toggle('active', c === chip));
        renderMachinesList();
    });

    sortButton.addEventListener('click', () => {
        if (sortMenu.hidden) openSortMenu();
        else closeSortMenu();
    });
    sortButton.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            openSortMenu(true);
        }
    });
    sortMenu.addEventListener('click', (e) => {
        const option = e.target.closest('.machines-sort-option');
        if (!option) return;

        machinesSort = option.dataset.sort;
        el.querySelectorAll('.machines-sort-option').forEach(item => {
            const selected = item === option;
            item.classList.toggle('active', selected);
            item.setAttribute('aria-selected', String(selected));
        });
        el.querySelector('#machinesSortValue').textContent = option.textContent;
        closeSortMenu(true);
        renderMachinesList();
    });
    sortMenu.addEventListener('keydown', (e) => {
        const options = [...sortMenu.querySelectorAll('.machines-sort-option')];
        const index = options.indexOf(e.target);
        let nextIndex = index;

        if (e.key === 'ArrowDown') nextIndex = (index + 1) % options.length;
        else if (e.key === 'ArrowUp') nextIndex = (index - 1 + options.length) % options.length;
        else if (e.key === 'Home') nextIndex = 0;
        else if (e.key === 'End') nextIndex = options.length - 1;
        else return;

        e.preventDefault();
        options[nextIndex].focus();
    });

    return el;
}

function closeMachinesModal() {
    machinesQuery = '';
    machinesFilter = 'all';
    machinesSort = 'name';
    machinesData = [];
    document.getElementById('machinesOverlay')?.classList.remove('active');
    if (typeof getTopModal === 'function' && !getTopModal() && typeof restoreFocus === 'function') {
        restoreFocus();
    }
}

function renderMachinesList() {
    const overlay = document.getElementById('machinesOverlay');
    const body = document.getElementById('machinesBody');
    if (!overlay || !body) return;

    // лічильники по категоріях рахуємо тільки по повному списку
    const total = machinesData.length;
    const cntIn = machinesData.filter(it => (Number(it.quantity) || 0) > 0).length;
    const cntZero = machinesData.filter(it => (Number(it.quantity) || 0) === 0).length;
    const cntNeg = machinesData.filter(it => (Number(it.quantity) || 0) < 0).length;

    // оновлюємо текст чипів з кількістю
    const setChipText = (filter, label, count) => {
        const chip = overlay.querySelector(`.mf-chip[data-filter="${filter}"]`);
        if (chip) chip.innerHTML = `${label}<span class="mf-chip-count">${count}</span>`;
    };
    setChipText('all', 'Всі', total);
    setChipText('in', 'В наявності', cntIn);
    setChipText('zero', 'Немає', cntZero);
    setChipText('neg', 'Від\'ємні', cntNeg);

    // фільтруємо
    let list = machinesData.slice();

    if (machinesFilter === 'in') list = list.filter(it => (Number(it.quantity) || 0) > 0);
    if (machinesFilter === 'zero') list = list.filter(it => (Number(it.quantity) || 0) === 0);
    if (machinesFilter === 'neg') list = list.filter(it => (Number(it.quantity) || 0) < 0);

    if (machinesQuery) {
        list = list.filter(it => {
            const name = String(it.Name || '').toLowerCase();
            const code = String(it.Code || '').toLowerCase();
            return name.includes(machinesQuery) || code.includes(machinesQuery);
        });
    }

    // сортуємо
    if (machinesSort === 'name') {
        list.sort((a, b) => String(a.Name || '').localeCompare(String(b.Name || ''), 'uk'));
    } else if (machinesSort === 'qty_desc') {
        list.sort((a, b) => (Number(b.quantity) || 0) - (Number(a.quantity) || 0));
    } else if (machinesSort === 'qty_asc') {
        list.sort((a, b) => (Number(a.quantity) || 0) - (Number(b.quantity) || 0));
    }

    if (!list.length) {
        body.innerHTML = `<div class="empty-state" style="padding:32px 20px;">Нічого не знайдено</div>`;
        return;
    }

    body.innerHTML = `
        <div class="mt-list">
            ${list.map((it, index) => {
                const qty = Number(it.quantity) || 0;
                const code = it.Code ? String(it.Code) : '';
                const cls = qty > 0 ? 'has' : (qty < 0 ? 'neg' : 'zero');
                return `
                    <div class="mt-row mt-row-${cls}" style="--machine-row-index:${Math.min(index, 7)}">
                        <div class="mt-row-main">
                            <div class="mt-row-name">${escapeHtml(it.Name || '—')}</div>
                            ${code ? `<div class="mt-row-code">код ${escapeHtml(code)}</div>` : ''}
                        </div>
                        <div class="mt-row-qty ${cls}">${fmt(qty)}</div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

async function openMachinesModal(pointId) {
    if (machinesLoading) return;

    const point = (typeof globalData !== 'undefined')
        ? globalData.find(i => String(i.id) === String(pointId))
        : null;
    if (!point) return;

    if (typeof rememberFocus === 'function') rememberFocus();

    const overlay = ensureMachinesModal();
    const title = document.getElementById('machinesTitle');
    const sub = document.getElementById('machinesSub');
    const body = document.getElementById('machinesBody');
    const searchInput = document.getElementById('machinesSearch');
    const sortButton = document.getElementById('machinesSort');
    const sortMenu = document.getElementById('machinesSortMenu');
    const sortControl = document.querySelector('#machinesOverlay .machines-sort-control');

    machinesQuery = '';
    machinesFilter = 'all';
    machinesSort = 'name';
    machinesData = [];

    if (searchInput) searchInput.value = '';
    if (sortButton) {
        document.getElementById('machinesSortValue').textContent = 'За назвою (А–Я)';
        sortButton.setAttribute('aria-expanded', 'false');
    }
    if (sortMenu) sortMenu.hidden = true;
    sortControl?.classList.remove('is-open');
    document.querySelectorAll('#machinesOverlay .machines-sort-option').forEach(option => {
        const selected = option.dataset.sort === 'name';
        option.classList.toggle('active', selected);
        option.setAttribute('aria-selected', String(selected));
    });
    overlay.querySelectorAll('.mf-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === 'all'));

    title.textContent = point.point_name || 'Точка';

    const machineName = point.coffee_machine || '';
    const machineCode = point.coffee_machine_code ? ` · код ${point.coffee_machine_code}` : '';
    sub.textContent = (machineName ? machineName : 'Обладнання не вказано') + machineCode;

    body.innerHTML = `
        <div class="mt-loading">
            <div class="skeleton skeleton-text" style="width:70%;"></div>
            <div class="skeleton skeleton-text" style="width:90%;"></div>
            <div class="skeleton skeleton-text" style="width:55%;"></div>
            <div class="skeleton skeleton-text" style="width:80%;"></div>
        </div>
    `;

    overlay.classList.add('active');
    machinesLoading = true;

    try {
        const res = await fetchWithTimeout(
            `${apiBase}/machines?point=${encodeURIComponent(point.id)}&t=${Date.now()}`,
            { method: 'GET', cache: 'no-store' },
            APP_CONFIG.loadTimeoutMs
        );

        if (!res.ok) throw new Error('Помилка мережі');
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Невірна відповідь 1С');

        if (data.length === 1 && String(data[0].Code) === '0') {
            body.innerHTML = `<div class="empty-state" style="padding:28px 20px;">${escapeHtml(data[0].Name)}</div>`;
            return;
        }

        if (!data.length) {
            body.innerHTML = `<div class="empty-state" style="padding:28px 20px;">Залишки відсутні</div>`;
            return;
        }

        machinesData = data;
        renderMachinesList();
    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        body.innerHTML = `<div class="assort-error">Не вдалося завантажити: ${escapeHtml(message)}</div>`;
    } finally {
        machinesLoading = false;
    }
}