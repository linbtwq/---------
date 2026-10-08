// javascript/notes.js
// примітки по точці, історія записів з автором і датою

let noteLoading = false;
let noteSending = false;
let notePointId = null;
// один идентификатор на одну примітку чтобы повторная отправка не создала дубль
let noteRequestId = null;
let noteTag = '';
let noteItems = [];

const NOTE_MAX = 500;
const NOTE_TAGS = [
    { id: 'access',  label: 'Ключ / доступ' },
    { id: 'service', label: 'Потрібен сервіс' },
    { id: 'broken',  label: 'Не працює' },
    { id: 'other',   label: 'Інше' }
];

function noteTagLabel(id) {
    const t = NOTE_TAGS.find(x => x.id === id);
    return t ? t.label : '';
}

// сервер отдает дату как 2026-10-06 14:20:00
function noteDateText(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ''));
    return m ? `${m[3]}.${m[2]}.${m[1]}, ${m[4]}:${m[5]}` : String(s || '');
}

function ensureNoteModal() {
    let el = document.getElementById('noteOverlay');
    if (el) return el;

    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'noteOverlay';
    el.style.zIndex = '1006';

    el.innerHTML = `
        <div class="modal-box assort-box note-box">
            <div class="modal-header">
                <div class="assort-head">
                    <h3>Примітка</h3>
                    <div class="assort-sub" id="noteSub"></div>
                </div>
                <button class="modal-close" type="button" aria-label="Закрити">✕</button>
            </div>
            <div class="modal-body" id="noteBody">
                <div class="note-new">
                    <textarea id="noteText" class="note-text" rows="3" maxlength="${NOTE_MAX}"
                        placeholder="Напишіть примітку..." aria-label="Нова примітка"></textarea>
                    <div class="note-meta">
                        <span>Нова примітка</span>
                        <span id="noteCounter">0 / ${NOTE_MAX}</span>
                    </div>
                    <div class="note-chips" id="noteChips">
                        ${NOTE_TAGS.map(t => `<button type="button" class="note-chip" data-tag="${t.id}">${t.label}</button>`).join('')}
                    </div>
                </div>
                <div class="note-history">
                    <div class="note-history-title" id="noteHistoryTitle">Історія</div>
                    <div id="noteList"></div>
                </div>
            </div>
            <div class="modal-footer order-footer">
                <div class="order-summary">Бачать усі співробітники</div>
                <button class="action-btn btn-success" type="button" id="noteSendBtn" disabled>Зберегти</button>
            </div>
        </div>
    `;

    document.body.appendChild(el);

    el.querySelector('.modal-close').addEventListener('click', closeNoteModal);
    el.querySelector('#noteSendBtn').addEventListener('click', submitNote);

    const ta = el.querySelector('#noteText');
    ta.addEventListener('input', updateNoteForm);
    ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submitNote();
        }
    });

    el.querySelector('#noteChips').addEventListener('click', e => {
        const chip = e.target.closest('.note-chip');
        if (!chip) return;
        noteTag = (noteTag === chip.dataset.tag) ? '' : chip.dataset.tag;
        updateNoteForm();
    });

    return el;
}

function updateNoteForm() {
    const ta = document.getElementById('noteText');
    const counter = document.getElementById('noteCounter');
    const btn = document.getElementById('noteSendBtn');
    if (!ta || !counter || !btn) return;

    counter.textContent = `${ta.value.length} / ${NOTE_MAX}`;
    document.querySelectorAll('#noteChips .note-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.tag === noteTag);
    });
    btn.disabled = noteSending || !ta.value.trim();
}

function closeNoteModal() {
    if (noteSending) return;
    document.getElementById('noteOverlay')?.classList.remove('active');
    notePointId = null;
    noteRequestId = null;
    noteTag = '';
    noteItems = [];
    if (typeof getTopModal === 'function' && !getTopModal() && typeof restoreFocus === 'function') {
        restoreFocus();
    }
}

async function openNoteModal(pointId) {
    const point = globalData.find(i => String(i.id) === String(pointId));
    if (!point || noteLoading) return;

    rememberFocus();

    const overlay = ensureNoteModal();
    notePointId = point.id;
    noteRequestId = newRequestId();
    noteTag = '';
    noteItems = [];

    document.getElementById('noteSub').textContent =
        [point.point_name || 'Точка', `код ${point.id}`].join(' · ');
    document.getElementById('noteText').value = '';
    document.getElementById('noteHistoryTitle').textContent = 'Історія';
    document.getElementById('noteList').innerHTML = `
        <div class="assort-loading">
            <div class="skeleton skeleton-text" style="width:70%;"></div>
            <div class="skeleton skeleton-text" style="width:90%;"></div>
        </div>
    `;
    updateNoteForm();

    overlay.classList.add('active');

    // на телефоне клавиатура закрыла бы историю поэтому фокус только на десктопе
    if (window.matchMedia('(pointer: fine)').matches) {
        setTimeout(() => document.getElementById('noteText')?.focus(), 60);
    }

    await loadNotes();
}

async function loadNotes() {
    const list = document.getElementById('noteList');
    const pointId = notePointId;
    noteLoading = true;

    try {
        const u = currentUser ? encodeURIComponent(currentUser.id) : '';
        const res = await fetchWithTimeout(
            `${apiBase}/notes?point=${encodeURIComponent(pointId)}&u=${u}&t=${Date.now()}`,
            { method: 'GET', cache: 'no-store' },
            APP_CONFIG.loadTimeoutMs
        );
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error((t && t.slice(0, 160)) || 'Помилка мережі');
        }
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Невірна відповідь 1С');

        // окно могли закрыть или открыть для другой точки пока шел запрос
        if (String(notePointId) !== String(pointId)) return;

        noteItems = data;
        renderNoteList();
    } catch (err) {
        if (String(notePointId) !== String(pointId)) return;
        const message = err && err.message ? err.message : String(err);
        list.innerHTML = `<div class="assort-error" style="margin:0;">Не вдалося завантажити історію: ${escapeHtml(message)}</div>`;
    } finally {
        noteLoading = false;
    }
}

function renderNoteList() {
    const list = document.getElementById('noteList');
    const title = document.getElementById('noteHistoryTitle');
    if (!list || !title) return;

    title.textContent = `Історія · ${noteItems.length}`;

    if (!noteItems.length) {
        list.innerHTML = '<div class="note-empty">Приміток ще немає</div>';
        return;
    }

    list.innerHTML = noteItems.map(n => {
        const tag = noteTagLabel(n.tag);
        const tagHtml = tag
            ? `<span class="note-tag ${escapeHtml(n.tag)}">${escapeHtml(tag)}</span>`
            : '';
        return `
            <div class="note-item">
                <div class="note-item-head">
                    <b>${escapeHtml(n.author || '—')}</b>
                    <span>${escapeHtml(noteDateText(n.date))}</span>
                </div>
                <div class="note-item-text">${tagHtml}${escapeHtml(n.text)}</div>
            </div>
        `;
    }).join('');
}

async function submitNote() {
    if (noteSending || !notePointId) return;

    const ta = document.getElementById('noteText');
    const text = ta.value.trim();
    if (!text) return;

    if (!navigator.onLine) {
        showToast('Немає мережі! Примітку можна зберегти лише онлайн.', true);
        return;
    }

    const payload = {
        point_id: notePointId,
        technician_id: currentUser ? currentUser.id : '',
        request_id: noteRequestId || newRequestId(),
        tag: noteTag,
        text: text.slice(0, NOTE_MAX)
    };

    const btn = document.getElementById('noteSendBtn');
    const closeBtn = document.querySelector('#noteOverlay .modal-close');

    noteSending = true;
    if (closeBtn) closeBtn.disabled = true;
    setBtnLoading(btn, 'Збереження...');

    let saved = null;

    try {
        const res = await fetchWithTimeout(
            `${apiBase}/notes?v=${APP_CONFIG.apiVersion}`,
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

        saved = (body && body.note) ? body.note : {
            author: currentUser ? currentUser.name : '',
            date: '',
            tag: payload.tag,
            text: payload.text
        };
    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        const msg = (message.includes('Failed to fetch') || message.toLowerCase().includes('timeout'))
            ? '1С не відповідає. Примітку не збережено.'
            : `Не вдалося зберегти: ${message}`;
        showToast(msg, true);
    } finally {
        noteSending = false;
        if (closeBtn) closeBtn.disabled = false;
        resetBtn(btn, 'Зберегти');

        if (saved) {
            noteItems.unshift(saved);
            renderNoteList();
            ta.value = '';
            noteTag = '';
            // следующая примітка получает новый идентификатор
            noteRequestId = newRequestId();
            showToast('Примітку збережено');
        }
        updateNoteForm();
    }
}