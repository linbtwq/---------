// javascript/assortments.js
// версия 6: ассортимент + заказ пополнения
// строки оформлены как в окне "Показатели"
//
// Подключается в index.html ПОСЛЕ script.js.
//
// Использует глобальные из script.js:
// apiBase, fetchWithTimeout, localDB, globalData,
// escapeHtml, fmt, rememberFocus, restoreFocus, getTopModal, APP_CONFIG,
// newRequestId, showToast, showSuccessAnimation, setBtnLoading, resetBtn,
// currentUser, closeAssortModal (заглушка в script.js).
//
// Данные:
// GET {apiBase}/assortments?point=<код точки>
//
// Ответ 1С:
// [{ Code, Name, price, minStock }, ...]
//
// Служебные ответы приходят как один элемент с Code "0"
// и текстом в Name.
//
// Заказ:
// POST {apiBase}/orders
//
// Тело:
// {
//     point_id,
//     technician_id,
//     request_id,
//     total,
//     items: [{ code, name, qty, price }]
// }

let assortLoading = false;
let orderSending = false;

// Состояние текущего заказа
const order = {
    pointId: null,
    qty: {},          // { код позиции: количество }
    items: {},        // { код позиции: { name, price } }
    requestId: null,  // сбрасывается при любом изменении количества
    canOrder: false   // заказ только онлайн и только по реальным позициям
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
                <span class="assort-icon">☕</span>

                <div class="assort-head">
                    <h3>Ассортимент</h3>
                    <div class="assort-sub" id="assortSub"></div>
                </div>

                <button
                    class="modal-close"
                    type="button"
                    aria-label="Закрыть"
                >✕</button>
            </div>

            <div class="modal-body" id="assortBody"></div>

            <div class="modal-footer order-footer">
                <div
                    class="order-summary"
                    id="orderSummary"
                    style="display:none;"
                ></div>

                <button
                    class="action-btn btn-secondary"
                    type="button"
                    id="assortCloseBtn"
                >Закрыть</button>

                <button
                    class="action-btn btn-success"
                    type="button"
                    id="orderSendBtn"
                    style="display:none;"
                    disabled
                >Заказать</button>
            </div>
        </div>
    `;

    document.body.appendChild(el);

    el.querySelector('.modal-close')
        .addEventListener('click', closeAssortModal);

    el.querySelector('#assortCloseBtn')
        .addEventListener('click', closeAssortModal);

    el.querySelector('#orderSendBtn')
        .addEventListener('click', submitOrder);

    return el;
}

async function loadPointAssortment(pointId) {
    const key = `assortment_${pointId}`;

    try {
        const res = await fetchWithTimeout(
            `${apiBase}/assortments?point=${encodeURIComponent(pointId)}&t=${Date.now()}`,
            {
                method: 'GET',
                cache: 'no-store'
            },
            APP_CONFIG.loadTimeoutMs
        );

        if (!res.ok) {
            throw new Error('Ошибка сети');
        }

        const data = await res.json();

        if (!Array.isArray(data)) {
            throw new Error('Неверный ответ 1С');
        }

        try {
            await localDB.save(key, data);
        } catch (e) {
            // Кэш не критичен
        }

        return {
            data,
            offline: false
        };

    } catch (err) {
        try {
            const cached = await localDB.load(key);

            if (Array.isArray(cached)) {
                return {
                    data: cached,
                    offline: true
                };
            }
        } catch (e) {
            // Ошибка чтения кэша
        }

        throw err;
    }
}


// ============================================================
// ЗАКАЗ
// ============================================================

function orderTotals() {
    let count = 0;
    let sum = 0;

    for (const code in order.qty) {
        count++;

        sum +=
            order.qty[code] *
            (order.items[code]?.price || 0);
    }

    return {
        count,
        sum
    };
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
        ? `В заказе: <b>${count} поз.</b> на <b>${fmt(sum)} ₴</b>`
        : 'Выберите количество нужных позиций';

    btn.disabled = orderSending || count === 0;
}

function setQty(code, value, tile, syncInput) {
    const q = Math.max(
        0,
        Math.min(
            9999,
            Math.floor(Number(value) || 0)
        )
    );

    if (q) {
        order.qty[code] = q;
    } else {
        delete order.qty[code];
    }

    // Состав заказа изменился — это уже другой заказ
    order.requestId = null;

    tile.classList.toggle('picked', q > 0);

    if (syncInput) {
        const inp = tile.querySelector('.qty-input');

        if (inp) {
            inp.value = q;
        }
    }

    // Колонка "Сумма" = количество × цена
    const totalEl = tile.querySelector('.assort-row-total');
    if (totalEl) {
        const price = Number(tile.dataset.price) || 0;
        totalEl.textContent = `${fmt(q * price)} ₴`;
    }

    updateOrderBar();
}

async function submitOrder() {
    if (orderSending || !order.canOrder) return;

    const { count, sum } = orderTotals();

    if (!count) return;

    if (!navigator.onLine) {
        showToast(
            'Нет сети! Заказ можно отправить только онлайн.',
            true
        );
        return;
    }

    if (!confirm(
        `Отправить заказ: ${count} поз. на ${fmt(sum)} ₴?`
    )) {
        return;
    }

    const items = Object.keys(order.qty).map(code => ({
        code,
        name: order.items[code].name,
        qty: order.qty[code],
        price: order.items[code].price
    }));

    order.requestId =
        order.requestId || newRequestId();

    const payload = {
        point_id: order.pointId,
        technician_id: currentUser ? currentUser.id : '',
        request_id: order.requestId,
        total: sum,
        items
    };

    const btn =
        document.getElementById('orderSendBtn');

    const closeBtn =
        document.getElementById('assortCloseBtn');

    orderSending = true;

    closeBtn.disabled = true;

    setBtnLoading(btn, 'Отправка...');

    try {
        const res = await fetchWithTimeout(
            `${apiBase}/orders?v=${APP_CONFIG.apiVersion}`,
            {
                method: 'POST',

                headers: {
                    'Content-Type': 'application/json',
                    'X-User-Code': currentUser
                        ? currentUser.id
                        : ''
                },

                body: JSON.stringify(payload)
            },
            APP_CONFIG.sendTimeoutMs
        );

        if (!res.ok) {
            const errText = await res.text();

            throw new Error(
                errText.slice(0, 150) ||
                'Ошибка сервера 1С'
            );
        }

        showSuccessAnimation();

        showToast(
            `Заказ отправлен: ${count} поз. на ${fmt(sum)} ₴`
        );

        resetOrder();

        closeAssortModal();

    } catch (err) {
        const message =
            err && err.message
                ? err.message
                : String(err);

        const msg =
            message.includes('Failed to fetch') ||
            message.toLowerCase().includes('timeout')
                ? '1С не отвечает. Заказ не отправлен, попробуйте ещё раз.'
                : `Не удалось отправить заказ: ${message}`;

        showToast(msg, true);

    } finally {
        orderSending = false;

        closeBtn.disabled = false;

        resetBtn(btn, 'Заказать');

        updateOrderBar();
    }
}


// ============================================================
// ОТРИСОВКА
// ============================================================

function renderAssortBody(data, offline) {
    const body = document.getElementById('assortBody');

    order.canOrder = false;

    // Служебное сообщение от 1С:
    // один элемент с Code "0"
    if (
        data.length === 1 &&
        String(data[0].Code) === '0'
    ) {
        body.innerHTML = `
            <div
                class="empty-state"
                style="padding:28px 20px;"
            >
                ${escapeHtml(data[0].Name)}
            </div>
        `;

        updateOrderBar();

        return;
    }

    // Пустой ассортимент
    if (!data.length) {
        body.innerHTML = `
            <div
                class="empty-state"
                style="padding:28px 20px;"
            >
                Ассортимент пустой
            </div>
        `;

        updateOrderBar();

        return;
    }

    // Заказывать можно только при онлайн-загрузке
    order.canOrder = !offline;

    order.items = {};

    data.forEach(it => {
        order.items[String(it.Code)] = {
            name: String(it.Name || ''),
            price: Number(it.price) || 0
        };
    });

    const prices = data.map(
        i => Number(i.price) || 0
    );

    const min = Math.min(...prices);
    const max = Math.max(...prices);

    const priceText =
        min === max
            ? `${fmt(min)} ₴`
            : `${fmt(min)}–${fmt(max)} ₴`;

    const showSearch = data.length > 8;

    body.innerHTML = `
        ${
            showSearch
                ? `
                    <div class="assort-top">
                        <div
                            class="assort-search-wrap"
                            style="padding-bottom:0;"
                        >
                            <input
                                type="search"
                                class="assort-search"
                                id="assortSearch"
                                placeholder="Поиск напитка"
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
                        Оффлайн. Показаны сохранённые данные.
                        Заказ можно отправить только онлайн.
                    </div>
                `
                : ''
        }

        <div class="assort-panel">

            <div
                class="assort-pills"
                style="margin-top:0;"
            >
                <span class="assort-pill">
                    ${data.length} поз.
                </span>

                <span class="assort-pill price">
                    ${priceText}
                </span>
            </div>

            <div
                id="assortGrid"
                style="margin-top:14px;"
            >
                ${data.map((it) => {
                    const minStock =
                        Number(it.minStock) || 0;

                    const price =
                        Number(it.price) || 0;

                    const code =
                        escapeHtml(String(it.Code));

                    const name =
                        String(it.Name || '');

                    return `
                        <div
                            class="meter-input-group assort-row"
                            data-name="${escapeHtml(name.toLowerCase())}"
                            data-code="${code}"
                            data-price="${price}"
                        >
                            <div class="assort-row-head">
                                <strong class="assort-tile-name">
                                    ${escapeHtml(name) || '—'}
                                </strong>
                                <span class="assort-row-price">
                                    Цена: <strong>${fmt(price)} ₴</strong>
                                </span>
                            </div>

                            <div class="assort-row-fields">
                                <div>
                                    <label>Мин. запас</label>
                                    <div class="assort-field-static">
                                        ${minStock > 0 ? fmt(minStock) : '—'}
                                    </div>
                                </div>

                                <div>
                                    <label>Количество</label>
                                    ${
                                        order.canOrder
                                            ? `
                                                <div class="qty">
                                                    <button
                                                        type="button"
                                                        class="qty-btn"
                                                        data-step="-1"
                                                        aria-label="Меньше"
                                                    >−</button>

                                                    <input
                                                        type="text"
                                                        class="qty-input"
                                                        inputmode="numeric"
                                                        value="0"
                                                        aria-label="Количество"
                                                    >

                                                    <button
                                                        type="button"
                                                        class="qty-btn"
                                                        data-step="1"
                                                        aria-label="Больше"
                                                    >+</button>
                                                </div>
                                              `
                                            : `<div class="assort-field-static">—</div>`
                                    }
                                </div>

                                <div>
                                    <label>Сумма</label>
                                    <div class="assort-row-total">0 ₴</div>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>

            <div
                id="assortNoMatch"
                class="empty-state"
                style="
                    display:none;
                    margin-top:14px;
                "
            >
                Ничего не найдено
            </div>

        </div>
    `;


    // ========================================================
    // ПОИСК
    // ========================================================

    const input =
        document.getElementById('assortSearch');

    if (input) {
        input.addEventListener('input', () => {
            const q =
                input.value.trim().toLowerCase();

            let shown = 0;

            document
                .querySelectorAll(
                    '#assortGrid .assort-row'
                )
                .forEach(tile => {
                    const ok =
                        !q ||
                        tile.dataset.name.includes(q);

                    tile.style.display =
                        ok ? '' : 'none';

                    if (ok) {
                        shown++;
                    }
                });

            const noMatch =
                document.getElementById(
                    'assortNoMatch'
                );

            if (noMatch) {
                noMatch.style.display =
                    shown ? 'none' : 'block';
            }
        });
    }


    // ========================================================
    // КНОПКИ + / -
    // ========================================================

    const grid =
        document.getElementById('assortGrid');

    if (!grid) {
        updateOrderBar();
        return;
    }

    grid.addEventListener('click', e => {
        const btn =
            e.target.closest('.qty-btn');

        if (!btn) return;

        const tile =
            btn.closest('.assort-row');

        if (!tile) return;

        const code =
            tile.dataset.code;

        setQty(
            code,
            (order.qty[code] || 0) +
                Number(btn.dataset.step),
            tile,
            true
        );
    });


    // ========================================================
    // РУЧНОЙ ВВОД КОЛИЧЕСТВА
    // ========================================================

    grid.addEventListener('input', e => {
        if (
            !e.target.classList.contains(
                'qty-input'
            )
        ) {
            return;
        }

        const tile =
            e.target.closest('.assort-row');

        if (!tile) return;

        // Оставляем в поле только цифры
        e.target.value =
            e.target.value
                .replace(/\D/g, '')
                .slice(0, 4);

        setQty(
            tile.dataset.code,
            e.target.value,
            tile,
            false
        );
    });


    // ========================================================
    // ВОЗВРАТ ЗНАЧЕНИЯ ПРИ УХОДЕ ИЗ ПОЛЯ
    // ========================================================

    grid.addEventListener('focusout', e => {
        if (
            !e.target.classList.contains(
                'qty-input'
            )
        ) {
            return;
        }

        const tile =
            e.target.closest('.assort-row');

        if (!tile) return;

        e.target.value =
            order.qty[tile.dataset.code] || 0;
    });


    updateOrderBar();
}


// ============================================================
// SKELETON
// ============================================================

function assortSkeleton() {
    return `
        <div class="assort-loading">
            <div
                class="skeleton skeleton-title"
                style="width:50%;"
            ></div>

            <div class="skeleton skeleton-text"></div>

            <div
                class="skeleton skeleton-title"
                style="
                    width:40%;
                    margin-top:10px;
                "
            ></div>

            <div
                class="skeleton skeleton-text"
                style="width:65%;"
            ></div>
        </div>
    `;
}


// ============================================================
// ОТКРЫТИЕ МОДАЛКИ
// ============================================================

async function openAssortModal(pointId) {
    const point = globalData.find(
        i => String(i.id) === String(pointId)
    );

    if (!point || assortLoading) return;

    rememberFocus();

    const overlay =
        ensureAssortModal();

    resetOrder();

    order.pointId = point.id;

    updateOrderBar();

    document.getElementById(
        'assortSub'
    ).textContent =
        `${point.point_name || 'Точка'} · код ${point.id}`;

    document.getElementById(
        'assortBody'
    ).innerHTML =
        assortSkeleton();

    overlay.classList.add('active');

    assortLoading = true;

    try {
        const {
            data,
            offline
        } = await loadPointAssortment(
            point.id
        );

        renderAssortBody(
            data,
            offline
        );

    } catch (err) {
        const message =
            err && err.message
                ? err.message
                : String(err);

        document.getElementById(
            'assortBody'
        ).innerHTML = `
            <div class="assort-error">
                Не удалось загрузить ассортимент:
                ${escapeHtml(message)}
            </div>
        `;

        updateOrderBar();

    } finally {
        assortLoading = false;
    }
}


// ============================================================
// ЗАКРЫТИЕ МОДАЛКИ
// ============================================================

function closeAssortModal() {
    if (orderSending) {
        return;
    }

    document
        .getElementById('assortOverlay')
        ?.classList.remove('active');

    if (!getTopModal()) {
        restoreFocus();
    }
}