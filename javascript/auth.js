let currentUser = null;

// проверка активной сессии при старте
(function checkInitialAuth() {
    const savedUser = localStorage.getItem('currentUser');
    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
        } catch (e) {
            localStorage.removeItem('currentUser');
        }
    }
})();

// настройка экранов после загрузки страницы
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
        pinInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') login();
        });
    }
});

// боевая логика входа через 1С
async function login() {
    const pinInput = document.getElementById('pinInput');
    const errorMsg = document.getElementById('authError');
    const authOverlay = document.getElementById('authOverlay');
    const loginBtn = authOverlay.querySelector('.action-btn');

    if (!pinInput) return;
    const pin = pinInput.value.trim();
    if (!pin) return;

    // блокируем интерфейс на время запроса к 1С
    loginBtn.disabled = true;
    loginBtn.textContent = 'Проверка...';
    errorMsg.style.display = 'none';

    try {
        const apiBaseUrl = String(APP_CONFIG.apiBase).replace(/\/+$/, '');

        // отправляем ПИН-код на маршрут /login в 1С
        const response = await fetch(`${apiBaseUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: pin })
        });

        if (!response.ok) throw new Error('Ошибка сервера 1С');

        const data = await response.json();

        // 1С возвращает Code "0" для неверных пин-кодов
        if (data.Code && String(data.Code) !== "0") {
            // успех! Сохраняем реальные данные из 1С
            currentUser = { id: String(data.Code), name: data.Name };
            localStorage.setItem('currentUser', JSON.stringify(currentUser));

            authOverlay.classList.add('fade-out');
            setTimeout(() => {
                authOverlay.style.display = 'none';
                authOverlay.classList.remove('fade-out');
            }, 300);

            pinInput.value = '';
            showUserInfo();

            // запускаем загрузку данных приложения
            if (typeof startApp === 'function') startApp();
        } else {
            // 1С ответила "НЕ ЗНАЙДЕНО"
            throw new Error('Неверный ПИН-код');
        }

    } catch (err) {
        errorMsg.textContent = err.message === 'Неверный ПИН-код' ? 'Неверный ПИН-код' : 'Нет связи с 1С';
        errorMsg.style.display = 'block';

        if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
        pinInput.classList.remove('shake');
        void pinInput.offsetWidth; // перезапуск анимации
        pinInput.classList.add('shake');
        pinInput.value = '';
    } finally {
        // возвращаем кнопку в исходное состояние
        loginBtn.disabled = false;
        loginBtn.textContent = 'Войти';
        pinInput.focus();
    }
}

// логика выхода из системы
function logout() {
    // закрываем все активные модалки, чтобы следующий пользователь
    // не увидел чужое состояние
    document.querySelectorAll('.modal-overlay.active')
        .forEach(m => m.classList.remove('active'));

    localStorage.removeItem('currentUser');
    currentUser = null;

    const authOverlay = document.getElementById('authOverlay');
    if (authOverlay) authOverlay.style.display = 'flex';

    const pinInput = document.getElementById('pinInput');
    if (pinInput) {
        pinInput.focus();
        pinInput.value = '';
    }

    const userBadge = document.getElementById('userBadge');
    if (userBadge) userBadge.innerHTML = '';

    const resultsContainer = document.getElementById('resultsContainer');
    if (resultsContainer) resultsContainer.innerHTML = '';

    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = '';

    if (typeof resetAppState === 'function') resetAppState();
}

// вывод имени пользователя в шапку
function showUserInfo() {
    const userBadge = document.getElementById('userBadge');
    if (userBadge && currentUser) {
        userBadge.textContent = `👤 ${currentUser.name} `;
        const btn = document.createElement('button');
        btn.className = 'logout-btn';
        btn.textContent = 'Выйти';
        btn.addEventListener('click', logout);
        userBadge.appendChild(btn);
    }
}