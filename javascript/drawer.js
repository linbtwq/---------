
//панель слева
let _drawerBuilt = false;
let _drawerHandle = null;
let _drawerEl = null;
let _drawerOverlay = null;
let _drawerPrevFocus = null;

function ensureDrawer() {
    if (_drawerBuilt) return;
    _drawerBuilt = true;

    _drawerHandle = document.createElement('button');
    _drawerHandle.type = 'button';
    _drawerHandle.className = 'drawer-handle';
    _drawerHandle.setAttribute('aria-label', 'Відкрити панель');
    _drawerHandle.textContent = '›';
    _drawerHandle.addEventListener('click', openDrawer);

    _drawerOverlay = document.createElement('div');
    _drawerOverlay.className = 'drawer-overlay';
    _drawerOverlay.addEventListener('click', closeDrawer);

    _drawerEl = document.createElement('aside');
    _drawerEl.className = 'app-drawer';
    _drawerEl.id = 'appDrawer';
    _drawerEl.setAttribute('aria-hidden', 'true');
    _drawerEl.innerHTML = `
        <div class="drawer-head">
            <div class="drawer-user">
                <div class="drawer-avatar" id="drawerAvatar">?</div>
                <div class="drawer-user-text">
                    <div class="drawer-user-name" id="drawerUserName">—</div>
                    <div class="drawer-user-role" id="drawerUserRole"></div>
                </div>
            </div>
            <button type="button" class="drawer-close" id="drawerClose" aria-label="Закрити">✕</button>
        </div>
        <div class="drawer-body">
            <div id="drawerGoods"></div>
        </div>
        <div class="drawer-foot" id="drawerFoot"></div>
    `;

    document.body.appendChild(_drawerHandle);
    document.body.appendChild(_drawerOverlay);
    document.body.appendChild(_drawerEl);

    _drawerEl.querySelector('#drawerClose').addEventListener('click', closeDrawer);
}

function updateDrawerUser() {
    if (!_drawerEl) return;
    const nameEl   = _drawerEl.querySelector('#drawerUserName');
    const roleEl   = _drawerEl.querySelector('#drawerUserRole');
    const avatarEl = _drawerEl.querySelector('#drawerAvatar');
    const footEl   = _drawerEl.querySelector('#drawerFoot');

    if (currentUser) {
        const name = currentUser.name || 'Користувач';
        nameEl.textContent = name;
        roleEl.textContent = currentUser.isAdmin ? 'Адміністратор' : 'Технік';
        avatarEl.textContent = name.trim().charAt(0).toUpperCase() || '?';
    } else {
        nameEl.textContent = '—';
        roleEl.textContent = '';
        avatarEl.textContent = '?';
    }

    if (footEl && typeof APP_VERSION !== 'undefined') {
        footEl.textContent = 'v' + APP_VERSION;
    }
}

function openDrawer() {
    ensureDrawer();
    if (_drawerEl.classList.contains('open')) return;

    _drawerPrevFocus = document.activeElement;
    _drawerEl.classList.add('open');
    _drawerEl.setAttribute('aria-hidden', 'false');
    _drawerOverlay.classList.add('active');
    document.body.classList.add('drawer-open');

    updateDrawerUser();
    if (typeof refreshDrawerGoods === 'function') {
        refreshDrawerGoods();
    }

    setTimeout(() => {
        const btn = _drawerEl.querySelector('#drawerClose');
        if (btn) btn.focus();
    }, 80);
}

function closeDrawer() {
    if (!_drawerEl || !_drawerEl.classList.contains('open')) return;
    _drawerEl.classList.remove('open');
    _drawerEl.setAttribute('aria-hidden', 'true');
    _drawerOverlay.classList.remove('active');
    document.body.classList.remove('drawer-open');

    if (_drawerPrevFocus && document.contains(_drawerPrevFocus)) {
        try { _drawerPrevFocus.focus(); } catch (e) {}
    }
    _drawerPrevFocus = null;
}

function isDrawerOpen() {
    return !!_drawerEl && _drawerEl.classList.contains('open');
}

/* Escape закриває панель */
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isDrawerOpen()) {
        e.preventDefault();
        closeDrawer();
    }
});

/* свайп справа налево закрыть */
let _drawerTouchX = 0;
let _drawerTouchY = 0;

document.addEventListener('touchstart', (e) => {
    if (!isDrawerOpen()) return;
    const t = e.touches[0];
    _drawerTouchX = t.clientX;
    _drawerTouchY = t.clientY;
}, { passive: true });

document.addEventListener('touchend', (e) => {
    if (!isDrawerOpen()) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - _drawerTouchX;
    const dy = t.clientY - _drawerTouchY;
    if (dx < -60 && Math.abs(dy) < Math.abs(dx) / 1.5) {
        closeDrawer();
    }
}, { passive: true });

// инициализируем при загрузке DOM
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureDrawer);
} else {
    ensureDrawer();
}