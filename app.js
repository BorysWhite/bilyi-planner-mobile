// --- 1. БАЗА ДИСЦИПЛІН (та сама, що й у Mac-застосунку) ---
const subjectsConfig = [
    // --- I семестр, денна ---
    { id: 'inf_1', subj: "Інформаційне право", group: "БМП-25 (Денна)", lecTotal: 8, pracTotal: 8, term: "—" },
    { id: 'mzpl_d1', subj: "Міжнародний захист прав людини", group: "БМП-23 (Денна)", lecTotal: 38, pracTotal: 38, term: "Екзамен" },
    { id: 'mpbd_d1', subj: "Міжнародно-правове регулювання будівельної діяльності", group: "БМПм-25-01 (Денна)", lecTotal: 6, pracTotal: 6, term: "Залік" },
    { id: 'peu_1', subj: "Право Європейського Союзу у контексті євроінтеграції України", group: "БМП-23 (Денна)", lecTotal: 30, pracTotal: 30, term: "Залік" },
    { id: 'psu_d1', subj: "Правова система України в контексті глобалізації та євроінтеграції", group: "БМПм-25-01 (Денна)", lecTotal: 6, pracTotal: 6, term: "—" },
    // --- I семестр, заочна: настановчі лекції (2 год., без практичних) ---
    { id: 'ust_popd1', subj: "(Уст.) Правові основи проф. діяльності", group: "зФВС-22 (Заочна)", lecTotal: 2, pracTotal: 0, term: "Настановча" },
    { id: 'ust_mgp1', subj: "(Уст.) Міжнародне гуманітарне право", group: "зБМПм-26 (Заочна)", lecTotal: 2, pracTotal: 0, term: "Настановча" },
    { id: 'ust_pp1', subj: "(Уст.) Порівняльне правознавство", group: "зБМП-25 (Заочна)", lecTotal: 2, pracTotal: 0, term: "Настановча" },
    { id: 'ust_mzpl1', subj: "(Уст.) Міжнародний захист прав людини", group: "зБМП-23, зБМПс-24 (Заочна)", lecTotal: 2, pracTotal: 0, term: "Настановча" },
    { id: 'ust_popd2', subj: "(Уст.) Правові основи проф. діяльності", group: "зФВС-23 (Заочна)", lecTotal: 2, pracTotal: 0, term: "Настановча" },
    // --- I семестр, заочна: повний курс ---
    { id: 'inf_2', subj: "Інформаційне право", group: "зБМП-25 (Заочна)", lecTotal: 4, pracTotal: 8, term: "Екзамен" },
    { id: 'mpbd_z1', subj: "Міжнародно-правове регулювання будівельної діяльності", group: "зБМПм-25 (Заочна)", lecTotal: 2, pracTotal: 4, term: "Залік" },
    { id: 'psu_z1', subj: "Правова система України в контексті глобалізації та євроінтеграції", group: "зБМПм-25 (Заочна)", lecTotal: 2, pracTotal: 4, term: "—" }
];

let calendarEvents = [];
let subjectNotes = {};
let checklistTasks = [];
let settings = { reminderMinutes: 15, remindersEnabled: true };

let calendar, currentEditNoteId = null;
let saveDebounceTimer = null;
let currentUid = null;
let unsubscribeWatch = null;
let suppressNextSave = false;
let notifiedEventKeys = new Set();

// --- 2. АВТЕНТИФІКАЦІЯ ---
async function doLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');
    errEl.innerText = '';
    if (!email || !password) { errEl.innerText = 'Введи email і пароль.'; return; }
    btn.disabled = true;
    btn.innerText = 'Входжу...';
    try {
        await window.PlannerSync.signIn(email, password);
    } catch (e) {
        errEl.innerText = 'Не вдалося увійти: перевір email/пароль.';
        console.error(e);
    } finally {
        btn.disabled = false;
        btn.innerText = 'Увійти';
    }
}

function doLogout() {
    window.PlannerSync.signOut();
}

window.PlannerSync && window.PlannerSync.onAuthChange((user) => {
    if (user) {
        currentUid = user.uid;
        document.getElementById('loginScreen').classList.add('hidden');
        document.getElementById('appRoot').classList.remove('hidden');
        document.getElementById('loggedInAs').innerText = 'Увійшов як ' + (user.email || '');
        startWatching(user.uid);
        if (!calendar) initCalendarOnce();
    } else {
        currentUid = null;
        if (unsubscribeWatch) { unsubscribeWatch(); unsubscribeWatch = null; }
        document.getElementById('loginScreen').classList.remove('hidden');
        document.getElementById('appRoot').classList.add('hidden');
    }
});

// --- 3. ПІДПИСКА НА ДАНІ (Firestore realtime) ---
function startWatching(uid) {
    if (unsubscribeWatch) unsubscribeWatch();
    unsubscribeWatch = window.PlannerSync.watchData(uid, (data, metadata) => {
        const dot = document.getElementById('syncDot');
        if (dot) {
            dot.classList.toggle('offline', !!(metadata && metadata.fromCache && !navigator.onLine));
            dot.title = (metadata && metadata.fromCache) ? 'Офлайн (останні збережені дані)' : 'Онлайн, синхронізовано';
        }

        if (!data) {
            // Документа ще немає — створимо порожній при першому збереженні.
            calendarEvents = []; subjectNotes = {}; checklistTasks = [];
            settings = { reminderMinutes: 15, remindersEnabled: true };
        } else {
            calendarEvents = data.calendarEvents || [];
            subjectNotes = data.subjectNotes || {};
            checklistTasks = data.checklistTasks || [];
            settings = Object.assign({ reminderMinutes: 15, remindersEnabled: true }, data.settings || {});
        }

        refreshCalendarEvents();
        renderChecklist();
        renderDashboard();
        flashSaveIndicator();
    });
}

function persist() {
    if (!currentUid) return;
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(async () => {
        try {
            await window.PlannerSync.saveData(currentUid, { calendarEvents, subjectNotes, checklistTasks, settings });
        } catch (e) {
            console.error('Помилка збереження:', e);
        }
    }, 250);
}

function flashSaveIndicator() {
    const el = document.getElementById('saveIndicator');
    if (!el) return;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 1200);
}

// --- 4. ПІДРАХУНОК ГОДИН ---
function getDoneHours(groupId, type) {
    const todayStr = new Date().toISOString().split('T')[0];
    const pastGroupEvents = calendarEvents.filter(event => {
        if (!event.title) return false;
        const eventDate = event.start.split('T')[0];
        const isPast = eventDate < todayStr;
        const matchesGroup = event.title.toLowerCase().includes(groupId.toLowerCase());
        let matchesType = false;
        if (type === 'lec' && event.title.toLowerCase().includes('лекція')) matchesType = true;
        if (type === 'prac' && event.title.toLowerCase().includes('практична')) matchesType = true;
        return isPast && matchesGroup && matchesType;
    });
    return pastGroupEvents.length * 2;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
}

// --- 5. КАРТКИ ДИСЦИПЛІН ---
function renderDashboard() {
    const grid = document.getElementById('dashboardGrid');
    grid.innerHTML = '';
    let grandTotalHours = 0, grandDoneHours = 0;

    subjectsConfig.forEach(subject => {
        grandTotalHours += (subject.lecTotal + subject.pracTotal);
        const lecDone = getDoneHours(subject.id, 'lec');
        const pracDone = getDoneHours(subject.id, 'prac');
        grandDoneHours += (lecDone + pracDone);

        const lecPercent = subject.lecTotal > 0 ? Math.round((lecDone / subject.lecTotal) * 100) : 0;
        const pracPercent = subject.pracTotal > 0 ? Math.round((pracDone / subject.pracTotal) * 100) : 0;

        const itemNotes = subjectNotes[subject.id] || { link: '', text: '' };
        const btnClass = itemNotes.text || itemNotes.link ? 'apple-pill-btn has-notes' : 'apple-pill-btn';

        const card = document.createElement('div');
        card.className = 'apple-card subject-card';
        card.innerHTML = `
            <h3 class="subject-title">${escapeHtml(subject.subj)}</h3>
            <div class="subject-subtitle">
                <span>${escapeHtml(subject.group)}</span>
                <span class="badge-apple">${escapeHtml(subject.term)}</span>
            </div>
            <div class="progress-wrap">
                <div class="progress-header"><span>Лекції</span><span style="color: var(--text-sec)">${lecDone} / ${subject.lecTotal} год</span></div>
                <div class="progress-track"><div class="progress-fill${lecPercent > 100 ? ' over' : ''}" style="width: ${Math.min(lecPercent, 100)}%"></div></div>
            </div>
            <div class="progress-wrap">
                <div class="progress-header"><span>Практичні</span><span style="color: var(--text-sec)">${pracDone} / ${subject.pracTotal} год</span></div>
                <div class="progress-track"><div class="progress-fill prac${pracPercent > 100 ? ' over' : ''}" style="width: ${Math.min(pracPercent, 100)}%"></div></div>
            </div>
            <button class="${btnClass}" onclick="openNotesModal('${subject.id}')">Матеріали та Студенти</button>
        `;
        grid.appendChild(card);
    });

    const grandTotalPercent = grandTotalHours > 0 ? Math.round((grandDoneHours / grandTotalHours) * 100) : 0;
    document.getElementById('totalProgress').innerText = grandTotalPercent + '%';
}

// --- 6. НОТАТКИ ГРУП ---
let notesModal, settingsModal;

function openNotesModal(subjectId) {
    currentEditNoteId = subjectId;
    const subject = subjectsConfig.find(s => s.id === subjectId);
    const notes = subjectNotes[subjectId] || { link: '', text: '' };
    document.getElementById('modalTitle').innerText = subject.group;
    document.getElementById('modalLink').value = notes.link || '';
    document.getElementById('modalNotes').value = notes.text || '';
    notesModal.show();
}

function saveModalChanges() {
    if (currentEditNoteId) {
        subjectNotes[currentEditNoteId] = {
            link: document.getElementById('modalLink').value,
            text: document.getElementById('modalNotes').value
        };
        persist();
    }
    notesModal.hide();
    renderDashboard();
}

// --- 7. НАЛАШТУВАННЯ ---
function openSettingsModal() {
    document.getElementById('remindersEnabledInput').checked = !!settings.remindersEnabled;
    document.getElementById('reminderMinutesInput').value = String(settings.reminderMinutes || 15);
    settingsModal.show();
}

function saveSettings() {
    settings.remindersEnabled = document.getElementById('remindersEnabledInput').checked;
    settings.reminderMinutes = parseInt(document.getElementById('reminderMinutesInput').value, 10) || 15;
    if (settings.remindersEnabled && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
    persist();
    settingsModal.hide();
}

// --- 8. КАЛЕНДАР ---
function populateSubjectSelect() {
    const select = document.getElementById('eventSubjectInput');
    select.innerHTML = '';
    subjectsConfig.forEach(subject => {
        const opt = document.createElement('option');
        opt.value = subject.id;
        opt.textContent = `${subject.subj} — ${subject.group}`;
        select.appendChild(opt);
    });
}

function updateAddEventFormMode() {
    const type = document.getElementById('eventTypeInput').value;
    const subjectSelect = document.getElementById('eventSubjectInput');
    const titleInput = document.getElementById('eventTitleInput');
    if (type === 'Інше') {
        subjectSelect.style.display = 'none';
        titleInput.style.display = 'block';
    } else {
        subjectSelect.style.display = 'block';
        titleInput.style.display = 'none';
    }
}

function classifyTitle(title) {
    const lower = title.toLowerCase();
    if (lower.includes('лекція')) return 'fc-event-lecture';
    if (lower.includes('практична')) return 'fc-event-practical';
    return 'fc-event-default';
}

function initCalendarOnce() {
    populateSubjectSelect();
    updateAddEventFormMode();
    document.getElementById('eventTypeInput').addEventListener('change', updateAddEventFormMode);

    calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
        initialView: 'dayGridMonth',
        locale: 'uk', firstDay: 1,
        headerToolbar: { left: 'prev,next', center: 'title', right: 'today' },
        editable: true,
        events: [],
        eventClick: function (info) {
            if (confirm(`Видалити подію "${info.event.title}"?`)) {
                info.event.remove();
                saveEventsFromCalendar();
            }
        },
        eventDrop: function () { saveEventsFromCalendar(); }
    });
    calendar.render();
    refreshCalendarEvents();
}

function refreshCalendarEvents() {
    if (!calendar) return;
    calendar.getEvents().forEach(e => e.remove());
    calendarEvents.forEach(ev => {
        calendar.addEvent({ title: ev.title, start: ev.start, className: classifyTitle(ev.title || '') });
    });
}

function saveEventsFromCalendar() {
    calendarEvents = calendar.getEvents().map(e => ({
        title: e.title, start: e.start.toISOString(), className: e.classNames[0]
    }));
    persist();
    renderDashboard();
}

function addEventFromForm() {
    const type = document.getElementById('eventTypeInput').value;
    const date = document.getElementById('eventDateInput').value;
    const time = document.getElementById('eventTimeInput').value;

    if (!date) { alert('Вкажіть дату.'); return; }

    let title;
    if (type === 'Інше') {
        title = document.getElementById('eventTitleInput').value.trim();
        if (!title) { alert('Вкажіть назву події.'); return; }
    } else {
        const subjectId = document.getElementById('eventSubjectInput').value;
        const subject = subjectsConfig.find(s => s.id === subjectId);
        if (!subject) { alert('Оберіть дисципліну.'); return; }
        title = `${type} ${subject.id} (${subject.subj}, ${subject.group})`;
    }

    const className = classifyTitle(title);
    calendar.addEvent({ title: title, start: `${date}T${time}:00`, className: className });
    calendarEvents.push({ title: title, start: `${date}T${time}:00`, className: className });
    persist();
    document.getElementById('eventTitleInput').value = '';
    renderDashboard();
}

// --- 9. ЧЕКЛІСТ ---
function renderChecklist() {
    const checklistDiv = document.getElementById('checklistItems');
    checklistDiv.innerHTML = '';
    const sortedTasks = checklistTasks.slice().sort((a, b) => Number(a.done) - Number(b.done));

    if (sortedTasks.length === 0) {
        checklistDiv.innerHTML = '<div class="reminder-empty">Поки немає завдань</div>';
    }

    sortedTasks.forEach((task) => {
        const realIndex = checklistTasks.indexOf(task);
        const itemDiv = document.createElement('div');
        itemDiv.className = 'reminder-item';
        itemDiv.innerHTML = `
            <input type="checkbox" class="reminder-checkbox" ${task.done ? 'checked' : ''} data-index="${realIndex}">
            <span class="reminder-text ${task.done ? 'done' : ''}">${escapeHtml(task.text)}</span>
            <span class="btn-delete" data-index="${realIndex}">Видалити</span>
        `;
        itemDiv.querySelector('.reminder-checkbox').addEventListener('change', () => toggleChecklistItem(realIndex));
        itemDiv.querySelector('.btn-delete').addEventListener('click', () => deleteChecklistItem(realIndex));
        checklistDiv.appendChild(itemDiv);
    });

    const doneCount = checklistTasks.filter(t => t.done).length;
    document.getElementById('checklistCount').innerText = checklistTasks.length ? `${doneCount}/${checklistTasks.length}` : '';
}

function addChecklistItem() {
    const input = document.getElementById('checklistInput');
    if (!input.value.trim()) return;
    checklistTasks.push({ text: input.value.trim(), done: false });
    input.value = '';
    persist();
    renderChecklist();
}

function toggleChecklistItem(index) {
    checklistTasks[index].done = !checklistTasks[index].done;
    persist();
    renderChecklist();
}

function deleteChecklistItem(index) {
    checklistTasks.splice(index, 1);
    persist();
    renderChecklist();
}

// --- 10. НАГАДУВАННЯ (тільки поки застосунок відкрито на екрані) ---
function checkReminders() {
    if (!settings.remindersEnabled) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const leadMs = (settings.reminderMinutes || 15) * 60 * 1000;
    const now = Date.now();
    calendarEvents.forEach(ev => {
        const d = new Date(ev.start);
        if (isNaN(d.getTime())) return;
        const diff = d.getTime() - now;
        const key = ev.title + '|' + ev.start;
        if (diff > 0 && diff <= leadMs && !notifiedEventKeys.has(key)) {
            notifiedEventKeys.add(key);
            const minutesLeft = Math.round(diff / 60000);
            new Notification('Незабаром пара', {
                body: `${ev.title}\nПочаток через ${minutesLeft} хв`,
                icon: 'assets/app-icon-192.png'
            });
        }
    });
}
setInterval(checkReminders, 30000);

// --- 11. ІНІЦІАЛІЗАЦІЯ ---
window.addEventListener('DOMContentLoaded', () => {
    notesModal = new bootstrap.Modal(document.getElementById('notesModal'));
    settingsModal = new bootstrap.Modal(document.getElementById('settingsModal'));
    document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);
    document.getElementById('checklistInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addChecklistItem();
    });

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
    }
});
