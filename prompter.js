// Вікно показу: текст пливе вгору, поточний рядок тримається на «лінії погляду».
//
// Швидкість задається у словах за хвилину. Кожен рядок проїжджає лінію погляду
// за стільки часу, скільки потрібно, щоб його вимовити, тож короткі рядки
// (кінці абзаців) проходять швидше, а довгі — повільніше. Саме сюди пізніше
// під’єднаємо голос: він просто керуватиме цією ж швидкістю й позицією.

const $ = (id) => document.getElementById(id);
const root = document.documentElement;

const state = {
    settings: null,
    scriptId: null,
    words: [],        // <span class="w"> по порядку
    lines: [],        // { top, pitch, first, last, count }
    paraLines: [],    // індекси рядків, з яких починаються абзаци
    totalWords: 0,
    scrollY: 0,
    maxScroll: 0,
    eyePx: 0,
    lhPx: 0,
    curLine: -1,
    playing: false,
    needCountdown: true,
    counting: false,
    anim: null,       // плавний перехід { from, to, start, dur }
    lastTs: 0,
    voice: null       // стан голосового режиму (див. нижче)
};

// ---------- Голосовий режим ----------
// Розпізнавач підтверджує, яке слово ви щойно сказали, і — головне — КОЛИ саме
// ви його вимовили (мітки часу слів). З цих міток рахуємо ваш справжній темп
// за останні 5–8 слів, тож затримка розпізнавання не спотворює швидкість.
// Між підтвердженнями текст плавно їде у цьому темпі, але не випереджає вас
// більше ніж на півтора слова. Замовкли — текст зупиняється.
// Сам екран рухається «пружиною»: плавно розганяється й гальмує, без ривків.
const LOOKAHEAD = 0.6;        // запас (у словах) понад розрахункову позицію
const HANGOVER_MS = 450;      // коротку тишу між словами ще вважаємо мовленням
const TRUST_MS = 2500;        // після цього без підтверджень — рух лише за темпом
const GAP_S = 0.35;           // пауза між словами, яку ще вважаємо частиною мовлення
const LOUD_MS = 70;           // кадр гучності вважаємо «звучить», якщо він свіжіший за це
const SPRING = 5.5;           // жорсткість «пружини» прокрутки (більше — швидша реакція)

// Склади кожного слова = кількість голосних (для української й англійської)
function syllablesOf(word) {
    const m = word.toLowerCase().match(/[аеєиіїоуюяaeiouy]/g);
    if (m) return m.length;
    return /\d/.test(word) ? 2 : 1;
}

function newVoice() {
    const cum = [0];
    state.words.forEach((w, i) => cum.push(cum[i] + syllablesOf(w.textContent)));
    return {
        cumSyl: cum,           // cumSyl[i] — склад, з якого починається слово i
        sylPos: 0,             // поточна позиція у складах сценарію
        gain: 1.33,            // справжніх складів на один почутий (калібрується саме)
        sylTimes: [],          // коли чули склади (performance.now)
        anchors: [],           // підтверджені слова з часом: для калібрування
        sylMode: false,        // true, коли помічник надсилає склади
        tracker: new VoiceTracker(state.words.map(w => w.textContent)),
        listening: false,
        ready: false,
        error: null,
        confirmed: -1,         // останнє підтверджене слово сценарію
        anchorPos: 0,          // з якого слова ви зараз говорите
        anchorTime: 0,         // коли (performance.now) закінчилося останнє сказане слово
        virtual: 0,            // оцінка поточного слова (дробова)
        vel: 0,                // швидкість прокрутки, px/с
        rate: state.settings.wpm / 60,  // ваш темп, слів/с
        arrivals: [],          // запасний спосіб оцінки темпу (без міток часу)
        vad: [],               // історія «говорю / мовчу»: [час, говорю?]
        spoken: 0,             // скільки секунд ви говорили після останнього підтвердженого слова
        gap: 0,                // поточна тиша, с (зарахуємо, лише якщо ви продовжите)
        hostOffset: null,      // різниця годинників: помічник ↔ вікно
        noise: -60,
        lastVoiceAt: 0,
        manualUntil: 0
    };
}

function isVoiceMode() {
    return state.settings.scrollMode === 'voice';
}

function wordY(idx) {
    const w = Math.max(0, Math.min(state.totalWords - 1, Math.floor(idx)));
    const line = state.lines[lineOfWord(w)];
    const frac = Math.min(1, (idx - line.first) / Math.max(1, line.count));
    return line.top + frac * line.pitch - state.eyePx;
}

// Темп за мітками часу слів: кількість слів / час мовлення (довгі паузи не рахуємо)
function rateFromSegments(segs) {
    let timed = segs.filter(s => s.d > 0);
    // беремо лише слова після останньої довгої паузи — темп «зараз», а не до паузи
    for (let i = timed.length - 1; i > 0; i--) {
        if (timed[i].t - (timed[i - 1].t + timed[i - 1].d) > 0.6) { timed = timed.slice(i); break; }
    }
    timed = timed.slice(-5);
    if (timed.length < 2) return null;
    let speech = 0;
    for (let i = 0; i < timed.length; i++) {
        speech += timed[i].d;
        if (i) speech += Math.min(0.35, Math.max(0, timed[i].t - (timed[i - 1].t + timed[i - 1].d)));
    }
    return speech > 0.3 ? timed.length / speech : null;
}

function onVoiceEvent(ev) {
    const v = state.voice;
    if (!v) return;
    const now = performance.now();

    if (typeof ev.now === 'number') {
        // Зводимо годинник помічника до нашого (беремо найменшу затримку доставки)
        const off = now - ev.now * 1000;
        v.hostOffset = v.hostOffset === null ? off : Math.min(v.hostOffset + 0.5, off);
    }

    if (ev.type === 'ready') {
        v.ready = true;
        v.error = null;
    } else if (ev.type === 'level') {
        // Поріг мовлення підлаштовується під шум у кімнаті
        if (ev.db < v.noise + 6) v.noise = v.noise * 0.97 + ev.db * 0.03;
        else v.noise = v.noise * 0.999 + ev.db * 0.001;
        v.noise = Math.max(-75, Math.min(-30, v.noise));
        const loud = ev.db > v.noise + 10 && ev.db > -58;
        if (loud) v.lastVoiceAt = now;
        v.vad.push([now, loud]);
        if (v.vad.length > 200) v.vad.splice(0, v.vad.length - 200);
        setMicLevel(ev.db - v.noise);
    } else if (ev.type === 'syl') {
        // Кожен почутий склад зсуває текст на один (відкалібрований) склад
        v.sylMode = true;
        v.lastVoiceAt = now;
        v.sylTimes.push(now);
        if (v.sylTimes.length > 400) v.sylTimes.splice(0, 100);
        if (now >= v.manualUntil) {
            const cap = v.cumSyl[Math.min(state.totalWords, v.anchorPos)] + v.gain * sylCount(v.anchorTime, now) + 3;
            v.sylPos = Math.min(v.sylPos + v.gain, now - v.anchorTime < TRUST_MS ? cap : Infinity,
                v.cumSyl[state.totalWords]);
        }
    } else if (ev.type === 'text') {
        if (now < v.manualUntil) return;
        const pos = v.tracker.update(ev.text);
        if (pos === null || pos === v.confirmed) return;

        // Коли закінчилося останнє сказане слово
        const segs = Array.isArray(ev.segs) ? ev.segs : [];
        const last = segs[segs.length - 1];
        let endAt = now - 350;  // запасний варіант: типова затримка розпізнавання
        let r = null;
        if (last && ev.t0 > 0 && v.hostOffset !== null && (last.t > 0 || last.d > 0)) {
            endAt = Math.min(now, (ev.t0 + last.t + last.d) * 1000 + v.hostOffset);
            r = rateFromSegments(segs);
        }
        if (r === null) {
            v.arrivals.push({ pos, t: now });
            v.arrivals = v.arrivals.filter(a => now - a.t < 3000);
            const a0 = v.arrivals[0];
            if (a0 && now - a0.t > 1000 && pos > a0.pos) r = (pos - a0.pos) / ((now - a0.t) / 1000);
        }
        const back = pos < v.confirmed;
        const spokenNow = speakingSeconds(endAt, now);
        // Зворотний зв'язок: якщо ми випередили вас — темп завищений, якщо відстали — занижений
        if (!back && v.confirmed >= 0) {
            const drift = v.virtual - (pos + 1 + v.rate * spokenNow);
            if (drift > 0.8) v.rate *= 0.85;
            else if (drift < -0.8) v.rate *= 1.08;
        }
        if (r !== null) v.rate = v.rate * 0.35 + r * 0.65;
        v.rate = Math.max(0.8, Math.min(6, v.rate));

        v.confirmed = pos;
        v.anchorPos = pos + 1;
        v.anchorTime = endAt;
        v.lastVoiceAt = now;

        // Скільки ви говорили після того слова (паузи не рахуємо)
        v.spoken = spokenNow;
        // Де ви, найімовірніше, зараз
        const expected = v.anchorPos + v.rate * v.spoken;
        if (back || expected > v.virtual) v.virtual = expected;

        if (v.sylMode) {
            // Калібрування: скільки справжніх складів припадає на один почутий
            v.anchors.push({ pos, t: endAt });
            v.anchors = v.anchors.filter(a => now - a.t < 20000);
            const a0 = v.anchors.find(a => endAt - a.t > 2500);
            if (a0 && pos > a0.pos) {
                const real = v.cumSyl[pos + 1] - v.cumSyl[a0.pos + 1];
                const heard = sylCount(a0.t, endAt);
                if (heard >= 6) v.gain = Math.max(0.8, Math.min(2.5, v.gain * 0.7 + (real / heard) * 0.3));
            }
            // Виправлення позиції: де ви мали б бути за підтвердженим словом
            const expSyl = v.cumSyl[pos + 1] + v.gain * sylCount(endAt, now);
            const err = expSyl - v.sylPos;
            if (back || Math.abs(err) > 25) v.sylPos = expSyl;
            else v.sylPos += err * 0.6;
        }
    } else if (ev.type === 'notice') {
        const el = $('voice-error');
        el.textContent = ev.message;
        el.classList.remove('hidden');
        setTimeout(() => el.classList.add('hidden'), 6000);
    } else if (ev.type === 'error') {
        v.error = ev.message;
        v.listening = false;
        showVoiceError(ev);
        setPlaying(false);
    } else if (ev.type === 'stopped') {
        if (v.listening) {
            v.listening = false;
            setPlaying(false);
            showVoiceError({ code: 'stopped', message: 'модуль розпізнавання зупинився (код ' + ev.code + '). Спробуйте ще раз або перемкніться на рівну швидкість (V).' });
        }
    }
    renderMic();
}

// Скільки секунд ви говорили між from і to: звучні кадри плюс короткі паузи між словами
// (паузу зараховуємо, лише якщо після неї ви продовжили говорити)
function speakingSeconds(from, to) {
    const vad = state.voice.vad;
    let sum = 0, lastLoudEnd = null;
    for (let i = 0; i < vad.length; i++) {
        if (!vad[i][1]) continue;
        const t0 = vad[i][0];
        const t1 = Math.min(t0 + LOUD_MS, i + 1 < vad.length ? vad[i + 1][0] : to);
        const a = Math.max(from, t0), b = Math.min(to, t1);
        if (b > a) sum += b - a;
        if (lastLoudEnd !== null) {
            const g0 = Math.max(from, lastLoudEnd), g1 = Math.min(to, t0);
            if (g1 > g0 && t0 - lastLoudEnd <= GAP_S * 1000) sum += g1 - g0;
        }
        lastLoudEnd = t1;
    }
    return sum / 1000;
}

function sylCount(from, to) {
    const t = state.voice.sylTimes;
    let n = 0;
    for (let i = t.length - 1; i >= 0 && t[i] > from; i--) if (t[i] <= to) n++;
    return n;
}

// Позиція у складах → дробовий номер слова
function sylToWord(sp) {
    const c = state.voice.cumSyl;
    let lo = 0, hi = c.length - 2;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (c[mid] <= sp) lo = mid; else hi = mid - 1;
    }
    return lo + Math.min(1, (sp - c[lo]) / Math.max(1, c[lo + 1] - c[lo]));
}

function voiceStep(dt, now) {
    const v = state.voice;
    if (now < v.manualUntil) { v.vel = 0; return; }
    if (v.sylMode) {
        v.virtual = sylToWord(v.sylPos);
        followSpring(v, dt);
        return;
    }
    const trusted = now - v.anchorTime < TRUST_MS;

    // Рухаємося, лише поки звучить голос; коротку паузу між словами «доплачуємо»,
    // коли ви продовжуєте, а довгу — ні (текст чекає)
    const loud = now - v.lastVoiceAt < LOUD_MS;
    if (loud) {
        const step = dt + (v.gap <= GAP_S ? v.gap : 0);
        v.gap = 0;
        v.spoken += step;
        const cap = trusted ? v.anchorPos + v.rate * v.spoken + LOOKAHEAD : Infinity;
        if (v.virtual < cap) v.virtual = Math.min(cap, v.virtual + v.rate * step);
    } else {
        v.gap += dt;
    }
    v.virtual = Math.min(v.virtual, state.totalWords - 0.01);
    followSpring(v, dt);
}

function followSpring(v, dt) {
    // «Пружина»: плавний розгін і гальмування до потрібного місця
    const target = Math.max(0, Math.min(state.maxScroll, wordY(v.virtual)));
    const diff = target - state.scrollY;
    if (Math.abs(diff) > window.innerHeight * 3) {
        state.scrollY = target;       // дуже далекий стрибок — одразу
        v.vel = 0;
        return;
    }
    v.vel += (SPRING * SPRING * diff - 2 * SPRING * v.vel) * dt;
    // Невеликий «переліт» не відкочуємо назад — просто чекаємо
    if (v.vel < 0 && diff > -state.lhPx) v.vel = 0;
    state.scrollY += v.vel * dt;
}

function resetVoiceAt(first) {
    const v = state.voice;
    if (!v) return;
    v.tracker.reset(first - 1);
    v.confirmed = first - 1;
    v.anchorPos = first;
    v.anchorTime = 0;
    v.virtual = first;
    v.sylPos = v.cumSyl[Math.max(0, first)];
    v.anchors = [];
    v.spoken = 0;
    v.gap = 0;
    v.vel = 0;
    v.arrivals = [];
}

// Після ручної прокрутки/переходу — продовжуємо слухати з нового місця
function syncVoiceToScroll() {
    if (!state.voice || !state.lines.length) return;
    resetVoiceAt(state.lines[lineAtScroll()].first);
}

function setMicLevel(over) {
    const pct = Math.max(0, Math.min(1, over / 30));
    $('mic-level').style.transform = `scaleX(${pct.toFixed(2)})`;
}

function renderMic() {
    const v = state.voice;
    const el = $('mic');
    const on = isVoiceMode() && v && v.listening;
    el.classList.toggle('hidden', !on);
    if (!on) return;
    const speaking = performance.now() - v.lastVoiceAt < HANGOVER_MS;
    el.classList.toggle('speaking', speaking);
    $('mic-text').textContent = !v.ready ? 'Вмикаю мікрофон…' : speaking ? 'Слухаю' : 'Чекаю на вас';
}

function showVoiceError(ev) {
    const help = {
        'speech-denied': 'Дозвольте розпізнавання мовлення: Системні параметри → Приватність і безпека → Розпізнавання мовлення → Суфлер.',
        'mic-denied': 'Дозвольте мікрофон: Системні параметри → Приватність і безпека → Мікрофон → Суфлер.'
    };
    const el = $('voice-error');
    el.textContent = help[ev.code] || ('Голосовий режим недоступний: ' + (ev.message || ev.code));
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 9000);
}

// ---------- Текст → слова ----------
function renderText(text) {
    const content = $('content');
    content.textContent = '';
    const frag = document.createDocumentFragment();
    state.words = [];
    text.replace(/\r\n?/g, '\n').split('\n').forEach(line => {
        const tokens = line.trim().split(/\s+/).filter(Boolean);
        if (!tokens.length) return;
        const p = document.createElement('p');
        tokens.forEach((tok, i) => {
            if (i) p.appendChild(document.createTextNode(' '));
            const span = document.createElement('span');
            span.className = 'w';
            span.textContent = tok;
            p.appendChild(span);
            state.words.push(span);
        });
        frag.appendChild(p);
    });
    content.appendChild(frag);
    state.totalWords = state.words.length;
}

// ---------- Розмітка рядків ----------
function applySettings(s) {
    state.settings = s;
    root.style.setProperty('--text', s.textColor);
    root.style.setProperty('--bg', s.bgColor);
    root.style.setProperty('--hl', s.highlightColor);
    root.style.setProperty('--fs', s.fontSize + 'px');
    root.style.setProperty('--lh', s.lineHeight);
    root.style.setProperty('--col', s.columnWidth + '%');
    document.body.classList.toggle('mirror', !!s.mirror);
    document.body.classList.toggle('dim', !!s.dimOthers);
    $('b-wpm').textContent = `${s.wpm} сл/хв`;
    const voice = s.scrollMode === 'voice';
    $('b-mode').textContent = voice ? '🎙 Голос' : '⏱ Рівно';
    $('b-mode').title = voice
        ? 'Зараз: текст іде за вашим голосом. Натисніть — рівна швидкість (V)'
        : 'Зараз: рівна швидкість. Натисніть — за голосом (V)';
}

function anchor() {
    const line = state.lines[state.curLine];
    if (!line) return null;
    return { word: line.first, frac: (state.scrollY + state.eyePx - line.top) / line.pitch };
}

function layout(keep = anchor()) {
    const s = state.settings;
    state.eyePx = Math.round(window.innerHeight * s.eyeLine / 100);
    state.lhPx = s.fontSize * s.lineHeight;
    root.style.setProperty('--eye', state.eyePx + 'px');
    $('content').style.paddingBottom = window.innerHeight + 'px';
    $('eye').style.top = (state.eyePx + state.lhPx / 2) + 'px';

    // Групуємо слова в рядки за їхньою вертикальною позицією
    const lines = [];
    const paraLines = [];
    let prevPara = null;
    state.words.forEach((w, i) => {
        const top = w.offsetTop;
        const last = lines[lines.length - 1];
        if (!last || Math.abs(top - last.top) > 2) {
            lines.push({ top, first: i, last: i, count: 1 });
        } else {
            last.last = i;
            last.count++;
        }
        if (w.parentNode !== prevPara) {
            paraLines.push(lines.length - 1);
            prevPara = w.parentNode;
        }
    });
    lines.forEach((l, i) => {
        l.pitch = i + 1 < lines.length ? lines[i + 1].top - l.top : state.lhPx;
    });
    state.lines = lines;
    state.paraLines = paraLines;
    state.maxScroll = lines.length ? lines[lines.length - 1].top - state.eyePx : 0;

    if (keep && lines.length) {
        const li = lineOfWord(keep.word);
        state.scrollY = lines[li].top - state.eyePx + keep.frac * lines[li].pitch;
    }
    state.curLine = -1;
    clampScroll();
    paint();
}

function lineOfWord(wi) {
    const L = state.lines;
    let lo = 0, hi = L.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (L[mid].first <= wi) lo = mid; else hi = mid - 1;
    }
    return lo;
}

function lineAtScroll() {
    const y = state.scrollY + state.eyePx + state.lhPx / 2;
    const L = state.lines;
    let lo = 0, hi = L.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (L[mid].top <= y) lo = mid; else hi = mid - 1;
    }
    return lo;
}

function clampScroll() {
    state.scrollY = Math.max(0, Math.min(state.maxScroll, state.scrollY));
}

// ---------- Малювання ----------
function paint() {
    $('content').style.transform = `translate3d(0, ${-state.scrollY}px, 0)`;
    if (!state.lines.length) return;

    const li = lineAtScroll();
    if (li !== state.curLine) {
        const old = state.lines[state.curLine];
        if (old) for (let i = old.first; i <= old.last; i++) state.words[i].classList.remove('cur');
        const cur = state.lines[li];
        for (let i = cur.first; i <= cur.last; i++) state.words[i].classList.add('cur');
        state.curLine = li;
    }

    const cur = state.lines[state.curLine];
    const progress = state.maxScroll ? state.scrollY / state.maxScroll : 0;
    $('progress-fill').style.width = (progress * 100).toFixed(2) + '%';
    const left = Math.max(0, state.totalWords - cur.first);
    $('b-time').textContent = 'ще ' + fmt(left / state.settings.wpm);
}

function fmt(minutes) {
    const t = Math.round(minutes * 60);
    const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
             : `${m}:${String(s).padStart(2, '0')}`;
}

// ---------- Рух ----------
function tick(ts) {
    const dt = state.lastTs ? Math.min(0.1, (ts - state.lastTs) / 1000) : 0;
    state.lastTs = ts;

    if (state.anim) {
        const a = state.anim;
        const k = Math.min(1, (ts - a.start) / a.dur);
        const e = 1 - Math.pow(1 - k, 3);
        state.scrollY = a.from + (a.to - a.from) * e;
        if (k >= 1) state.anim = null;
    } else if (state.playing && state.lines.length && isVoiceMode() && state.voice) {
        voiceStep(dt, ts);
        if (ts % 250 < 20) renderMic();
    } else if (state.playing && state.lines.length) {
        const line = state.lines[Math.max(0, state.curLine)];
        const avg = state.totalWords / state.lines.length;
        const words = Math.max(line.count, avg * 0.5);
        const secondsForLine = words / (state.settings.wpm / 60);
        state.scrollY += (line.pitch / secondsForLine) * dt;
        if (state.scrollY >= state.maxScroll) {
            state.scrollY = state.maxScroll;
            setPlaying(false);
        }
    }
    clampScroll();
    paint();
    requestAnimationFrame(tick);
}

function scrollToLine(li) {
    li = Math.max(0, Math.min(state.lines.length - 1, li));
    resetVoiceAt(state.lines[li].first);
    state.anim = {
        from: state.scrollY,
        to: Math.max(0, Math.min(state.maxScroll, state.lines[li].top - state.eyePx)),
        start: performance.now(),
        dur: 320
    };
}

function jumpParagraph(dir) {
    const P = state.paraLines;
    const cur = state.curLine;
    if (dir > 0) {
        const next = P.find(l => l > cur);
        if (next !== undefined) scrollToLine(next);
    } else {
        // Якщо ми всередині абзацу — на його початок, інакше — на попередній
        const before = P.filter(l => l < cur);
        const curStart = P.filter(l => l <= cur).pop();
        scrollToLine(cur === curStart ? (before.pop() ?? 0) : curStart);
    }
}

function setPlaying(on) {
    if (on && isVoiceMode()) {
        // У голосовому режимі відлік не потрібен: текст і так чекає на вас
        state.needCountdown = false;
        syncVoiceToScroll();
        state.voice.listening = true;
        state.voice.ready = false;
        window.api.startVoice(state.settings.language || 'uk-UA');
    } else if (!on && state.voice && state.voice.listening) {
        state.voice.listening = false;
        window.api.stopVoice();
    }
    if (on && state.needCountdown && state.settings.countdown > 0) {
        runCountdown();
        return;
    }
    state.playing = on;
    document.body.classList.toggle('playing', on);
    // Запис відео йде разом із показом
    if (window.Recorder && Recorder.isOpen) {
        if (on) Recorder.start(); else Recorder.pause();
        renderRec();
    }
    keepAwake(on);
    $('b-play').textContent = on ? '⏸' : '▶';
    const how = window.api.platform === 'web' ? 'торкніться тексту' : 'пробіл';
    $('paused').textContent = isVoiceMode() ? `Пауза · ${how} — слухати` : `Пауза · ${how} — старт`;
    renderMic();
    if (on) state.needCountdown = false;
    wakeBar();
}

function runCountdown() {
    if (state.counting) return;
    state.counting = true;
    let n = state.settings.countdown;
    const el = $('countdown');
    el.classList.remove('hidden');
    el.textContent = n;
    const timer = setInterval(() => {
        n--;
        if (n <= 0) {
            clearInterval(timer);
            el.classList.add('hidden');
            state.counting = false;
            state.needCountdown = false;
            setPlaying(true);
        } else {
            el.textContent = n;
        }
    }, 1000);
}

function restart() {
    setPlaying(false);
    scrollToLine(0);
    state.needCountdown = true;
}

// ---------- Налаштування з вікна показу ----------
function patch(p) {
    if (p.wpm && state.voice) state.voice.rate = p.wpm / 60;
    applySettings(Object.assign({}, state.settings, p));
    layout();
    window.api.updateSettings(p);
}

const actions = {
    play: () => setPlaying(!state.playing && !state.counting),
    restart,
    faster: () => patch({ wpm: Math.min(260, state.settings.wpm + 5) }),
    slower: () => patch({ wpm: Math.max(40, state.settings.wpm - 5) }),
    bigger: () => patch({ fontSize: Math.min(140, state.settings.fontSize + 4) }),
    smaller: () => patch({ fontSize: Math.max(16, state.settings.fontSize - 4) }),
    mirror: () => patch({ mirror: !state.settings.mirror }),
    fullscreen: () => window.api.toggleFullscreen(),
    home: () => window.api.resetPosition(),
    help: () => $('help').classList.toggle('hidden'),
    mode: () => {
        const wasPlaying = state.playing;
        if (wasPlaying) setPlaying(false);
        patch({ scrollMode: isVoiceMode() ? 'manual' : 'voice' });
        if (wasPlaying) setPlaying(true);
    },
    record: () => toggleCamera(),
    close: async () => {
        if (window.Recorder && Recorder.hasFootage) { await finishRecording(true); return; }
        if (window.Recorder) Recorder.close($('cam'));
        window.api.closePrompter();
    }
};

// ---------- Камера й запис відео ----------
let recTimer = null;

async function toggleCamera() {
    const R = window.Recorder;
    if (!R) return;
    if (R.isOpen) {
        if (R.hasFootage) await finishRecording(false);
        R.close($('cam'));
        $('cam').classList.add('hidden');
        $('rec').classList.add('hidden');
        $('b-rec').classList.remove('rec-armed');
        clearInterval(recTimer);
        restartVoiceIfListening();
        return;
    }
    try {
        await R.open($('cam'));
    } catch (err) {
        showVoiceError({ code: 'camera', message: 'немає доступу до камери: ' + err.message });
        return;
    }
    $('cam').classList.remove('hidden');
    $('rec').classList.remove('hidden');
    $('b-rec').classList.add('rec-armed');
    renderRec();
    clearInterval(recTimer);
    recTimer = setInterval(renderRec, 500);
    if (state.playing) R.start();
    restartVoiceIfListening();
}

// На iPhone голос і камера мають ділити один мікрофон
function restartVoiceIfListening() {
    if (window.api.platform === 'web' && state.voice && state.voice.listening) {
        window.api.startVoice(state.settings.language || 'uk-UA');
    }
}

function renderRec() {
    const R = window.Recorder;
    if (!R || !R.isOpen) return;
    const t = Math.floor(R.elapsed() / 1000);
    $('rec-time').textContent = R.hasFootage
        ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
        : 'камера — запис почнеться зі стартом';
    $('rec').classList.toggle('on', R.isRecording);
}

// Завершує запис і зберігає відео; closeAfter — закрити показ після збереження
async function finishRecording(closeAfter) {
    const R = window.Recorder;
    setPlaying(false);
    const res = await R.finish();
    renderRec();
    if (!res) { if (closeAfter) { R.close($('cam')); window.api.closePrompter(); } return; }
    const title = (document.title.replace(/^Суфлер — /, '') || 'Запис').slice(0, 60);
    const out = window.api.platform === 'mac'
        ? await window.api.saveVideo(await res.blob.arrayBuffer(), title, res.ext)
        : await window.api.saveVideo(res.blob, title, res.ext);
    const box = $('saved');
    box.classList.remove('hidden');
    if (out.needsTap) {
        // iPhone: «Поділитися» можна відкрити лише з натискання
        $('saved-text').textContent = `Відео готове (${out.sizeMb} МБ). Натисніть «Зберегти відео», потім у меню — «Зберегти відео» у Фото.`;
        $('saved-go').textContent = 'Зберегти відео';
        $('saved-go').onclick = async () => { if (await out.share()) done(); };
    } else {
        $('saved-text').textContent = 'Відео збережено в «Фільми → Суфлер».';
        $('saved-go').textContent = 'Показати у Finder';
        $('saved-go').onclick = () => { out.reveal(); done(); };
    }
    $('saved-close').onclick = done;
    function done() {
        box.classList.add('hidden');
        if (closeAfter) { R.close($('cam')); window.api.closePrompter(); }
    }
}

// Підказка про керування дотиком (перші кілька відкриттів)
function showTouchHint() {
    let n = 0;
    try { n = Number(localStorage.getItem('sufler-hint') || 0); localStorage.setItem('sufler-hint', n + 1); } catch (_) {}
    if (n >= 5) return;
    const el = $('voice-error');
    el.textContent = 'Торкніться тексту — пауза / старт. Проведіть пальцем — прокрутка. Кнопки — внизу.';
    el.classList.add('hint');
    el.classList.remove('hidden');
    setTimeout(() => { el.classList.add('hidden'); el.classList.remove('hint'); }, 5000);
}

// Екран не гасне, поки йде показ
let wakeLock = null;
async function keepAwake(on) {
    try {
        if (on && !wakeLock && navigator.wakeLock) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        } else if (!on && wakeLock) {
            await wakeLock.release();
            wakeLock = null;
        }
    } catch (_) { /* не підтримується — не страшно */ }
}

// ---------- Панель, яка ховається під час читання ----------
let idleTimer = null;
function wakeBar() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    if (state.playing) idleTimer = setTimeout(() => document.body.classList.add('idle'), 2200);
}

// ---------- Події ----------
let wheelSync = null;
function bindEvents() {
    document.querySelectorAll('.bar button').forEach(b => {
        b.addEventListener('click', e => { e.stopPropagation(); actions[b.dataset.act](); b.blur(); });
    });
    $('help').addEventListener('click', () => $('help').classList.add('hidden'));
    document.addEventListener('mousemove', wakeBar);
    document.body.classList.add('platform-' + (window.api.platform || 'mac'));

    // Дотик: торкнулися тексту — старт/пауза; провели пальцем — ручна прокрутка
    let touchY = null, touchStartY = 0, touchMoved = false;
    const viewport = $('viewport');
    // Будь-який дотик показує панель керування
    document.addEventListener('touchstart', wakeBar, { passive: true });
    viewport.addEventListener('touchstart', e => {
        touchY = touchStartY = e.touches[0].clientY;
        touchMoved = false;
    }, { passive: true });
    viewport.addEventListener('touchmove', e => {
        if (touchY === null) return;
        const y = e.touches[0].clientY;
        const d = touchY - y;
        // Легке тремтіння пальця під час торкання — не прокрутка
        if (!touchMoved && Math.abs(y - touchStartY) < 12) return;
        touchMoved = true;
        touchY = y;
        state.anim = null;
        if (state.voice) state.voice.manualUntil = performance.now() + 900;
        clearTimeout(wheelSync);
        wheelSync = setTimeout(syncVoiceToScroll, 900);
        state.scrollY += d;
        clampScroll();
        e.preventDefault();
    }, { passive: false });
    viewport.addEventListener('touchend', e => {
        if (touchY !== null && !touchMoved) { e.preventDefault(); actions.play(); }
        touchY = null;
    });
    viewport.addEventListener('touchcancel', () => { touchY = null; });

    if (window.api.platform === 'web') showTouchHint();

    document.addEventListener('keydown', e => {
        if (e.metaKey || e.ctrlKey) return;
        const map = {
            ' ': 'play', 'ArrowUp': 'faster', 'ArrowDown': 'slower',
            'Home': 'restart', '=': 'bigger', '+': 'bigger', '-': 'smaller',
            'm': 'mirror', 'ь': 'mirror', 'f': 'fullscreen', 'а': 'fullscreen',
            'c': 'home', 'с': 'home', '?': 'help', ',': 'help', 'v': 'mode', 'м': 'mode',
            'r': 'record', 'к': 'record'
        };
        if (e.key === 'Escape') {
            if (!$('help').classList.contains('hidden')) $('help').classList.add('hidden');
            else actions.close();
        } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
            jumpParagraph(1);
        } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
            jumpParagraph(-1);
        } else if (map[e.key] || map[e.key.toLowerCase()]) {
            actions[map[e.key] || map[e.key.toLowerCase()]]();
        } else {
            return;
        }
        e.preventDefault();
    });

    // Прокрутка трекпадом/мишею — ручна підгонка, навіть під час руху
    window.addEventListener('wheel', e => {
        state.anim = null;
        if (state.voice) state.voice.manualUntil = performance.now() + 900;
        clearTimeout(wheelSync);
        wheelSync = setTimeout(syncVoiceToScroll, 900);
        state.scrollY += e.deltaY;
        clampScroll();
        if (state.scrollY > 1) state.needCountdown = false;
    }, { passive: true });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => layout(), 60);
    });

    window.api.onSettingsChanged(s => { applySettings(s); layout(); });
    window.api.onPrompterLoad(id => load(id));
    window.api.onVoiceEvent(onVoiceEvent);
}

async function load(id) {
    const data = await window.api.loadData();
    const script = data.scripts.find(s => s.id === id) || data.scripts[0];
    state.scriptId = script ? script.id : null;
    document.title = script ? `Суфлер — ${script.title || 'показ'}` : 'Суфлер';
    applySettings(data.settings);
    renderText(script ? script.text : 'Текст не знайдено.');
    state.scrollY = 0;
    state.needCountdown = true;
    setPlaying(false);
    await document.fonts.ready;
    layout(null);
    if (state.voice && state.voice.listening) window.api.stopVoice();
    state.voice = newVoice();
    renderMic();
}

bindEvents();
load(new URLSearchParams(location.search).get('id')).then(() => {
    wakeBar();
    requestAnimationFrame(tick);
});
