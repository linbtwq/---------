// асортимент + замовлення поповнення

let assortLoading = false;
let orderSending = false;

const order = {
    pointId: null,
    qty: {},
    items: {},
    requestId: null,
    canOrder: false
};

function resetOrder() {
    order.pointId = null;
    order.qty = {};
    order.items = {};
    order.requestId = null;
    order.canOrder = false;
}

function ensureAssortModal() {
    let el = document.getElementById('assortOverlay');

    if (el) return el;

    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'assortOverlay';
    el.style.zIndex = '1005';

    el.innerHTML = `
        <div class="modal-box assort-box">
            <div class="modal-header">
                <div class="assort-head">
                    <h3>Асортимент</h3>
                    <div class="assort-sub" id="assortSub"></div>
                </div>
                <button class="modal-close" type="button" aria-label="Закрити">✕</button>
            </div>

            <div class="modal-body" id="assortBody"></div>

            <div class="modal-footer order-footer">
                <div class="order-summary" id="orderSummary" style="display:none;"></div>
                <button class="action-btn btn-success" type="button" id="orderSendBtn" style="display:none;" disabled>Замовити</button>
            </div>
        </div>
    `;

    document.body.appendChild(el);

    el.querySelector('.modal-close').addEventListener('click', closeAssortModal);
    el.querySelector('#orderSendBtn').addEventListener('click', showOrderConfirm);

    return el;
}

async function loadPointAssortment(pointId) {
    const key = `assortment_${pointId}`;

    try {
        const res = await fetchWithTimeout(
            `${apiBase}/assortments?point=${encodeURIComponent(pointId)}&t=${Date.now()}`,
            { method: 'GET', cache: 'no-store' },
            APP_CONFIG.loadTimeoutMs
        );

        if (!res.ok) throw new Error('Помилка мережі');

        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Невірна відповідь 1С');

        try { await localDB.save(key, data); } catch (e) {}

        return { data, offline: false };

    } catch (err) {
        try {
            const cached = await localDB.load(key);
            if (Array.isArray(cached)) {
                return { data: cached, offline: true };
            }
        } catch (e) {}

        throw err;
    }
}


// заказ

function orderTotals() {
    let count = 0;
    let sum = 0;

    for (const code in order.qty) {
        count++;
        sum += order.qty[code] * (order.items[code]?.price || 0);
    }

    return { count, sum };
}

function updateOrderBar() {
    const summary = document.getElementById('orderSummary');
    const btn = document.getElementById('orderSendBtn');

    if (!summary || !btn) return;

    if (!order.canOrder) {
        summary.style.display = 'none';
        btn.style.display = 'none';
        return;
    }

    const { count, sum } = orderTotals();

    summary.style.display = 'block';
    btn.style.display = '';

    summary.innerHTML = count
        ? `У замовленні: <b>${count} поз.</b> на <b>${fmt(sum)} ₴</b>`
        : 'Виберіть кількість потрібних позицій';

    btn.disabled = orderSending || count === 0;
}

function setQty(code, value, tile, syncInput) {
    const q = Math.max(0, Math.min(9999, Math.floor(Number(value) || 0)));

    if (q) {
        order.qty[code] = q;
    } else {
        delete order.qty[code];
    }

    order.requestId = null;

    tile.classList.toggle('picked', q > 0);

    if (syncInput) {
        const inp = tile.querySelector('.qty-input');
        if (inp) inp.value = q;
    }

    const totalEl = tile.querySelector('.assort-row-total');
    if (totalEl) {
        const price = Number(tile.dataset.price) || 0;
        totalEl.textContent = `${fmt(q * price)} ₴`;
    }

    updateOrderBar();
}

function point_orders_locked(pointId, orderSum) {
    const item = globalData.find(i => String(i.id) === String(pointId));
    if (!item) return;

    item.order_locked = true;
    item.order_locked_at = new Date().toLocaleString('uk-UA');

    // долг теперь двигает 1С через документ не трогаем локально,
    // просто подтянем с сервера
    if (typeof loadData === 'function') {
        loadData({ silent: true });
    }
}

async function submitOrder() {
    if (orderSending || !order.canOrder) return;

    const { count, sum } = orderTotals();
    if (!count) return;

    if (!navigator.onLine) {
        showToast('Немає мережі! Замовлення можна відправити лише онлайн.', true);
        return;
    }

    const items = Object.keys(order.qty).map(code => ({
        code,
        name: order.items[code].name,
        qty: order.qty[code],
        price: order.items[code].price
    }));

    order.requestId = order.requestId || newRequestId();

    const payload = {
        point_id: order.pointId,
        technician_id: currentUser ? currentUser.id : '',
        request_id: order.requestId,
        total: sum,
        items
    };

    const pointId = order.pointId;

    const btn = document.getElementById('orderSendBtn');
    const closeBtn = document.querySelector('#assortOverlay .modal-close');

    orderSending = true;
    if (closeBtn) closeBtn.disabled = true;
    setBtnLoading(btn, 'Відправка...');

    let success = false;
    let finalSum = sum;
    let debtError = '';

    try {
        const res = await fetchWithTimeout(
            `${apiBase}/orders?v=${APP_CONFIG.apiVersion}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-User-Code': currentUser ? currentUser.id : ''
                },
                body: JSON.stringify(payload)
            },
            APP_CONFIG.sendTimeoutMs
        );

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText.slice(0, 150) || 'Помилка сервера 1С');
        }

        let body = null;
        try { body = await res.json(); } catch (e) {}

        if (body && Number(body.sum)) finalSum = Number(body.sum);
        if (body && body.debt_error) debtError = String(body.debt_error);

        success = true;

    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        const msg = (message.includes('Failed to fetch') || message.toLowerCase().includes('timeout'))
            ? '1С не відповідає. Замовлення не відправлено, спробуйте ще раз.'
            : `Не вдалося відправити замовлення: ${message}`;
        showToast(msg, true);

    } finally {
        orderSending = false;
        if (closeBtn) closeBtn.disabled = false;
        resetBtn(btn, 'Замовити');

        if (success) {
            showSuccessAnimation();

            if (debtError) {
                console.error('[1С] борг по замовленню не нарахований:', debtError);
                showToast('Замовлення створено, але БОРГ НЕ НАРАХОВАНО: ' + debtError.slice(0, 150), true);
            } else {
                showToast(`Замовлення відправлено: ${count} поз. на ${fmt(finalSum)} ₴`);
            }

            resetOrder();

            document.getElementById('orderConfirmOverlay')?.classList.remove('active');
            closeAssortModal();

            if (typeof resetToSearchScreen === 'function') {
                resetToSearchScreen();
            }
        } else {
            updateOrderBar();
        }
    }
}


// отрисовка тела модалки

function renderAssortBody(data, offline) {
    const body = document.getElementById('assortBody');

    order.canOrder = false;

    if (data.length === 1 && String(data[0].Code) === '0') {
        body.innerHTML = `
            <div class="empty-state" style="padding:28px 20px;">
                ${escapeHtml(data[0].Name)}
            </div>
        `;
        updateOrderBar();
        return;
    }

    if (!data.length) {
        body.innerHTML = `
            <div class="empty-state" style="padding:28px 20px;">
                Асортимент порожній
            </div>
        `;
        updateOrderBar();
        return;
    }

    order.canOrder = !offline;
    order.items = {};

    data.forEach(it => {
        order.items[String(it.Code)] = {
            name: String(it.Name || ''),
            price: Number(it.price) || 0
        };
    });

    const prices = data.map(i => Number(i.price) || 0);
    const min = Math.min(...prices);
    const max = Math.max(...prices);

    const priceText = min === max
        ? `${fmt(min)} ₴`
        : `${fmt(min)}–${fmt(max)} ₴`;

    const showSearch = data.length > 8;

    body.innerHTML = `
        ${
            showSearch
                ? `
                    <div class="assort-top">
                        <div class="assort-search-wrap">
                            <input
                                type="search"
                                class="assort-search"
                                id="assortSearch"
                                placeholder="Пошук напою"
                                autocomplete="off"
                            >
                        </div>
                    </div>
                `
                : ''
        }

        ${
            offline
                ? `
                    <div class="assort-offline">
                        Офлайн. Показані збережені дані.
                        Замовлення можна відправити лише онлайн.
                    </div>
                `
                : ''
        }

        <div class="assort-panel">
            <div class="assort-pills" style="margin-top:0;">
                <span class="assort-pill">${data.length} поз.</span>
                <span class="assort-pill price">${priceText}</span>
            </div>

            <div id="assortGrid" class="assort-grid" style="margin-top:14px;">
                ${data.map((it) => {
                    const minStock = Number(it.minStock) || 0;
                    const price = Number(it.price) || 0;
                    const code = escapeHtml(String(it.Code));
                    const name = String(it.Name || '');

                    return `
                        <div
                            class="meter-input-group assort-row"
                            data-code="${code}"
                            data-price="${price}"
                        >
                            <div class="assort-row-head">
                                <strong class="assort-tile-name">
                                    ${escapeHtml(name) || '—'}
                                </strong>
                                <span class="assort-row-price">
                                    Ціна: <strong>${fmt(price)} ₴</strong>
                                </span>
                            </div>

                            <div class="assort-row-fields">
                                <div>
                                    <label>Мін. запас</label>
                                    <div class="assort-field-static">
                                        ${minStock > 0 ? fmt(minStock) : '—'}
                                    </div>
                                </div>

                                <div>
                                    <label>Кількість</label>
                                    ${
                                        order.canOrder
                                            ? `
                                                <div class="qty">
                                                    <button type="button" class="qty-btn" data-step="-1" aria-label="Менше">−</button>
                                                    <input type="text" class="qty-input" inputmode="numeric" value="0" aria-label="Кількість">
                                                    <button type="button" class="qty-btn" data-step="1" aria-label="Більше">+</button>
                                                </div>
                                              `
                                            : `<div class="assort-field-static">—</div>`
                                    }
                                </div>

                                <div>
                                    <label>Сума</label>
                                    <div class="assort-row-total">0 ₴</div>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>

            <div id="assortNoMatch" class="empty-state" style="display:none; margin-top:14px;">
                Нічого не знайдено
            </div>
        </div>
    `;

    // поиск
    const input = document.getElementById('assortSearch');
    if (input) {
        input.addEventListener('input', () => {
            const q = input.value.trim().toLowerCase();
            let shown = 0;

            document.querySelectorAll('#assortGrid .assort-row').forEach(tile => {
                const nameEl = tile.querySelector('.assort-tile-name');
                const name = nameEl ? nameEl.textContent.toLowerCase() : '';
                const ok = !q || name.includes(q);
                tile.style.display = ok ? '' : 'none';
                if (ok) shown++;
            });

            const noMatch = document.getElementById('assortNoMatch');
            if (noMatch) {
                noMatch.style.display = shown ? 'none' : 'block';
            }
        });
    }

    // кнопки + / -
    const grid = document.getElementById('assortGrid');
    if (!grid) {
        updateOrderBar();
        return;
    }

    grid.addEventListener('click', e => {
        const btn = e.target.closest('.qty-btn');
        if (!btn) return;

        const tile = btn.closest('.assort-row');
        if (!tile) return;

        const code = tile.dataset.code;

        setQty(
            code,
            (order.qty[code] || 0) + Number(btn.dataset.step),
            tile,
            true
        );
    });

    // ручной ввод
    grid.addEventListener('input', e => {
        if (!e.target.classList.contains('qty-input')) return;

        const tile = e.target.closest('.assort-row');
        if (!tile) return;

        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);

        setQty(tile.dataset.code, e.target.value, tile, false);
    });

    // возврат значения при уходе из поля
    grid.addEventListener('focusout', e => {
        if (!e.target.classList.contains('qty-input')) return;

        const tile = e.target.closest('.assort-row');
        if (!tile) return;

        e.target.value = order.qty[tile.dataset.code] || 0;
    });

    updateOrderBar();
}


// скелетон

function assortSkeleton() {
    return `
        <div class="assort-loading">
            <div class="skeleton skeleton-title" style="width:50%;"></div>
            <div class="skeleton skeleton-text"></div>
            <div class="skeleton skeleton-title" style="width:40%; margin-top:10px;"></div>
            <div class="skeleton skeleton-text" style="width:65%;"></div>
        </div>
    `;
}


// открытие модалки

async function openAssortModal(pointId) {
    const point = globalData.find(i => String(i.id) === String(pointId));

    if (!point || assortLoading) return;

    rememberFocus();

    const overlay = ensureAssortModal();

    resetOrder();

    order.pointId = point.id;

    updateOrderBar();

     // шапка: точка · код · машина
    const subParts = [point.point_name || 'Точка', `код ${point.id}`];
    if (point.coffee_machine) {
        subParts.push(point.coffee_machine + (point.coffee_machine_code ? ` (${point.coffee_machine_code})` : ''));
    }
    document.getElementById('assortSub').textContent = subParts.join(' · ');

    document.getElementById('assortBody').innerHTML = assortSkeleton();

    overlay.classList.add('active');

    assortLoading = true;

    try {
        const { data, offline } = await loadPointAssortment(point.id);
        renderAssortBody(data, offline);

    } catch (err) {
        const message = err && err.message ? err.message : String(err);

        document.getElementById('assortBody').innerHTML = `
            <div class="assort-error">
                Не вдалося завантажити асортимент:
                ${escapeHtml(message)}
            </div>
        `;

        updateOrderBar();
    } finally {
        assortLoading = false;
    }
}


// закрытие модалки

function closeAssortModal() {
    if (orderSending) return;

    document.getElementById('assortOverlay')?.classList.remove('active');

    if (!getTopModal()) {
        restoreFocus();
    }
}

// ============================================================
// МОДАЛКА ПІДТВЕРДЖЕННЯ ЗАМОВЛЕННЯ
// ============================================================

function ensureOrderConfirmModal() {
    let el = document.getElementById('orderConfirmOverlay');
    if (el) return el;

    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'orderConfirmOverlay';
    el.style.zIndex = '1011';

    el.innerHTML = `
        <div class="modal-box confirm-box">
            <div class="modal-header">
                <h3>Перевірка замовлення</h3>
                <button class="modal-close" type="button" aria-label="Закрити">✕</button>
            </div>
            <div class="modal-body">
                <p style="text-align: center; margin-bottom: 15px; color: #64748b; font-size: 0.95rem;">
                    Перевірте склад замовлення перед відправкою в 1С
                </p>
                <div class="confirm-summary">
                    <div class="confirm-item">
                        <span>Всього позицій:</span>
                        <strong id="orderConfirmCount" style="color: #0f172a; font-size: 1.2rem;">0</strong>
                    </div>
                    <div class="confirm-item">
                        <span>На суму:</span>
                        <strong id="orderConfirmSum" style="color: #10b981; font-size: 1.2rem;">0 ₴</strong>
                    </div>
                </div>
            </div>
            <div class="modal-footer" style="justify-content: space-between;">
                <button class="action-btn btn-secondary" type="button" id="orderConfirmBack">Назад</button>
                <button class="action-btn btn-success" type="button" id="orderConfirmSend">Відправити в 1С</button>
            </div>
        </div>
    `;

    document.body.appendChild(el);

    el.querySelector('.modal-close').addEventListener('click', closeOrderConfirmModal);
    el.querySelector('#orderConfirmBack').addEventListener('click', closeOrderConfirmModal);
    el.querySelector('#orderConfirmSend').addEventListener('click', submitOrder);

    el.addEventListener('click', (e) => {
        if (e.target === el) closeOrderConfirmModal();
    });

    return el;
}

function showOrderConfirm() {
    if (orderSending || !order.canOrder) return;

    const { count, sum } = orderTotals();
    if (!count) return;

    const el = ensureOrderConfirmModal();

    document.getElementById('orderConfirmCount').textContent = count;
    document.getElementById('orderConfirmSum').textContent = `${fmt(sum)} ₴`;

    el.classList.add('active');
}

function closeOrderConfirmModal() {
    if (orderSending) return;
    document.getElementById('orderConfirmOverlay')?.classList.remove('active');
}