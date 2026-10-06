let currentUser = null;

// ─── восстановление сессии ─────────────────────────────
(function checkInitialAuth() {
    try {
        const saved = localStorage.getItem('currentUser');
        if (!saved) return;
        const parsed = JSON.parse(saved);
        if (parsed && parsed.id) currentUser = parsed;
        else localStorage.removeItem('currentUser');
    } catch (e) {
        localStorage.removeItem('currentUser');
        currentUser = null;
    }
})();

// ─── настройка экрана входа ────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const authOverlay = document.getElementById('authOverlay');
    const pinInput = document.getElementById('pinInput');

    if (currentUser) {
        if (authOverlay) authOverlay.style.display = 'none';
        showUserInfo();
        if (typeof startApp === 'function') startApp();
    } else {
        if (authOverlay) authOverlay.style.display = 'flex';
        if (pinInput) pinInput.focus();
    }

    if (pinInput) {
        // только цифры
        pinInput.addEventListener('input', () => {
            pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 12);
            const err = document.getElementById('authError');
            if (err) err.style.display = 'none';
        });

        pinInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); login(); }
        });
    }
});

// ─── вход ──────────────────────────────────────────────
async function login() {
    const pinInput = document.getElementById('pinInput');
    const errorMsg = document.getElementById('authError');
    const authOverlay = document.getElementById('authOverlay');
    const loginBtn = authOverlay ? authOverlay.querySelector('.action-btn') : null;

    if (!pinInput || !errorMsg || !authOverlay || !loginBtn) return;

    const pin = pinInput.value.trim();
    if (!pin) {
        errorMsg.textContent = 'Введіть ПІН-код';
        errorMsg.style.display = 'block';
        pinInput.focus();
        return;
    }

    loginBtn.disabled = true;
    loginBtn.textContent = 'Перевірка...';
    errorMsg.style.display = 'none';

    try {
        const apiBaseUrl = String(APP_CONFIG.apiBase).replace(/\/+$/, '');
        const response = await fetch(`${apiBaseUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin })
        });

        if (!response.ok) throw new Error('server');

        const data = await response.json();
        if (!data || !data.Code || String(data.Code) === '0') {
            throw new Error('pin');
        }

        currentUser = {
            id: String(data.Code),
            name: data.Name || 'Користувач',
            isAdmin: data.IsAdmin === true
        };
        localStorage.setItem('currentUser', JSON.stringify(currentUser));

        authOverlay.classList.add('fade-out');
        setTimeout(() => {
            authOverlay.style.display = 'none';
            authOverlay.classList.remove('fade-out');
        }, 250);

        pinInput.value = '';
        showUserInfo();
        if (typeof startApp === 'function') startApp();

    } catch (err) {
        const isPin = err && err.message === 'pin';
        errorMsg.textContent = isPin ? 'Невірний ПІН-код' : 'Немає зв\'язку з 1С';
        errorMsg.style.display = 'block';

        if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
        pinInput.classList.remove('shake');
        void pinInput.offsetWidth;
        pinInput.classList.add('shake');
        pinInput.value = '';
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Увійти';
        pinInput.focus();
    }
}

// ─── выход ─────────────────────────────────────────────
function logout() {
    document.querySelectorAll('.modal-overlay.active')
        .forEach(m => m.classList.remove('active'));

    localStorage.removeItem('currentUser');
    currentUser = null;

    const authOverlay = document.getElementById('authOverlay');
    if (authOverlay) authOverlay.style.display = 'flex';

    const pinInput = document.getElementById('pinInput');
    if (pinInput) { pinInput.value = ''; pinInput.focus(); }

    const userBadge = document.getElementById('userBadge');
    if (userBadge) userBadge.replaceChildren();

    const resultsContainer = document.getElementById('resultsContainer');
    if (resultsContainer) resultsContainer.innerHTML = '';

    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = '';

    if (typeof resetAppState === 'function') resetAppState();
}

// ─── шапка с пользователем ─────────────────────────────
function showUserInfo() {
    const userBadge = document.getElementById('userBadge');
    if (!userBadge || !currentUser) return;

    const name = document.createElement('span');
    name.className = 'user-name';
    name.textContent = `👤 ${currentUser.name}`;

    const btn = document.createElement('button');
    btn.className = 'logout-btn';
    btn.type = 'button';
    btn.textContent = 'Вийти';
    btn.addEventListener('click', logout);

    userBadge.replaceChildren(name, btn);
}