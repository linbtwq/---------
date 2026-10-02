// javascript/optimize.js
// оптимизация ui минимальная и безопасная

(function () {
    'use strict';

    // троттл хелпер глобально
    if (typeof window.throttle !== 'function') {
        window.throttle = function (fn, wait) {
            let last = 0;
            let timer = null;
            return function (...args) {
                const now = Date.now();
                const remain = wait - (now - last);
                if (remain <= 0) {
                    last = now;
                    fn.apply(this, args);
                } else if (!timer) {
                    timer = setTimeout(() => {
                        last = Date.now();
                        timer = null;
                        fn.apply(this, args);
                    }, remain);
                }
            };
        };
    }

    // пауза анимаций когда вкладка скрыта
    document.addEventListener('visibilitychange', () => {
        document.body.classList.toggle('is-hidden', document.hidden);
    });

    // не рендерим статус когда вкладка скрыта
    if (typeof window.renderStatus === 'function') {
        const origRenderStatus = window.renderStatus;
        window.renderStatus = function (...args) {
            if (document.hidden) return;
            return origRenderStatus.apply(this, args);
        };
    }

    // при быстром скролле отключаем transition карточек
    const resultsContainer = document.getElementById('resultsContainer');
    if (resultsContainer) {
        let scrollTimer = null;

        resultsContainer.addEventListener('scroll', () => {
            if (!resultsContainer.classList.contains('is-scrolling')) {
                resultsContainer.classList.add('is-scrolling');
            }
            clearTimeout(scrollTimer);
            scrollTimer = setTimeout(() => {
                resultsContainer.classList.remove('is-scrolling');
            }, 200);
        }, { passive: true });
    }

})();