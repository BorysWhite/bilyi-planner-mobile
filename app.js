// ============ Мій Хаб (iPhone PWA) — завдання + фінанси ============

const defaultCategories = [
    { id: 'food', name: 'Продукти', color: '#34c759' },
    { id: 'utilities', name: 'Комунальні', color: '#5ac8fa' },
    { id: 'transport', name: 'Транспорт', color: '#ff9500' },
    { id: 'health', name: 'Здоров’я', color: '#ff3b30' },
    { id: 'education', name: 'Освіта', color: '#af52de' },
    { id: 'entertainment', name: 'Розваги', color: '#ffcc00' },
    { id: 'other', name: 'Інше', color: '#8e8e93' },
    { id: 'income', name: 'Дохід', color: '#30d158' }
];

let tasks = [];
let transactions = [];
let categories = defaultCategories;
let settings = { remindersEnabled: true, reminderMinutes: 30, rates: { USD: 44.76, EUR: 51.61 } };

let calendar = null;
let saveDebounceTimer = null;
let currentUid = null;
let unsubscribeWatch = null;
let notifiedTaskKeys = new Set();
let settingsModal = null;

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ---------- Автентифікація ----------
async function doLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');
    errEl.textContent = '';
    if (!email || !password) { errEl.textContent = 'Введи email і пароль'; return; }
    btn.disabled = true;
    btn.textContent = 'Входжу...';
    try {
        await window.PlannerSync.signIn(email, password);
    } catch (e) {
        errEl.textContent = 'Не вдалося увійти: перевір email і пароль';
        console.error(e);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Увійти';
    }
}

function doLogout() {
    if (settingsModal) settingsModal.hide();
    window.PlannerSync.signOut();
}

async function doResetPassword() {
    const email = document.getElementById('loginEmail').value.trim();
    const errEl = document.getElementById('loginError');
    if (!email) {
        errEl.style.color = '';
        errEl.textContent = 'Спочатку введи свій email у полі вище, потім натисни "Забув(ла) пароль?" ще раз.';
        return;
    }
    errEl.style.color = '';
    errEl.textContent = 'Надсилаю лист...';
    try {
        await window.PlannerSync.resetPassword(email);
        errEl.style.color = '#34c759';
        errEl.textContent = 'Лист для відновлення паролю надіслано на ' + email + '. Перевір пошту (і папку "Спам").';
    } catch (e) {
        errEl.style.color = '';
        errEl.textContent = e && e.code === 'auth/user-not-found'
            ? 'Користувача з таким email не знайдено.'
            : 'Не вдалося надіслати лист. Перевір email і спробуй ще раз.';
        console.error(e);
    }
}

function startWatching(uidVal) {
    if (unsubscribeWatch) unsubscribeWatch();
    unsubscribeWatch = window.PlannerSync.watchData(uidVal, (data, metadata) => {
        const syncDot = document.getElementById('syncDot');
        const fromCache = metadata && metadata.fromCache;
        if (syncDot) {
            if (fromCache && !navigator.onLine) {
                syncDot.classList.add('offline');
                syncDot.title = 'Офлайн — покажу останні відомі дані';
            } else {
                syncDot.classList.remove('offline');
                syncDot.title = 'Онлайн';
            }
        }

        if (data) {
            tasks = data.tasks || [];
            transactions = data.transactions || [];
            categories = (data.categories && data.categories.length) ? data.categories : defaultCategories;
            settings = Object.assign({ remindersEnabled: true, reminderMinutes: 30, rates: { USD: 44.76, EUR: 51.61 } }, data.settings || {});
            settings.rates = Object.assign({ USD: 44.76, EUR: 51.61 }, (data.settings && data.settings.rates) || {});
        } else {
            tasks = [];
            transactions = [];
            categories = defaultCategories;
        }

        if (!calendar) initCalendar();
        populateCategorySelect();
        refreshCalendarEvents();
        renderTasks();
        renderFinance();
        renderOverview();
        flashSaveIndicator();
    });
}

function flashSaveIndicator() {
    const el = document.getElementById('saveIndicator');
    if (!el) return;
    el.classList.add('show');
    clearTimeout(flashSaveIndicator._t);
    flashSaveIndicator._t = setTimeout(() => el.classList.remove('show'), 1200);
}

function persist() {
    if (!currentUid) return;
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(async () => {
        const data = { tasks, transactions, categories, settings };
        try {
            await window.PlannerSync.saveData(currentUid, data);
        } catch (e) { console.error('Sync save error:', e); }
        flashSaveIndicator();
    }, 250);
}

// ---------- Вкладки ----------
function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
    if (name === 'tasks' && calendar) {
        setTimeout(() => calendar.updateSize(), 50);
    }
}

// ---------- Категорії ----------
function populateCategorySelect() {
    const sel = document.getElementById('txCategoryInput');
    const prev = sel.value;
    sel.innerHTML = categories
        .filter(c => c.id !== 'income')
        .map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function categoryById(id) {
    return categories.find(c => c.id === id) || { id, name: id, color: '#8e8e93' };
}

// ---------- Календар завдань ----------
function initCalendar() {
    const el = document.getElementById('taskCalendar');
    calendar = new FullCalendar.Calendar(el, {
        initialView: 'dayGridMonth',
        locale: 'uk',
        height: 'auto',
        headerToolbar: { left: 'prev,next', center: 'title', right: 'today' },
        buttonText: { today: 'Сьогодні' },
        events: [],
        dateClick: (info) => {
            document.getElementById('taskDateInput').value = info.dateStr;
            document.getElementById('taskTitleInput').focus();
        },
        eventClick: (info) => toggleTask(info.event.id)
    });
    calendar.render();
}

function refreshCalendarEvents() {
    if (!calendar) return;
    calendar.removeAllEvents();
    tasks.filter(t => t.dueDate).forEach(t => {
        calendar.addEvent({
            id: t.id,
            title: t.title,
            start: t.dueTime ? `${t.dueDate}T${t.dueTime}:00` : t.dueDate,
            allDay: !t.dueTime,
            classNames: [t.done ? 'fc-event-task-done' : 'fc-event-task']
        });
    });
}

// ---------- Завдання ----------
function addTask() {
    const titleEl = document.getElementById('taskTitleInput');
    const title = titleEl.value.trim();
    if (!title) { titleEl.focus(); return; }
    const dueDate = document.getElementById('taskDateInput').value || null;
    const dueTime = document.getElementById('taskTimeInput').value || null;
    const reminderVal = document.getElementById('taskReminderInput').value;

    tasks.push({
        id: uid(),
        title,
        dueDate,
        dueTime: dueDate ? dueTime : null,
        reminderMinutes: reminderVal ? Number(reminderVal) : null,
        done: false,
        createdAt: new Date().toISOString()
    });

    titleEl.value = '';
    document.getElementById('taskDateInput').value = '';
    document.getElementById('taskTimeInput').value = '';
    document.getElementById('taskReminderInput').value = '';

    refreshCalendarEvents();
    renderTasks();
    renderOverview();
    persist();
}

function toggleTask(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    t.done = !t.done;
    refreshCalendarEvents();
    renderTasks();
    renderOverview();
    persist();
}

function deleteTask(id) {
    tasks = tasks.filter(t => t.id !== id);
    refreshCalendarEvents();
    renderTasks();
    renderOverview();
    persist();
}

function formatTaskMeta(t) {
    if (!t.dueDate) return '';
    const d = new Date(t.dueTime ? `${t.dueDate}T${t.dueTime}:00` : `${t.dueDate}T00:00:00`);
    const dateStr = d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = t.dueTime ? ', ' + d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : '';
    return dateStr + timeStr;
}

function renderTasks() {
    const list = document.getElementById('taskList');
    const sorted = [...tasks].sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        const ad = a.dueDate ? new Date(a.dueDate + 'T' + (a.dueTime || '00:00')) : new Date('9999-01-01');
        const bd = b.dueDate ? new Date(b.dueDate + 'T' + (b.dueTime || '00:00')) : new Date('9999-01-01');
        return ad - bd;
    });
    document.getElementById('taskListCount').textContent = tasks.length ? `${tasks.filter(t => !t.done).length} активних` : '';

    if (!sorted.length) {
        list.innerHTML = '<div class="reminder-empty">Поки що немає завдань</div>';
        return;
    }
    list.innerHTML = sorted.map(t => `
        <div class="reminder-item">
            <input type="checkbox" class="reminder-checkbox" ${t.done ? 'checked' : ''} onchange="toggleTask('${t.id}')">
            <div style="flex-grow:1; min-width:0;">
                <div class="reminder-text ${t.done ? 'done' : ''}">${escapeHtml(t.title)}</div>
                ${t.dueDate ? `<div class="reminder-meta">${formatTaskMeta(t)}</div>` : ''}
            </div>
            <span class="btn-delete" onclick="deleteTask('${t.id}')">Видалити</span>
        </div>
    `).join('');
}

function renderOverview() {
    const upcoming = tasks
        .filter(t => !t.done && t.dueDate)
        .sort((a, b) => new Date(a.dueDate + 'T' + (a.dueTime || '00:00')) - new Date(b.dueDate + 'T' + (b.dueTime || '00:00')))
        .slice(0, 8);
    const list = document.getElementById('overviewTaskList');
    document.getElementById('overviewTasksCount').textContent = tasks.filter(t => !t.done).length ? `${tasks.filter(t => !t.done).length} активних` : '';
    if (!upcoming.length) {
        list.innerHTML = '<div class="reminder-empty">Немає запланованих завдань</div>';
    } else {
        list.innerHTML = upcoming.map(t => `
            <div class="reminder-item">
                <input type="checkbox" class="reminder-checkbox" onchange="toggleTask('${t.id}')">
                <div style="flex-grow:1; min-width:0;">
                    <div class="reminder-text">${escapeHtml(t.title)}</div>
                    <div class="reminder-meta">${formatTaskMeta(t)}</div>
                </div>
            </div>
        `).join('');
    }

    renderMonthSummary('overviewSummaryGrid', 'overviewCatBars');
}

// ---------- Фінанси ----------
function convertToUAH(amount, currency) {
    if (currency === 'UAH') return amount;
    if (currency === 'USD') return amount * (settings.rates.USD || 0);
    if (currency === 'EUR') return amount * (settings.rates.EUR || 0);
    return amount;
}

function formatMoney(amount, currency) {
    return new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 }).format(Math.round(amount)) + ' ' + currency;
}

function addTransaction() {
    const amountEl = document.getElementById('txAmountInput');
    const amount = parseFloat(amountEl.value);
    if (!amount || amount <= 0) { amountEl.focus(); return; }
    const type = document.getElementById('txTypeInput').value;
    const currency = document.getElementById('txCurrencyInput').value;
    const category = type === 'income' ? 'income' : document.getElementById('txCategoryInput').value;
    const note = document.getElementById('txNoteInput').value.trim();

    transactions.push({
        id: uid(),
        type,
        amount,
        currency,
        category,
        note,
        date: new Date().toISOString().split('T')[0],
        createdAt: new Date().toISOString()
    });

    amountEl.value = '';
    document.getElementById('txNoteInput').value = '';

    renderFinance();
    renderOverview();
    persist();
}

function deleteTransaction(id) {
    transactions = transactions.filter(t => t.id !== id);
    renderFinance();
    renderOverview();
    persist();
}

function renderFinance() {
    const list = document.getElementById('txList');
    const sorted = [...transactions].sort((a, b) => new Date(b.date) - new Date(a.date) || b.createdAt.localeCompare(a.createdAt));
    document.getElementById('txListCount').textContent = transactions.length ? `${transactions.length}` : '';

    if (!sorted.length) {
        list.innerHTML = '<div class="reminder-empty">Ще немає операцій</div>';
    } else {
        list.innerHTML = sorted.map(t => {
            const cat = categoryById(t.category);
            const dateStr = new Date(t.date).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
            const sign = t.type === 'income' ? '+' : '−';
            return `
            <div class="tx-item">
                <span class="tx-dot" style="background:${cat.color}"></span>
                <div class="tx-main">
                    <div class="tx-category">${escapeHtml(cat.name)}</div>
                    <div class="tx-note">${dateStr}${t.note ? ' · ' + escapeHtml(t.note) : ''}</div>
                </div>
                <div class="tx-amount ${t.type}">${sign}${formatMoney(t.amount, t.currency)}</div>
                <span class="btn-delete" onclick="deleteTransaction('${t.id}')">Видалити</span>
            </div>`;
        }).join('');
    }

    renderMonthSummary('financeSummaryGrid', 'financeCatBars');
}

function renderMonthSummary(gridId, barsId) {
    const now = new Date();
    const ym = now.toISOString().slice(0, 7);
    const monthTx = transactions.filter(t => t.date && t.date.startsWith(ym));

    let incomeUAH = 0, expenseUAH = 0;
    const byCategory = {};
    monthTx.forEach(t => {
        const uahAmt = convertToUAH(t.amount, t.currency);
        if (t.type === 'income') {
            incomeUAH += uahAmt;
        } else {
            expenseUAH += uahAmt;
            byCategory[t.category] = (byCategory[t.category] || 0) + uahAmt;
        }
    });

    const grid = document.getElementById(gridId);
    grid.innerHTML = `
        <div class="summary-tile">
            <div class="summary-tile-label">Дохід</div>
            <div class="summary-tile-value income">${formatMoney(incomeUAH, 'UAH')}</div>
        </div>
        <div class="summary-tile">
            <div class="summary-tile-label">Витрати</div>
            <div class="summary-tile-value expense">${formatMoney(expenseUAH, 'UAH')}</div>
        </div>
        <div class="summary-tile">
            <div class="summary-tile-label">Баланс</div>
            <div class="summary-tile-value">${formatMoney(incomeUAH - expenseUAH, 'UAH')}</div>
        </div>
    `;

    const bars = document.getElementById(barsId);
    const entries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
        bars.innerHTML = '<div class="reminder-empty">Витрат цього місяця ще немає</div>';
        return;
    }
    const max = Math.max(...entries.map(e => e[1]));
    bars.innerHTML = entries.map(([catId, val]) => {
        const cat = categoryById(catId);
        const pct = max ? Math.round((val / max) * 100) : 0;
        return `
        <div class="cat-bar-row">
            <div class="cat-bar-head"><span>${escapeHtml(cat.name)}</span><span>${formatMoney(val, 'UAH')}</span></div>
            <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${pct}%; background:${cat.color}"></div></div>
        </div>`;
    }).join('');
}

// ---------- Налаштування ----------
function openSettingsModal() {
    document.getElementById('remindersEnabledInput').checked = !!settings.remindersEnabled;
    document.getElementById('reminderMinutesInput').value = settings.reminderMinutes || 30;
    document.getElementById('rateUsdInput').value = settings.rates.USD || 44.76;
    document.getElementById('rateEurInput').value = settings.rates.EUR || 51.61;
    const user = window.PlannerSync.currentUser();
    document.getElementById('loggedInAs').textContent = user ? `Увійшли як: ${user.email}` : '';
    if (!settingsModal) settingsModal = new bootstrap.Modal(document.getElementById('settingsModal'));
    settingsModal.show();
}

function saveSettingsFromModal() {
    settings.remindersEnabled = document.getElementById('remindersEnabledInput').checked;
    settings.reminderMinutes = Number(document.getElementById('reminderMinutesInput').value);
    settings.rates = {
        USD: parseFloat(document.getElementById('rateUsdInput').value) || settings.rates.USD,
        EUR: parseFloat(document.getElementById('rateEurInput').value) || settings.rates.EUR
    };
    if (settings.remindersEnabled && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
    renderOverview();
    renderFinance();
    persist();
    if (settingsModal) settingsModal.hide();
}

// ---------- Нагадування (лише поки застосунок відкрито на екрані) ----------
function taskDueDate(t) {
    if (!t.dueDate) return null;
    const iso = t.dueTime ? `${t.dueDate}T${t.dueTime}:00` : `${t.dueDate}T09:00:00`;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
}

function checkReminders() {
    if (!settings.remindersEnabled) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const defaultLeadMs = (settings.reminderMinutes || 30) * 60 * 1000;
    const now = Date.now();
    tasks.forEach((t) => {
        if (t.done) return;
        const d = taskDueDate(t);
        if (!d) return;
        const leadMs = t.reminderMinutes != null ? t.reminderMinutes * 60 * 1000 : defaultLeadMs;
        const diff = d.getTime() - now;
        const key = t.id + '|' + t.dueDate + '|' + (t.dueTime || '');
        if (diff > 0 && diff <= leadMs && !notifiedTaskKeys.has(key)) {
            notifiedTaskKeys.add(key);
            const minutesLeft = Math.round(diff / 60000);
            new Notification('Нагадування: завдання', {
                body: `${t.title}\nТермін через ${minutesLeft} хв`,
                icon: 'assets/app-icon-192.png'
            });
        }
    });
}
setInterval(checkReminders, 30000);

// ---------- Ініціалізація ----------
window.PlannerSync && window.PlannerSync.onAuthChange((user) => {
    const loginScreen = document.getElementById('loginScreen');
    const appRoot = document.getElementById('appRoot');
    if (user) {
        currentUid = user.uid;
        loginScreen.classList.add('hidden');
        appRoot.classList.remove('hidden');
        startWatching(user.uid);
    } else {
        currentUid = null;
        if (unsubscribeWatch) { unsubscribeWatch(); unsubscribeWatch = null; }
        appRoot.classList.add('hidden');
        loginScreen.classList.remove('hidden');
        document.getElementById('loginEmail').value = '';
        document.getElementById('loginPassword').value = '';
    }
});

window.addEventListener('DOMContentLoaded', () => {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
    }
});
