// ========== CONFIG ==========
const DB_NAME = 'HabitosDB';
const DB_VERSION = 2;
let db = null;

const COLORS = ['#00d4ff','#00ff88','#ffee00','#ff8800','#ff00aa','#aa00ff','#00ffcc','#ff3366'];
const DAYS = ['L','M','X','J','V','S','D'];
const MONTHS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

// ========== LOCALSTORAGE FALLBACK ==========
const LS = {
    _data: null,
    _load() {
        if (this._data) return this._data;
        try {
            this._data = {
                habits: JSON.parse(localStorage.getItem('h_habits') || '[]'),
                records: JSON.parse(localStorage.getItem('h_records') || '[]'),
                nextId: parseInt(localStorage.getItem('h_nextId') || '1')
            };
        } catch {
            this._data = { habits: [], records: [], nextId: 1 };
        }
        return this._data;
    },
    _save() {
        try {
            localStorage.setItem('h_habits', JSON.stringify(this._data.habits));
            localStorage.setItem('h_records', JSON.stringify(this._data.records));
            localStorage.setItem('h_nextId', this._data.nextId.toString());
        } catch (e) { console.error('LS save error:', e); }
    },
    getHabits() { return this._load().habits; },
    addHabit(h) { 
        const d = this._load();
        h.id = d.nextId++;
        d.habits.push(h);
        this._save();
        return h.id;
    },
    updateHabit(h) {
        const d = this._load();
        const idx = d.habits.findIndex(x => x.id === h.id);
        if (idx >= 0) d.habits[idx] = h;
        this._save();
    },
    deleteHabit(id) {
        const d = this._load();
        d.habits = d.habits.filter(h => h.id !== id);
        d.records = d.records.filter(r => r.habitId !== id);
        this._save();
    },
    getRecords(hid) { return this._load().records.filter(r => r.habitId === hid); },
    getAllRecords() { return this._load().records; },
    getRecord(hid, date) { return this._load().records.find(r => r.habitId === hid && r.date === date) || null; },
    setRecord(hid, date, count) {
        const d = this._load();
        const ex = d.records.find(r => r.habitId === hid && r.date === date);
        if (ex) ex.count = count;
        else d.records.push({ id: d.nextId++, habitId: hid, date, count });
        this._save();
    }
};

// ========== DATABASE ==========
let useLS = false;

function initDB() {
    return new Promise((resolve) => {
        if (!window.indexedDB) {
            console.warn('IndexedDB not supported, using localStorage');
            useLS = true;
            resolve();
            return;
        }
        try {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = () => { useLS = true; resolve(); };
            req.onsuccess = (e) => { db = e.target.result; resolve(); };
            req.onupgradeneeded = (e) => {
                const d = e.target.result;
                if (!d.objectStoreNames.contains('habits')) 
                    d.createObjectStore('habits', { keyPath: 'id', autoIncrement: true });
                if (!d.objectStoreNames.contains('records')) {
                    const s = d.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
                    s.createIndex('habitId', 'habitId');
                    s.createIndex('habitDate', ['habitId', 'date'], { unique: true });
                }
            };
        } catch { useLS = true; resolve(); }
    });
}

function dbOp(store, mode, fn) {
    return new Promise((res, rej) => {
        try {
            const tx = db.transaction(store, mode);
            const s = tx.objectStore(store);
            const r = fn(s);
            if (r && r.onsuccess !== undefined) {
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
            } else {
                tx.oncomplete = () => res(r);
                tx.onerror = () => rej(tx.error);
            }
        } catch (e) { rej(e); }
    });
}

// ========== DATA ACCESS ==========
async function getHabits() {
    if (useLS) return LS.getHabits();
    return dbOp('habits', 'readonly', s => s.getAll());
}

async function addHabit(h) {
    if (useLS) return LS.addHabit(h);
    return dbOp('habits', 'readwrite', s => s.add(h));
}

async function updateHabit(h) {
    if (useLS) return LS.updateHabit(h);
    return dbOp('habits', 'readwrite', s => s.put(h));
}

async function deleteHabit(id) {
    if (useLS) return LS.deleteHabit(id);
    const recs = await getRecsByHabit(id);
    for (const r of recs) await dbOp('records', 'readwrite', s => s.delete(r.id));
    return dbOp('habits', 'readwrite', s => s.delete(id));
}

async function getRecsByHabit(hid) {
    if (useLS) return LS.getRecords(hid);
    return dbOp('records', 'readonly', s => s.index('habitId').getAll(hid));
}

async function getAllRecs() {
    if (useLS) return LS.getAllRecords();
    return dbOp('records', 'readonly', s => s.getAll());
}

async function getRec(hid, date) {
    if (useLS) return LS.getRecord(hid, date);
    return new Promise((res) => {
        try {
            const tx = db.transaction('records', 'readonly');
            const r = tx.objectStore('records').index('habitDate').get([hid, date]);
            r.onsuccess = () => res(r.result || null);
            r.onerror = () => res(null);
        } catch { res(null); }
    });
}

async function setRec(hid, date, cnt) {
    if (useLS) return LS.setRecord(hid, date, cnt);
    const ex = await getRec(hid, date);
    if (ex) { ex.count = cnt; return dbOp('records', 'readwrite', s => s.put(ex)); }
    return dbOp('records', 'readwrite', s => s.add({ habitId: hid, date, count: cnt }));
}

// ========== UTILITIES ==========
const fmtDate = d => d.toISOString().split('T')[0];
const isToday = d => fmtDate(d) === fmtDate(new Date());
const isFuture = d => { const t = new Date(); t.setHours(0,0,0,0); const c = new Date(d); c.setHours(0,0,0,0); return c > t; };
const clamp = (v, mi, ma) => Math.max(mi, Math.min(ma, v));
const getCount = rec => rec && typeof rec.count === 'number' ? rec.count : 0;

function hexRgb(h) { const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h); return r ? { r: parseInt(r[1], 16), g: parseInt(r[2], 16), b: parseInt(r[3], 16) } : null; }
function rgbHex(r, g, b) { return '#' + [r, g, b].map(x => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0')).join(''); }
function interp(c1, c2, f) { const a = hexRgb(c1), b = hexRgb(c2); if (!a || !b) return c1; return rgbHex(a.r + (b.r - a.r) * f, a.g + (b.g - a.g) * f, a.b + (b.b - a.b) * f); }

function calcColor(h, cnt, mx, has) {
    if (!has) return '#333';
    const base = h.color || '#00d4ff';
    if (h.type === 'increase') {
        if (cnt === 0) return '#ff3366';
        return interp(interp(base, '#fff', .7), base, Math.min(cnt / Math.max(mx, 5), 1));
    } else {
        if (cnt === 0) return '#00ff88';
        return interp(base, interp(base, '#fff', .7), Math.min(cnt / Math.max(mx, 5), 1));
    }
}

async function getMaxCnt(hid) { const recs = await getRecsByHabit(hid); return recs.length ? Math.max(...recs.map(r => r.count), 5) : 5; }

function getWeekStart(d) { const dt = new Date(d), day = dt.getDay(), diff = dt.getDate() - day + (day === 0 ? -6 : 1); dt.setDate(diff); dt.setHours(0, 0, 0, 0); return dt; }

function toast(m) { const t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }

// ========== CALCULATIONS ==========
async function calcStreak(hid) {
    const recs = await getRecsByHabit(hid), habs = await getHabits(), hab = habs.find(h => h.id === hid);
    if (!recs.length || !hab) return { cur: 0, best: 0 };
    const dm = {}; recs.forEach(r => dm[r.date] = r.count);
    let cur = 0, best = 0, tmp = 0;
    const chk = new Date();
    while (cur < 365) {
        const ds = fmtDate(chk), cnt = dm[ds], has = typeof cnt === 'number', good = hab.type === 'increase' ? (cnt > 0) : (cnt === 0);
        if (has && good) { cur++; chk.setDate(chk.getDate() - 1); }
        else if (!has && isToday(chk)) { chk.setDate(chk.getDate() - 1); }
        else break;
    }
    const all = Object.keys(dm).sort();
    for (const d of all) { const cnt = dm[d], good = hab.type === 'increase' ? (cnt > 0) : (cnt === 0); if (good) { tmp++; best = Math.max(best, tmp); } else tmp = 0; }
    return { cur, best };
}

async function calcScore(date) {
    const habs = (await getHabits()).filter(h => !h.archived);
    if (!habs.length) return 0;
    const ds = fmtDate(date);
    let tot = 0, mx = 0;
    for (const h of habs) {
        const rec = await getRec(h.id, ds), cnt = getCount(rec), goal = h.goalDaily || 1;
        tot += (h.type === 'increase' ? Math.min(cnt / goal, 1) : (cnt === 0 ? 1 : Math.max(0, 1 - cnt / goal))) * 100;
        mx += 100;
    }
    return mx > 0 ? Math.round(tot / mx * 100) : 0;
}

async function calcGlobalStreak() {
    const habs = (await getHabits()).filter(h => !h.archived);
    if (!habs.length) return 0;
    let streak = 0; const chk = new Date(); chk.setDate(chk.getDate() - 1);
    while (streak < 365) { if (await calcScore(chk) >= 70) { streak++; chk.setDate(chk.getDate() - 1); } else break; }
    return streak;
}

async function calcWeekdayStats(hid) {
    const recs = await getRecsByHabit(hid), hab = (await getHabits()).find(h => h.id === hid);
    const stats = Array(7).fill(null).map(() => ({ tot: 0, cnt: 0 }));
    recs.forEach(r => { let idx = new Date(r.date).getDay() - 1; if (idx < 0) idx = 6; stats[idx].tot += r.count; stats[idx].cnt++; });
    return stats.map((s, i) => ({ day: DAYS[i], avg: s.cnt > 0 ? s.tot / s.cnt : 0, good: hab?.type === 'increase' }));
}

async function calcComp(hid, period = 'week') {
    const recs = await getRecsByHabit(hid), today = new Date();
    let cs, ce, ps, pe;
    if (period === 'week') {
        cs = getWeekStart(today); ce = new Date(cs); ce.setDate(ce.getDate() + 6);
        ps = new Date(cs); ps.setDate(ps.getDate() - 7); pe = new Date(cs); pe.setDate(pe.getDate() - 1);
    } else {
        cs = new Date(today.getFullYear(), today.getMonth(), 1); ce = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        ps = new Date(today.getFullYear(), today.getMonth() - 1, 1); pe = new Date(today.getFullYear(), today.getMonth(), 0);
    }
    let ct = 0, pt = 0;
    recs.forEach(r => { const d = new Date(r.date); if (d >= cs && d <= ce) ct += r.count; if (d >= ps && d <= pe) pt += r.count; });
    return { cur: ct, prev: pt, diff: Math.round(pt > 0 ? ((ct - pt) / pt * 100) : (ct > 0 ? 100 : 0)) };
}

async function getChartData(hid, days = 30) {
    const recs = await getRecsByHabit(hid), dm = {}; recs.forEach(r => dm[r.date] = r.count);
    const data = [], today = new Date();
    for (let i = days - 1; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); data.push({ date: fmtDate(d), val: dm[fmtDate(d)] || 0 }); }
    return { raw: data };
}

// ========== STATE ==========
let habits = [], selDay = new Date(), selWeek = new Date(), selMonth = new Date(), selYear = new Date().getFullYear();

function switchView(vid) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(vid).classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`[data-view="${vid}"]`).classList.add('active');
    ({ viewDay: renderDay, viewWeek: renderWeek, viewMonth: renderMonth, viewYear: renderYear, viewSettings: renderSettings })[vid]();
}

async function updateScore() {
    const score = await calcScore(selDay), gs = await calcGlobalStreak();
    document.getElementById('scoreVal').textContent = score;
    const col = score >= 80 ? '#00ff88' : score >= 50 ? '#ffee00' : '#ff3366';
    document.getElementById('scoreVal').style.textShadow = `0 0 20px ${col}`;
    document.getElementById('scoreCircle').style.background = `conic-gradient(${col} ${score * 3.6}deg, #1e1e1e 0deg)`;
    document.getElementById('scoreDate').textContent = isToday(selDay) ? 'Hoy' : selDay.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric' });
    document.getElementById('gStreak').textContent = `${gs} días`;
}

// ========== DAY VIEW ==========
function changeDay(d) { selDay.setDate(selDay.getDate() + d); renderDay(); }

async function renderDay() {
    habits = await getHabits(); await updateScore();
    const v = document.getElementById('viewDay'), ds = fmtDate(selDay), fut = isFuture(selDay), active = habits.filter(h => !h.archived);
    let html = `<div class="day-nav"><button class="day-btn" onclick="changeDay(-1)">←</button><div class="day-title"><h2>${isToday(selDay) ? 'Hoy' : selDay.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric' })}</h2><p>${selDay.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })}</p></div><button class="day-btn" onclick="changeDay(1)">→</button></div>`;
    
    if (!active.length) {
        html += `<div class="empty"><div class="empty-icon">📊</div><h3>Sin hábitos</h3><p>Añade tu primer hábito</p><button class="btn" onclick="switchView('viewSettings')">Ir a Ajustes</button></div>`;
        v.innerHTML = html; return;
    }
    
    let done = 0, best = 0;
    for (const h of active) {
        const rec = await getRec(h.id, ds), cnt = getCount(rec), goal = h.goalDaily || 1;
        if ((h.type === 'increase' && cnt >= goal) || (h.type === 'reduce' && cnt === 0)) done++;
        const st = await calcStreak(h.id); best = Math.max(best, st.cur);
    }
    const comp = active.length ? await calcComp(active[0].id) : { diff: 0 };
    
    html += `<div class="stats-row"><div class="stat-card ${done === active.length ? 'good' : ''}"><div class="stat-val">${done}/${active.length}</div><div class="stat-lbl">Completados</div></div><div class="stat-card"><div class="stat-val">🔥${best}</div><div class="stat-lbl">Mejor racha</div></div><div class="stat-card ${comp.diff >= 0 ? 'good' : 'bad'}"><div class="stat-val">${comp.diff >= 0 ? '+' : ''}${comp.diff}%</div><div class="stat-lbl">vs sem.ant.</div></div></div><div class="habit-list">`;
    
    for (const h of active) {
        const rec = await getRec(h.id, ds), cnt = getCount(rec), mx = await getMaxCnt(h.id), col = calcColor(h, cnt, mx, rec !== null);
        const st = await calcStreak(h.id), goal = h.goalDaily || 1, met = h.type === 'increase' ? cnt >= goal : cnt === 0;
        html += `<div class="habit-card"><div class="habit-info"><div class="habit-dot" style="background:${h.color};color:${h.color}"></div><div class="habit-details"><div class="habit-name">${h.name}</div><div class="habit-meta"><span class="habit-badge ${h.type === 'increase' ? 'inc' : 'red'}">${h.type === 'increase' ? '↑' : '↓'}</span>${st.cur > 0 ? `<span class="habit-streak">🔥${st.cur}</span>` : ''}<span class="habit-goal ${met ? 'done' : ''}">Meta:${goal}</span></div></div></div><div class="habit-counter"><button class="cnt-btn minus" data-id="${h.id}" data-d="-1"${fut ? ' disabled' : ''}>−</button><span class="cnt-val" style="color:${col}">${cnt}</span><button class="cnt-btn plus" data-id="${h.id}" data-d="1"${fut ? ' disabled' : ''}>+</button></div></div>`;
    }
    html += '</div>'; v.innerHTML = html;
    v.querySelectorAll('.cnt-btn').forEach(btn => btn.addEventListener('click', function() { updCnt(parseInt(this.dataset.id), parseInt(this.dataset.d)); }));
}

async function updCnt(hid, d) {
    const ds = fmtDate(selDay), rec = await getRec(hid, ds), newCnt = Math.max(0, getCount(rec) + d);
    await setRec(hid, ds, newCnt); renderDay();
}

// ========== WEEK VIEW ==========
function changeWeek(d) { selWeek.setDate(selWeek.getDate() + d * 7); renderWeek(); }

async function renderWeek() {
    habits = await getHabits();
    const v = document.getElementById('viewWeek'), active = habits.filter(h => !h.archived);
    const ws = getWeekStart(selWeek), we = new Date(ws); we.setDate(we.getDate() + 6);
    let html = `<div class="cal-header"><button class="cal-btn" onclick="changeWeek(-1)">←</button><h2 class="cal-title">${ws.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} - ${we.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</h2><button class="cal-btn" onclick="changeWeek(1)">→</button></div>`;
    if (!active.length) { v.innerHTML = html + '<div class="empty"><p>Sin hábitos</p></div>'; return; }
    
    html += `<div class="hab-sel"><select id="weekSel" onchange="renderWeek()">${active.map(h => `<option value="${h.id}">${h.name}</option>`).join('')}</select></div>`;
    const sel = document.querySelector('#weekSel'), hid = sel ? parseInt(sel.value) : active[0].id, hab = active.find(h => h.id === hid) || active[0];
    const mx = await getMaxCnt(hab.id), comp = await calcComp(hab.id, 'week');
    
    html += `<div class="cmp-bar"><div class="cmp-title">vs semana anterior</div><div class="cmp-content"><span class="cmp-val ${comp.diff > 0 ? 'pos' : comp.diff < 0 ? 'neg' : ''}">${comp.diff > 0 ? '+' : ''}${comp.diff}%</span><span class="cmp-detail">${comp.cur} vs ${comp.prev}</span></div></div><div class="heatmap"><div class="hm-week">${DAYS.map(d => `<div class="hm-lbl">${d}</div>`).join('')}</div><div class="hm-grid week">`;
    for (let i = 0; i < 7; i++) {
        const d = new Date(ws); d.setDate(d.getDate() + i);
        const ds = fmtDate(d), rec = await getRec(hab.id, ds), cnt = getCount(rec), has = rec !== null, fut = isFuture(d), col = calcColor(hab, cnt, mx, has);
        html += `<div class="hm-cell${fut ? ' future' : has ? '' : ' nodata'}" style="background:${fut ? 'transparent' : col}" onclick="goDay('${ds}')">${fut ? '' : cnt}</div>`;
    }
    html += '</div>' + renderLegend(hab) + '</div>' + await renderStats(hab, 14);
    v.innerHTML = html;
    const ns = document.querySelector('#weekSel'); if (ns) ns.value = hab.id;
}

// ========== MONTH VIEW ==========
function changeMonth(d) { selMonth.setMonth(selMonth.getMonth() + d); renderMonth(); }

async function renderMonth() {
    habits = await getHabits();
    const v = document.getElementById('viewMonth'), active = habits.filter(h => !h.archived);
    let html = `<div class="cal-header"><button class="cal-btn" onclick="changeMonth(-1)">←</button><h2 class="cal-title">${selMonth.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })}</h2><button class="cal-btn" onclick="changeMonth(1)">→</button></div>`;
    if (!active.length) { v.innerHTML = html + '<div class="empty"><p>Sin hábitos</p></div>'; return; }
    
    html += `<div class="hab-sel"><select id="monthSel" onchange="renderMonth()">${active.map(h => `<option value="${h.id}">${h.name}</option>`).join('')}</select></div>`;
    const sel = document.querySelector('#monthSel'), hid = sel ? parseInt(sel.value) : active[0].id, hab = active.find(h => h.id === hid) || active[0];
    const mx = await getMaxCnt(hab.id), comp = await calcComp(hab.id, 'month');
    const yr = selMonth.getFullYear(), mo = selMonth.getMonth(), fd = new Date(yr, mo, 1), ld = new Date(yr, mo + 1, 0);
    let sd = fd.getDay() - 1; if (sd < 0) sd = 6;
    
    html += `<div class="cmp-bar"><div class="cmp-title">vs mes anterior</div><div class="cmp-content"><span class="cmp-val ${comp.diff > 0 ? 'pos' : comp.diff < 0 ? 'neg' : ''}">${comp.diff > 0 ? '+' : ''}${comp.diff}%</span><span class="cmp-detail">${comp.cur} vs ${comp.prev}</span></div></div><div class="heatmap"><div class="hm-week">${DAYS.map(d => `<div class="hm-lbl">${d}</div>`).join('')}</div><div class="hm-grid month">`;
    for (let i = 0; i < sd; i++) html += '<div class="hm-cell empty"></div>';
    for (let day = 1; day <= ld.getDate(); day++) {
        const d = new Date(yr, mo, day), ds = fmtDate(d), rec = await getRec(hab.id, ds), cnt = getCount(rec), has = rec !== null, fut = isFuture(d), col = calcColor(hab, cnt, mx, has);
        html += `<div class="hm-cell${fut ? ' future' : has ? '' : ' nodata'}" style="background:${fut ? 'transparent' : col}" onclick="goDay('${ds}')">${fut ? '' : cnt}</div>`;
    }
    html += '</div>' + renderLegend(hab) + '</div>' + await renderStats(hab, 30);
    v.innerHTML = html;
    const ns = document.querySelector('#monthSel'); if (ns) ns.value = hab.id;
}

// ========== YEAR VIEW ==========
function changeYear(d) { selYear += d; renderYear(); }

async function renderYear() {
    habits = await getHabits();
    const v = document.getElementById('viewYear'), active = habits.filter(h => !h.archived);
    let html = `<div class="cal-header"><button class="cal-btn" onclick="changeYear(-1)">←</button><h2 class="cal-title">${selYear}</h2><button class="cal-btn" onclick="changeYear(1)">→</button></div>`;
    if (!active.length) { v.innerHTML = html + '<div class="empty"><p>Sin hábitos</p></div>'; return; }
    
    html += `<div class="hab-sel"><select id="yearSel" onchange="renderYear()">${active.map(h => `<option value="${h.id}">${h.name}</option>`).join('')}</select></div>`;
    const sel = document.querySelector('#yearSel'), hid = sel ? parseInt(sel.value) : active[0].id, hab = active.find(h => h.id === hid) || active[0];
    const mx = await getMaxCnt(hab.id), ys = new Date(selYear, 0, 1);
    let sd = ys.getDay() - 1; if (sd < 0) sd = 6;
    
    html += `<div class="heatmap" style="overflow-x:auto"><div class="yr-months">${MONTHS.map(m => `<span class="yr-month">${m}</span>`).join('')}</div><div class="hm-grid year">`;
    const cd = new Date(ys); cd.setDate(cd.getDate() - sd); const ye = new Date(selYear, 11, 31);
    for (let w = 0; w < 53; w++) {
        for (let d = 0; d < 7; d++) {
            const ds = fmtDate(cd), inYr = cd.getFullYear() === selYear;
            if (!inYr || cd > ye) html += '<div class="hm-cell empty"></div>';
            else {
                const rec = await getRec(hab.id, ds), cnt = getCount(rec), has = rec !== null, fut = isFuture(cd), col = calcColor(hab, cnt, mx, has);
                html += `<div class="hm-cell${fut ? ' future' : has ? '' : ' nodata'}" style="background:${fut ? 'transparent' : col}"></div>`;
            }
            cd.setDate(cd.getDate() + 1);
        }
    }
    html += '</div>' + renderLegend(hab) + '</div>';
    
    const recs = await getRecsByHabit(hab.id), yrRecs = recs.filter(r => new Date(r.date).getFullYear() === selYear);
    const tot = yrRecs.reduce((s, r) => s + r.count, 0), days = yrRecs.length, st = await calcStreak(hab.id);
    html += `<div class="stats-sec"><div class="stats-sec-title">Resumen anual</div><div class="stats-grid"><div class="s-card"><div class="s-card-hdr"><span class="s-card-icon">📊</span><span class="s-card-title">Total</span></div><div class="s-card-val" style="color:${hab.color}">${tot}</div></div><div class="s-card"><div class="s-card-hdr"><span class="s-card-icon">📅</span><span class="s-card-title">Días</span></div><div class="s-card-val">${days}</div></div><div class="s-card"><div class="s-card-hdr"><span class="s-card-icon">📈</span><span class="s-card-title">Media</span></div><div class="s-card-val">${days > 0 ? (tot / days).toFixed(1) : 0}</div></div><div class="s-card"><div class="s-card-hdr"><span class="s-card-icon">🏆</span><span class="s-card-title">Récord</span></div><div class="s-card-val" style="color:var(--yellow)">${st.best}</div></div></div></div>`;
    v.innerHTML = html;
    const ns = document.querySelector('#yearSel'); if (ns) ns.value = hab.id;
}

// ========== STATS ==========
async function renderStats(h, days) {
    const st = await calcStreak(h.id), wd = await calcWeekdayStats(h.id), cd = await getChartData(h.id, days), ma = Math.max(...wd.map(s => s.avg), 1);
    let html = `<div class="stats-sec"><div class="stats-sec-title">Estadísticas</div><div class="stats-grid"><div class="s-card"><div class="s-card-hdr"><span class="s-card-icon">🔥</span><span class="s-card-title">Racha actual</span></div><div class="s-card-val" style="color:var(--orange)">${st.cur}</div><div class="s-card-sub">días</div></div><div class="s-card"><div class="s-card-hdr"><span class="s-card-icon">🏆</span><span class="s-card-title">Mejor racha</span></div><div class="s-card-val" style="color:var(--yellow)">${st.best}</div><div class="s-card-sub">récord</div></div></div><div class="days-box"><div class="days-title">Por día de semana</div><div class="days-bars">${wd.map(s => { const ht = (s.avg / ma * 40) + 10, good = h.type === 'increase' ? s.avg > ma * .7 : s.avg < ma * .3; return `<div class="day-bar-item"><div class="day-bar" style="height:${ht}px;background:${good ? 'var(--green)' : h.color}"></div><div class="day-bar-lbl">${s.day}</div></div>`; }).join('')}</div></div>${renderChart(cd, h.color)}</div>`;
    return html;
}

function renderChart(data, col) {
    const mx = Math.max(...data.raw.map(d => d.val), 1), w = 100, ht = 80, p = 5, xs = (w - p * 2) / (data.raw.length - 1), ys = (ht - p * 2) / mx;
    const pts = data.raw.map((d, i) => `${p + i * xs},${ht - p - d.val * ys}`).join(' ');
    return `<div class="chart-box"><div class="chart-title">Evolución (${data.raw.length}d)</div><svg class="chart-svg" viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none"><polygon class="chart-area" points="${p},${ht - p} ${pts} ${p + (data.raw.length - 1) * xs},${ht - p}" fill="${col}"/><polyline class="chart-line" points="${pts}" stroke="${col}"/></svg></div>`;
}

function renderLegend(h) {
    const lvls = h.type === 'increase' ? [{ c: '#333' }, { c: '#ff3366' }, { c: interp(h.color, '#fff', .5) }, { c: h.color }] : [{ c: '#333' }, { c: '#00ff88' }, { c: h.color }, { c: interp(h.color, '#fff', .5) }];
    return `<div class="hm-legend"><span>-</span>${lvls.map(l => `<div class="hm-leg-cell" style="background:${l.c}"></div>`).join('')}<span>+</span></div>`;
}

function goDay(ds) { selDay = new Date(ds); switchView('viewDay'); }

// ========== SETTINGS ==========
async function renderSettings() {
    habits = await getHabits();
    const v = document.getElementById('viewSettings'), active = habits.filter(h => !h.archived), archived = habits.filter(h => h.archived);
    let html = '<div class="set-sec"><h3>Mis Hábitos</h3><div class="set-list">';
    if (!active.length) html += '<div class="empty" style="padding:20px"><p>Sin hábitos</p></div>';
    else for (const h of active) html += `<div class="set-item" data-edit="${h.id}"><div class="set-item-info"><div class="set-item-color" style="background:${h.color}"></div><div class="set-item-details"><h4>${h.name}</h4><p>${h.type === 'increase' ? '↑' : '↓'} Meta:${h.goalDaily || 1}/día</p></div></div><span class="set-item-action">→</span></div>`;
    html += '</div><button class="add-btn" id="addHabitBtn">+ Añadir</button></div>';
    
    if (archived.length) {
        html += '<div class="set-sec"><h3>Archivados</h3><div class="set-list">';
        for (const h of archived) html += `<div class="set-item" style="opacity:.5" data-edit="${h.id}"><div class="set-item-info"><div class="set-item-color" style="background:${h.color}"></div><div class="set-item-details"><h4>${h.name}</h4><p>Archivado</p></div></div><span class="set-item-action">→</span></div>`;
        html += '</div></div>';
    }
    
    html += `<div class="set-sec"><h3>Datos</h3><div class="set-list"><div class="set-item" id="exportBtn"><div class="set-item-info"><div class="set-item-details"><h4>Exportar</h4><p>Copia de seguridad</p></div></div><span class="set-item-action">→</span></div><div class="set-item" id="importBtn"><div class="set-item-info"><div class="set-item-details"><h4>Importar</h4><p>Restaurar datos</p></div></div><span class="set-item-action">→</span></div></div></div>`;
    
    v.innerHTML = html;
    document.getElementById('addHabitBtn').addEventListener('click', openAdd);
    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('importBtn').addEventListener('click', () => document.getElementById('fileInput').click());
    v.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => openEdit(parseInt(el.dataset.edit))));
}

// ========== MODAL ==========
function openModal() { document.getElementById('modalBg').classList.add('active'); }
function closeModal() { document.getElementById('modalBg').classList.remove('active'); }

function openAdd() {
    document.getElementById('modalTitle').textContent = 'Nuevo hábito';
    document.getElementById('modalContent').innerHTML = getForm();
    setupForm(); openModal();
}

async function openEdit(id) {
    const h = habits.find(x => x.id === id); if (!h) return;
    document.getElementById('modalTitle').textContent = 'Editar';
    document.getElementById('modalContent').innerHTML = getForm(h);
    setupForm(h); openModal();
}

function getForm(h = null) {
    const isE = h !== null, col = h?.color || COLORS[0], type = h?.type || 'increase';
    return `<form id="habitForm"><div class="form-group"><label>Nombre</label><input type="text" id="fName" value="${h?.name || ''}" placeholder="Ej: Vasos de agua" required></div><div class="form-group"><label>Tipo</label><div class="type-sel"><div class="type-opt ${type === 'increase' ? 'sel' : ''}" data-type="increase"><div class="type-opt-icon">↑</div><div class="type-opt-lbl">Aumentar</div><div class="type-opt-desc">Más=mejor</div></div><div class="type-opt ${type === 'reduce' ? 'sel' : ''}" data-type="reduce"><div class="type-opt-icon">↓</div><div class="type-opt-lbl">Reducir</div><div class="type-opt-desc">Menos=mejor</div></div></div><input type="hidden" id="fType" value="${type}"></div><div class="form-group"><label>Meta diaria</label><input type="number" id="fGoalD" value="${h?.goalDaily || 1}" min="0"></div><div class="form-group"><label>Color</label><div class="color-picker">${COLORS.map(c => `<div class="color-opt ${c === col ? 'sel' : ''}" style="background:${c}" data-color="${c}"></div>`).join('')}</div><input type="hidden" id="fColor" value="${col}"></div>${isE ? `<div class="form-group"><div class="chk-grp"><input type="checkbox" id="fArch" ${h.archived ? 'checked' : ''}><label>Archivar</label></div></div>` : ''}<div class="form-actions">${isE ? `<button type="button" class="btn-del" id="delBtn">Eliminar</button>` : ''}<button type="button" class="btn-sec" id="cancelBtn">Cancelar</button><button type="submit" class="btn">${isE ? 'Guardar' : 'Crear'}</button></div></form>`;
}

function setupForm(h = null) {
    document.querySelectorAll('.type-opt').forEach(el => el.addEventListener('click', function() { document.querySelectorAll('.type-opt').forEach(o => o.classList.remove('sel')); this.classList.add('sel'); document.getElementById('fType').value = this.dataset.type; }));
    document.querySelectorAll('.color-opt').forEach(el => el.addEventListener('click', function() { document.querySelectorAll('.color-opt').forEach(o => o.classList.remove('sel')); this.classList.add('sel'); document.getElementById('fColor').value = this.dataset.color; }));
    document.getElementById('cancelBtn').addEventListener('click', closeModal);
    document.getElementById('habitForm').addEventListener('submit', e => { e.preventDefault(); saveHabit(h ? h.id : null); });
    if (h) document.getElementById('delBtn').addEventListener('click', () => showConfirm('¿Eliminar hábito?', 'Se borrarán todos los datos', () => confirmDel(h.id)));
}

async function saveHabit(id) {
    const h = { name: document.getElementById('fName').value.trim(), type: document.getElementById('fType').value, color: document.getElementById('fColor').value, goalDaily: parseInt(document.getElementById('fGoalD').value) || 1, goalWeekly: 7, goalMonthly: 30, archived: document.getElementById('fArch')?.checked || false };
    if (!h.name) { toast('Nombre requerido'); return; }
    if (id) { h.id = id; await updateHabit(h); toast('Actualizado'); }
    else { await addHabit(h); toast('Creado'); }
    closeModal(); renderSettings();
}

function showConfirm(title, msg, onConfirm) {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMsg').textContent = msg;
    document.getElementById('confirmBtn').onclick = () => { closeConfirm(); onConfirm(); };
    document.getElementById('confirmModal').classList.add('active');
}
function closeConfirm() { document.getElementById('confirmModal').classList.remove('active'); }

async function confirmDel(id) { await deleteHabit(id); toast('Eliminado'); closeModal(); renderSettings(); }

// ========== IMPORT/EXPORT ==========
async function exportData() {
    const habs = await getHabits(), recs = await getAllRecs();
    const blob = new Blob([JSON.stringify({ v: 2, habits: habs, records: recs }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `habitos-${fmtDate(new Date())}.json`; a.click();
    URL.revokeObjectURL(url); toast('Exportado');
}

async function handleImport(e) {
    const file = e.target.files[0]; if (!file) return;
    try {
        const data = JSON.parse(await file.text());
        if (!data.habits) throw new Error('Formato inválido');
        const ex = await getHabits(); for (const h of ex) await deleteHabit(h.id);
        const idMap = {};
        for (const h of data.habits) { const old = h.id; delete h.id; idMap[old] = await addHabit(h); }
        for (const r of (data.records || [])) if (idMap[r.habitId]) await setRec(idMap[r.habitId], r.date, r.count);
        toast('Importado'); renderSettings();
    } catch (err) { toast('Error: ' + err.message); }
    e.target.value = '';
}

// ========== SERVICE WORKER ==========
function regSW() { if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {}); }

// ========== INIT ==========
async function init() {
    try {
        await initDB();
        document.querySelectorAll('.nav-item').forEach(i => i.addEventListener('click', () => switchView(i.dataset.view)));
        document.getElementById('modalBg').addEventListener('click', e => { if (e.target.id === 'modalBg') closeModal(); });
        document.getElementById('confirmModal').addEventListener('click', e => { if (e.target.id === 'confirmModal') closeConfirm(); });
        document.getElementById('fileInput').addEventListener('change', handleImport);
        regSW();
        await renderDay();
    } catch (err) {
        console.error('Init error:', err);
        document.getElementById('viewDay').innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>Error al iniciar</h3><p>${err.message}</p><button class="btn" onclick="location.reload()">Reintentar</button></div>`;
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
