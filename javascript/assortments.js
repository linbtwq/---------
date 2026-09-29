
// использует глобальные из script.js: apiBase, fetchWithTimeout, localDB, globalData,
// escapeHtml, fmt, showToast, rememberFocus, restoreFocus, getTopModal, APP_CONFIG.

let assortList = null;
let assortLoading = false;

function ensureAssortModal() {
    let el = document.getElementById('assortOverlay');
    if (el) return el;

    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'assortOverlay';
    el.style.zIndex = '1005';
    el.innerHTML = `
        <div class="modal-box">
            <div class="modal-header">
                <h3 id="assortTitle">Ассортимент</h3>
                <button class="modal-close" type="button">✕</button>
            </div>
            <div class="modal-body" id="assortBody"></div>
            <div class="modal-footer">
                <button class="action-btn btn-secondary" type="button" id="assortCloseBtn">Закрыть</button>
            </div>
        </div>`;
    document.body.appendChild(el);

    el.querySelector('.modal-close').addEventListener('click', closeAssortModal);
    el.querySelector('#assortCloseBtn').addEventListener('click', closeAssortModal);
    return el;
}

async function loadAssortments() {
    try {
        const res = await fetchWithTimeout(
            `${apiBase}/assortments?t=${Date.now()}`,
            { method: 'GET', cache: 'no-store' },
            APP_CONFIG.loadTimeoutMs
        );
        if (!res.ok) throw new Error('Ошибка сети');
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Неверный ответ 1С');
        assortList = data;
        try { await localDB.save('cachedAssortments', data); } catch (e) {}
        return { data, offline: false };
    } catch (err) {
        try {
            const cached = await localDB.load('cachedAssortments');
            if (Array.isArray(cached)) {
                assortList = cached;
                return { data: cached, offline: true };
            }
        } catch (e) {}
        throw err;
    }
}

function assortItemRows(items) {
    if (!items || !items.length) return '<div style="color:#94a3b8; padding:6px 0;">Состав пуст</div>';
    return items.map(it => `
        <div style="display:flex; justify-content:space-between; gap:12px; padding:6px 0; border-bottom:1px solid rgba(148,163,184,.25);">
            <span>${escapeHtml(it.name)}${it.tech_card ? `<br><small style="color:#94a3b8;">${escapeHtml(it.tech_card)}</small>` : ''}</span>
            <strong style="white-space:nowrap;">${fmt(Number(it.price) || 0)} ₴</strong>
        </div>`).join('');
}

function renderAssortBody(point, list, offline) {
    const current = Array.isArray(point.assortment) && point.coffee_machine ? point.assortment : [];

    const currentHtml = `
        <div style="margin-bottom:16px;">
            <div style="font-size:.85rem; color:#64748b; margin-bottom:6px;">
                Сейчас на аппарате${point.coffee_machine ? ': ' + escapeHtml(point.coffee_machine) : ''}
            </div>
            ${current.length
                ? current.map(it => `
                    <div style="display:flex; justify-content:space-between; gap:12px; padding:4px 0;">
                        <span>${escapeHtml(it.name)}</span>
                        <strong>${fmt(Number(it.price) || 0)} ₴</strong>
                    </div>`).join('')
                : '<div style="color:#94a3b8;">К точке не привязан аппарат</div>'}
        </div>`;

    const listHtml = list.length
        ? list.map(a => `
            <details style="margin-bottom:8px; border:1px solid rgba(148,163,184,.4); border-radius:10px; padding:8px 12px;">
                <summary style="cursor:pointer; font-weight:600;">
                    ${escapeHtml(a.name) || 'Без названия'}
                    <span style="color:#94a3b8; font-weight:400;"> · ${(a.items || []).length} поз.${a.code ? ' · ' + escapeHtml(a.code) : ''}</span>
                </summary>
                ${a.description ? `<div style="margin:8px 0; color:#64748b;">${escapeHtml(a.description)}</div>` : ''}
                ${a.comment ? `<div style="margin:8px 0; color:#64748b; font-style:italic;">${escapeHtml(a.comment)}</div>` : ''}
                ${assortItemRows(a.items)}
            </details>`).join('')
        : '<div class="empty-state">Ассортиментов в 1С не найдено</div>';

    document.getElementById('assortBody').innerHTML = `
        ${offline ? '<div style="color:#f59e0b; margin-bottom:10px;">Оффлайн. Показаны сохранённые данные</div>' : ''}
        ${currentHtml}
        <div style="font-size:.85rem; color:#64748b; margin-bottom:6px;">Доступные ассортименты</div>
        ${listHtml}`;
}

async function openAssortModal(pointId) {
    const point = globalData.find(i => String(i.id) === String(pointId));
    if (!point) return;
    if (assortLoading) return;

    rememberFocus();
    const overlay = ensureAssortModal();
    document.getElementById('assortTitle').textContent = `Ассортимент — ${point.point_name || 'точка ' + point.id}`;
    document.getElementById('assortBody').innerHTML = '<div class="empty-state">Загрузка...</div>';
    overlay.classList.add('active');

    assortLoading = true;
    try {
        const { data, offline } = await loadAssortments();
        renderAssortBody(point, data, offline);
    } catch (err) {
        document.getElementById('assortBody').innerHTML =
            `<div class="auth-error" style="display:block;">Не удалось загрузить ассортименты: ${escapeHtml(err.message)}</div>`;
    } finally {
        assortLoading = false;
    }
}

function closeAssortModal() {
    document.getElementById('assortOverlay')?.classList.remove('active');
    if (!getTopModal()) restoreFocus();
}