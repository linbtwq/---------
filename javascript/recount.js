// javascript/recount.js
// перерасчет (інвентаризація) окрема модалка
//
// данные:
//   GET  {apiBase}/recount?point=<код>
//   POST {apiBase}/recount_post
//
// использует глобальные из script.js:
//   apiBase, fetchWithTimeout, globalData, escapeHtml, fmt,
//   rememberFocus, restoreFocus, getTopModal, APP_CONFIG,
//   newRequestId, showToast, showSuccessAnimation, setBtnLoading,
//   resetBtn, currentUser, loadData.

let recountLoading = false;
let recountSending = false;
let recountItems = [];
let recountPointId = null;

function ensureRecountModal() {
    let el = document.getElementById('recountOverlay');
    if (el) return el;

    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'recountOverlay';
    el.style.zIndex = '1005';

    el.innerHTML = `
        <div class="modal-box assort-box">
            <div class="modal-header">
                <div class="assort-head">
                    <h3>Перерахунок</h3>
                    <div class="assort-sub" id="recountSub"></div>
                </div>
                <button class="modal-close" type="button" aria-label="Закрити">✕</button>
            </div>
            <div class="modal-body" id="recountBody"></div>
            <div class="modal-footer order-footer">
                <div class="order-summary" id="recountSummary"></div>
                <button class="action-btn btn-success" type="button" id="recountSendBtn" disabled>Відправити в 1С</button>
            </div>
        </div>
    `;

    document.body.appendChild(el);

    el.querySelector('.modal-close').addEventListener('click', closeRecountModal);
    el.querySelector('#recountSendBtn').addEventListener('click', submitRecount);

    return el;
}

function closeRecountModal() {
    if (recountSending) return;
    document.getElementById('recountOverlay')?.classList.remove('active');
    if (typeof getTopModal === 'function' && !getTopModal() && typeof restoreFocus === 'function') {
        restoreFocus();
    }
}

async function openRecountModal(pointId) {
    const point = globalData.find(i => String(i.id) === String(pointId));
    if (!point || recountLoading) return;

    rememberFocus();

    const overlay = ensureRecountModal();
    const sub = document.getElementById('recountSub');
    const body = document.getElementById('recountBody');
    const summary = document.getElementById('recountSummary');
    const sendBtn = document.getElementById('recountSendBtn');

    recountPointId = point.id;
    recountItems = [];

    const subParts = [point.point_name || 'Точка', `код ${point.id}`];
    if (point.coffee_machine) {
        subParts.push(point.coffee_machine + (point.coffee_machine_code ? ` (${point.coffee_machine_code})` : ''));
    }
    sub.textContent = subParts.join(' · ');
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
    recountLoading = true;

    try {
        const res = await fetchWithTimeout(
            `${apiBase}/recount?point=${encodeURIComponent(point.id)}&t=${Date.now()}`,
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

        recountItems = data.map(it => ({
            Code: String(it.Code || ''),
            Name: String(it.Name || ''),
            price: Number(it.price) || 0,
            book: Number(it.book) || 0,
            actual: Number(it.book) || 0
        }));

        renderRecountBody();

    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        body.innerHTML = `<div class="assort-error">Не вдалося завантажити перерахунок: ${escapeHtml(message)}</div>`;
    } finally {
        recountLoading = false;
    }
}

function renderRecountBody() {
    const body = document.getElementById('recountBody');

    body.innerHTML = `
        <div class="assort-panel">
            <div class="assort-pills" style="margin-top:0;">
                <span class="assort-pill">${recountItems.length} поз.</span>
            </div>
            <div id="recountGrid" class="assort-grid" style="margin-top:14px;">
                ${recountItems.map((it, i) => {
                    return `
                        <div class="meter-input-group assort-row" data-recount-row data-idx="${i}">
                            <div class="assort-row-head">
                                <strong class="assort-tile-name">${escapeHtml(it.Name) || '—'}</strong>
                                <span class="assort-row-price">Ціна: <strong>${fmt(it.price)} ₴</strong></span>
                            </div>
                            <div class="assort-row-fields">
                                <div>
                                    <label>Учётное</label>
                                    <div class="assort-field-static">${fmt(it.book)}</div>
                                </div>
                                <div>
                                    <label>Фактичне</label>
                                    <div class="qty">
                                        <button type="button" class="qty-btn" data-step="-1" aria-label="Менше">−</button>
                                        <input type="text" class="qty-input" inputmode="numeric" value="${it.actual}" aria-label="Фактичне">
                                        <button type="button" class="qty-btn" data-step="1" aria-label="Більше">+</button>
                                    </div>
                                </div>
                                <div>
                                    <label>Відхилення</label>
                                    <div class="recount-deviation zero">0 шт · 0 ₴</div>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;

    const grid = document.getElementById('recountGrid');

    grid.addEventListener('click', e => {
        const btn = e.target.closest('.qty-btn');
        if (!btn) return;

        const row = btn.closest('[data-recount-row]');
        if (!row) return;

        const idx = Number(row.dataset.idx);
        if (!recountItems[idx]) return;

        const step = Number(btn.dataset.step) || 0;
        recountItems[idx].actual = Math.max(0, recountItems[idx].actual + step);

        const inp = row.querySelector('.qty-input');
        if (inp) inp.value = recountItems[idx].actual;

        updateRecountRow(row, idx);
        updateRecountSummary();
    });

    grid.addEventListener('input', e => {
        if (!e.target.classList.contains('qty-input')) return;

        const row = e.target.closest('[data-recount-row]');
        if (!row) return;

        const idx = Number(row.dataset.idx);
        if (!recountItems[idx]) return;

        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
        recountItems[idx].actual = Number(e.target.value) || 0;

        updateRecountRow(row, idx);
        updateRecountSummary();
    });

    grid.addEventListener('focusout', e => {
        if (!e.target.classList.contains('qty-input')) return;
        const row = e.target.closest('[data-recount-row]');
        if (!row) return;
        const idx = Number(row.dataset.idx);
        if (!recountItems[idx]) return;
        e.target.value = recountItems[idx].actual;
    });

    document.querySelectorAll('#recountGrid [data-recount-row]').forEach(row => {
        updateRecountRow(row, Number(row.dataset.idx));
    });

    updateRecountSummary();
}

function updateRecountRow(row, idx) {
    const it = recountItems[idx];
    if (!it) return;

    const deviation = it.actual - it.book;
    const sumDeviation = deviation * it.price;

    const devEl = row.querySelector('.recount-deviation');
    if (devEl) {
        let cls = 'recount-deviation';
        if (deviation > 0) cls += ' positive';
        else if (deviation < 0) cls += ' negative';
        else cls += ' zero';

        const sign = deviation > 0 ? '+' : '';
        devEl.className = cls;
        devEl.textContent = `${sign}${fmt(deviation)} шт · ${sign}${fmt(sumDeviation)} ₴`;
    }
}

function updateRecountSummary() {
    const summary = document.getElementById('recountSummary');
    const btn = document.getElementById('recountSendBtn');
    if (!summary || !btn) return;

    let totalQty = 0;
    let totalSum = 0;

    recountItems.forEach(it => {
        const dev = it.actual - it.book;
        totalQty += dev;
        totalSum += dev * it.price;
    });

    const signQty = totalQty > 0 ? '+' : '';
    const signSum = totalSum > 0 ? '+' : '';

    summary.innerHTML = `Разом: <b>${signQty}${fmt(totalQty)} шт</b> на <b>${signSum}${fmt(totalSum)} ₴</b>`;

    btn.disabled = recountSending || totalQty === 0;
}

async function submitRecount() {
    if (recountSending) return;

    const pointId = recountPointId;
    if (!pointId) return;

    let totalQty = 0;
    recountItems.forEach(it => { totalQty += (it.actual - it.book); });

    if (!totalQty) {
        showToast('Немає відхилень — нічого відправляти', true);
        return;
    }

    if (!navigator.onLine) {
        showToast('Немає мережі! Перерахунок можна відправити лише онлайн.', true);
        return;
    }

    const items = recountItems.map(it => ({
        code: it.Code,
        name: it.Name,
        price: it.price,
        book: it.book,
        actual: it.actual
    }));

    const payload = {
        point_id: pointId,
        technician_id: currentUser ? currentUser.id : '',
        request_id: newRequestId(),
        items
    };

    const btn = document.getElementById('recountSendBtn');
    const closeBtn = document.querySelector('#recountOverlay .modal-close');

    recountSending = true;
    if (closeBtn) closeBtn.disabled = true;
    setBtnLoading(btn, 'Відправка...');

    let success = false;

    try {
        const res = await fetchWithTimeout(
            `${apiBase}/recount?v=${APP_CONFIG.apiVersion}`,
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

        success = true;

    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        const msg = (message.includes('Failed to fetch') || message.toLowerCase().includes('timeout'))
            ? '1С не відповідає. Перерахунок не відправлено.'
            : `Не вдалося відправити: ${message}`;
        showToast(msg, true);
    } finally {
        recountSending = false;
        if (closeBtn) closeBtn.disabled = false;
        resetBtn(btn, 'Відправити в 1С');

        if (success) {
            showSuccessAnimation();
            showToast('Перерахунок відправлено в 1С');

            recountItems = [];
            recountPointId = null;

            closeRecountModal();
            loadData({ silent: true });
        } else {
            updateRecountSummary();
        }
    }
}