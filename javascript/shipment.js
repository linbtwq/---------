// модалка відвантаження товарів зі складу на точку

let shipmentLoading = false;
let shipmentSending = false;
let shipmentPointId = null;
let shipmentRequestId = null;
let shipmentItems = [];   // { code, name, price, maxQty, qty }
let shipmentSearchQuery = '';

function ensureShipmentModal() {
    let el = document.getElementById('shipmentOverlay');
    if (el) return el;

    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'shipmentOverlay';
    el.style.zIndex = '1005';

    el.innerHTML = `
        <div class="modal-box assort-box">
            <div class="modal-header">
                <div class="assort-head">
                    <h3>Відвантаження на точку</h3>
                    <div class="assort-sub" id="shipmentSub"></div>
                </div>
                <button class="modal-close" type="button" aria-label="Закрити">✕</button>
            </div>
            <div class="modal-body" id="shipmentBody"></div>
            <div class="modal-footer order-footer">
                <div class="order-summary" id="shipmentSummary"></div>
                <button class="action-btn btn-success" type="button" id="shipmentSendBtn" disabled>Відвантажити</button>
            </div>
        </div>
    `;

    document.body.appendChild(el);

    el.querySelector('.modal-close').addEventListener('click', closeShipmentModal);
    el.querySelector('#shipmentSendBtn').addEventListener('click', submitShipment);

    return el;
}

function closeShipmentModal() {
    if (shipmentSending) return;
    document.getElementById('shipmentOverlay')?.classList.remove('active');
    shipmentPointId = null;
    shipmentRequestId = null;
    shipmentItems = [];
    shipmentSearchQuery = '';
    if (typeof getTopModal === 'function' && !getTopModal() && typeof restoreFocus === 'function') {
        restoreFocus();
    }
}

async function openShipmentModal(pointId) {
    const point = globalData.find(i => String(i.id) === String(pointId));
    if (!point || shipmentLoading) return;

    rememberFocus();

    const overlay = ensureShipmentModal();
    const sub = document.getElementById('shipmentSub');
    const body = document.getElementById('shipmentBody');
    const summary = document.getElementById('shipmentSummary');
    const sendBtn = document.getElementById('shipmentSendBtn');

    shipmentPointId = point.id;
    shipmentRequestId = newRequestId();
    shipmentItems = [];
    shipmentSearchQuery = '';

    sub.textContent = [point.point_name || 'Точка', `код ${point.id}`].join(' · ');
    summary.textContent = '';
    sendBtn.disabled = true;

    body.innerHTML = `
        <div class="assort-loading">
            <div class="skeleton skeleton-text" style="width:60%;"></div>
            <div class="skeleton skeleton-text" style="width:80%;"></div>
            <div class="skeleton skeleton-text" style="width:50%;"></div>
        </div>
    `;

    overlay.classList.add('active');
    shipmentLoading = true;

    try {
        const u = currentUser ? encodeURIComponent(currentUser.id) : '';
        const res = await fetchWithTimeout(
            `${apiBase}/shipment?u=${u}&t=${Date.now()}`,
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

        shipmentItems = data.map(it => ({
            code: String(it.Code || ''),
            name: String(it.Name || ''),
            price: Number(it.price) || 0,
            maxQty: Number(it.quantity) || 0,
            qty: 0
        }));

        renderShipmentBody();
    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        body.innerHTML = `<div class="assort-error">Не вдалося завантажити товари: ${escapeHtml(message)}</div>`;
    } finally {
        shipmentLoading = false;
    }
}

function renderShipmentBody() {
    const body = document.getElementById('shipmentBody');
    if (!body) return;

    body.innerHTML = `
        <div class="assort-top">
            <div class="assort-search-wrap">
                <input type="search" class="assort-search" id="shipmentSearch"
                    placeholder="Пошук товару за назвою або кодом"
                    autocomplete="off" value="${escapeHtml(shipmentSearchQuery)}">
            </div>
        </div>

        <div class="assort-panel">
            <div class="assort-pills" style="margin-top:0;">
                <span class="assort-pill" id="shipmentCounter">${shipmentItems.length} поз.</span>
            </div>
            <div id="shipmentGrid" class="assort-grid" style="margin-top:14px;">
                ${renderShipmentRows()}
            </div>
            <div id="shipmentNoMatch" class="empty-state" style="display:none; margin-top:14px;">
                Нічого не знайдено
            </div>
        </div>
    `;

    const searchInput = document.getElementById('shipmentSearch');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            shipmentSearchQuery = searchInput.value.trim().toLowerCase();
            applyShipmentSearch();
        });
    }

    const grid = document.getElementById('shipmentGrid');
    grid.addEventListener('click', e => {
        const btn = e.target.closest('.qty-btn');
        if (!btn) return;
        const row = btn.closest('[data-shipment-row]');
        if (!row) return;
        const idx = Number(row.dataset.idx);
        if (!shipmentItems[idx]) return;

        const step = Number(btn.dataset.step) || 0;
        const maxQ = shipmentItems[idx].maxQty;
        let next = shipmentItems[idx].qty + step;
        if (next < 0) next = 0;
        if (next > maxQ) next = maxQ;
        shipmentItems[idx].qty = next;

        const inp = row.querySelector('.qty-input');
        if (inp) inp.value = next;

        updateShipmentRow(row, idx);
        updateShipmentSummary();
    });

    grid.addEventListener('input', e => {
        if (!e.target.classList.contains('qty-input')) return;
        const row = e.target.closest('[data-shipment-row]');
        if (!row) return;
        const idx = Number(row.dataset.idx);
        if (!shipmentItems[idx]) return;

        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
        let val = Number(e.target.value) || 0;
        const maxQ = shipmentItems[idx].maxQty;
        if (val > maxQ) val = maxQ;
        shipmentItems[idx].qty = val;

        updateShipmentRow(row, idx);
        updateShipmentSummary();
    });

    grid.addEventListener('focusout', e => {
        if (!e.target.classList.contains('qty-input')) return;
        const row = e.target.closest('[data-shipment-row]');
        if (!row) return;
        const idx = Number(row.dataset.idx);
        if (!shipmentItems[idx]) return;
        e.target.value = shipmentItems[idx].qty;
    });

    document.querySelectorAll('#shipmentGrid [data-shipment-row]').forEach(row => {
        updateShipmentRow(row, Number(row.dataset.idx));
    });

    applyShipmentSearch();
    updateShipmentSummary();
}

function renderShipmentRows() {
    return shipmentItems.map((it, i) => `
        <div class="meter-input-group assort-row" data-shipment-row data-idx="${i}">
            <div class="assort-row-head">
                <strong class="assort-tile-name">${escapeHtml(it.name) || '—'}</strong>
                <span class="assort-row-price">Ціна: <strong>${fmt(it.price)} ₴</strong></span>
            </div>
            <div class="assort-row-fields">
                <div>
                    <label>На складі</label>
                    <div class="assort-field-static">${fmt(it.maxQty)}</div>
                </div>
                <div>
                    <label>Відвантажити</label>
                    <div class="qty">
                        <button type="button" class="qty-btn" data-step="-1" aria-label="Менше">−</button>
                        <input type="text" class="qty-input" inputmode="numeric" value="0" aria-label="Кількість">
                        <button type="button" class="qty-btn" data-step="1" aria-label="Більше">+</button>
                    </div>
                </div>
                <div>
                    <label>Сума</label>
                    <div class="assort-row-total">0 ₴</div>
                </div>
            </div>
        </div>
    `).join('');
}

function updateShipmentRow(row, idx) {
    const it = shipmentItems[idx];
    if (!it) return;
    const totalEl = row.querySelector('.assort-row-total');
    if (totalEl) totalEl.textContent = `${fmt(it.qty * it.price)} ₴`;
    row.classList.toggle('picked', it.qty > 0);
}

function updateShipmentSummary() {
    const summary = document.getElementById('shipmentSummary');
    const btn = document.getElementById('shipmentSendBtn');
    if (!summary || !btn) return;

    let count = 0;
    let sum = 0;
    shipmentItems.forEach(it => {
        if (it.qty > 0) {
            count++;
            sum += it.qty * it.price;
        }
    });

    if (!count) {
        summary.textContent = 'Вкажіть кількість товарів для відвантаження';
        btn.disabled = true;
        return;
    }

    summary.innerHTML = `Відвантажуємо: <b>${count} поз.</b> на <b>${fmt(sum)} ₴</b>`;
    btn.disabled = shipmentSending || !navigator.onLine;
}

function applyShipmentSearch() {
    const q = shipmentSearchQuery;
    let shown = 0;

    document.querySelectorAll('#shipmentGrid [data-shipment-row]').forEach(row => {
        const idx = Number(row.dataset.idx);
        const it = shipmentItems[idx];
        if (!it) return;
        const hay = (it.name + ' ' + it.code).toLowerCase();
        const ok = !q || hay.includes(q);
        row.style.display = ok ? '' : 'none';
        if (ok) shown++;
    });

    const noMatch = document.getElementById('shipmentNoMatch');
    if (noMatch) noMatch.style.display = shown ? 'none' : 'block';
}

async function submitShipment() {
    if (shipmentSending) return;
    const pointId = shipmentPointId;
    if (!pointId) return;

    const items = [];
    shipmentItems.forEach(it => {
        if (it.qty > 0) {
            items.push({
                code: it.code,
                name: it.name,
                price: it.price,
                qty: it.qty
            });
        }
    });

    if (!items.length) {
        showToast('Додайте хоча б одну позицію', true);
        return;
    }

    if (!navigator.onLine) {
        showToast('Немає мережі! Відвантаження можна відправити лише онлайн.', true);
        return;
    }

    const payload = {
        point_id: pointId,
        technician_id: currentUser ? currentUser.id : '',
        request_id: shipmentRequestId || newRequestId(),
        items
    };

    const btn = document.getElementById('shipmentSendBtn');
    const closeBtn = document.querySelector('#shipmentOverlay .modal-close');

    shipmentSending = true;
    if (closeBtn) closeBtn.disabled = true;
    setBtnLoading(btn, 'Відправка...');

    let success = false;
    let conductError = '';

    try {
        const res = await fetchWithTimeout(
            `${apiBase}/shipment?v=${APP_CONFIG.apiVersion}`,
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
            throw new Error((errText && errText.slice(0, 200)) || 'Помилка сервера 1С');
        }

        let body = null;
        try { body = await res.json(); } catch (e) {}

        const raw = (body && body.conduct_error != null) ? String(body.conduct_error) : '';
        conductError = isBlankServerError(raw) ? '' : raw;

        success = true;
    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        const msg = (message.includes('Failed to fetch') || message.toLowerCase().includes('timeout'))
            ? '1С не відповідає. Відвантаження не відправлено.'
            : `Не вдалося відвантажити: ${message}`;
        showToast(msg, true);
    } finally {
        shipmentSending = false;
        if (closeBtn) closeBtn.disabled = false;
        resetBtn(btn, 'Відвантажити');

        if (success) {
            if (conductError) {
                console.error('[1С] відвантаження не проведено:', conductError);
                showToast('Документ створено, але НЕ ПРОВЕДЕНО: ' + conductError.slice(0, 150), true);
            } else {
                showSuccessAnimation();
                showToast('Відвантаження створено в 1С');
            }

            shipmentItems = [];
            shipmentPointId = null;
            closeShipmentModal();
            loadData({ silent: true });
        } else {
            updateShipmentSummary();
        }
    }
}