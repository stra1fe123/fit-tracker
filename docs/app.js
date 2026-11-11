'use strict';

// ---------- Константы ----------

const SHEETS = ['Settings', 'Products', 'Meals', 'Workouts', 'Exercises', 'Log', 'Weight', 'Sessions'];
const NUM = new Set(['protein', 'fat', 'carbs', 'kcal', 'grams', 'sets', 'reps', 'weight', 'order', 'set', 'duration', 'startedAt']);

const ACTIVITY = [
  ['1.2', 'Минимальная (сидячая работа, без спорта)'],
  ['1.375', 'Лёгкая (1–3 тренировки в неделю)'],
  ['1.55', 'Средняя (3–5 тренировок в неделю)'],
  ['1.725', 'Высокая (6–7 тренировок в неделю)'],
];
// Курсы: ключ хранится в настройке goal; множитель калорий для автоматического режима
const GOALS = [
  ['bulk', 'Набор массы', 1.1],
  ['keep', 'Поддержание', 1],
  ['cut', 'Сушка', 0.85],
];
const ICON_EDIT = '<svg class="ico" viewBox="0 0 24 24" aria-label="Изменить"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="M13.5 6.5l4 4"/></svg>';
const TITLES = { food: 'Питание', workouts: 'Тренировки', progress: 'Прогресс', profile: 'Профиль' };

// ---------- Утилиты ----------

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* хранилище недоступно */ }
  },
};

const $ = sel => document.querySelector(sel);
const scrollTop = () => { $('#view').scrollTop = 0; };
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => iso(new Date());
const r1 = n => Math.round(n * 10) / 10;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return iso(d);
}
function fmtDay(s) {
  if (s === today()) return 'Сегодня';
  if (s === addDays(today(), -1)) return 'Вчера';
  return parseDate(s).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
}
const fmtShort = s => parseDate(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

function num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
  return isFinite(n) ? n : 0;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- Данные и синхронизация ----------
// Все данные лежат в памяти (db) и в localStorage, поэтому приложение работает мгновенно.
// Изменения складываются в очередь (queue) и отправляются в Google Таблицу, когда есть связь.

function normalize(data) {
  const out = {};
  SHEETS.forEach(name => {
    out[name] = ((data && data[name]) || []).map(row => {
      const r = Object.assign({}, row);
      Object.keys(r).forEach(k => { if (NUM.has(k)) r[k] = num(r[k]); });
      r.id = String(r.id);
      return r;
    });
  });
  return out;
}

let db = normalize(store.get('ft.db', {}));
let queue = store.get('ft.queue', []);
let conn = store.get('ft.conn', { url: '', token: '' });
// Листы, которые есть в подключённой таблице. Если скрипт старый и какого-то листа
// в нём ещё нет, изменения для него откладываются (deferred) до обновления скрипта.
let serverSheets = store.get('ft.serverSheets', null);
let deferred = store.get('ft.deferred', []);
const serverLacks = sheet => !!serverSheets && !serverSheets.includes(sheet);

function persist() {
  store.set('ft.db', db);
  store.set('ft.queue', queue);
  store.set('ft.deferred', deferred);
}

function upsert(sheet, rows) {
  rows = [].concat(rows);
  rows.forEach(row => {
    const i = db[sheet].findIndex(r => r.id === row.id);
    if (i >= 0) db[sheet][i] = row; else db[sheet].push(row);
  });
  if (conn.url) (serverLacks(sheet) ? deferred : queue).push({ action: 'upsert', sheet, rows });
  persist();
  flush();
}

function remove(sheet, ids) {
  ids = [].concat(ids);
  db[sheet] = db[sheet].filter(r => !ids.includes(r.id));
  if (conn.url) (serverLacks(sheet) ? deferred : queue).push({ action: 'remove', sheet, ids });
  persist();
  flush();
}

async function api(body) {
  // без ответа за 30 секунд считаем, что связи нет, иначе индикатор зависает на «сохраняю…»
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let json;
  try {
    // Content-Type text/plain — так браузер не делает лишний CORS-запрос, и Google его принимает
    const res = await fetch(conn.url, {
      method: 'POST', signal: ctrl.signal,
      body: JSON.stringify(Object.assign({}, body, { token: conn.token })),
    });
    json = await res.json();
  } catch (e) {
    throw new Error('нет связи с таблицей');
  } finally {
    clearTimeout(timer);
  }
  if (!json.ok) throw new Error(json.error);
  return json.data;
}

function setSync(state) {
  $('#sync').textContent = {
    local: 'локально',
    saving: 'сохраняю…',
    ok: '✓ синхр.',
    offline: 'нет связи',
  }[state];
}

let flushing = false;
async function flush() {
  if (!conn.url || flushing || !queue.length) return;
  flushing = true;
  setSync('saving');
  try {
    while (queue.length) {
      await api(queue[0]);
      queue.shift();
      persist();
    }
    setSync('ok');
  } catch (e) {
    setSync('offline');
    if (e.message !== 'нет связи с таблицей') toast('Ошибка сохранения: ' + e.message);
  } finally {
    flushing = false;
  }
}

async function pull() {
  if (!conn.url) { setSync('local'); return; }
  await flush();
  if (queue.length) return; // есть неотправленные изменения — не затираем их
  try {
    const data = await api({ action: 'all' });
    if (queue.length) return;
    serverSheets = Object.keys(data);
    store.set('ft.serverSheets', serverSheets);
    if (deferred.length && SHEETS.every(s => data[s])) {
      // скрипт обновили — отправляем отложенное и загружаем заново
      queue.push(...deferred);
      deferred = [];
      persist();
      return pull();
    }
    // листов, которых нет в таблице, сохраняем локальную копию
    SHEETS.forEach(s => { if (!data[s]) data[s] = db[s]; });
    db = normalize(data);
    persist();
    setSync('ok');
    // не перерисовываем, пока человек что-то печатает
    if (!(document.activeElement && document.activeElement.matches('input, select'))) render();
  } catch (e) {
    setSync('offline');
  }
}

function setting(key, fallback) {
  const r = db.Settings.find(s => s.id === key);
  return r && r.value !== '' ? String(r.value) : (fallback == null ? '' : fallback);
}
function setSetting(key, value) {
  upsert('Settings', { id: key, value: String(value) });
}

// ---------- Расчёты ----------

function weights() {
  return db.Weight.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Средний вес за 7 дней до последнего взвешивания — сглаживает колебания воды
function avgWeight() {
  const w = weights();
  if (!w.length) return 0;
  const from = addDays(w[w.length - 1].date, -6);
  const recent = w.filter(x => x.date >= from);
  return r1(recent.reduce((s, x) => s + x.weight, 0) / recent.length);
}

function ageFrom(birthDate) {
  const b = parseDate(birthDate);
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--;
  return age;
}

const course = () => setting('goal', 'keep');
const courseInfo = key => GOALS.find(g => g[0] === key) || GOALS[1];
const MACRO_KEYS = ['proteinPerKg', 'fatPerKg', 'carbsPerKg'];

// «Свои пропорции» хранятся отдельно для каждого курса: proteinPerKg_bulk и т.д.
// Старые значения без курса действуют, пока не сохранена норма ни для одного курса.
function customPerKg(key, c) {
  const own = setting(`${key}_${c}`);
  if (own) return num(own);
  return GOALS.some(g => setting(`${key}_${g[0]}`)) ? 0 : num(setting(key));
}

// Норма на день. Режим «Свои пропорции»: граммы на 1 кг веса, которые задал сам.
// Режим «Авто»: формула Миффлина–Сан Жеора + коэффициент активности + курс.
function targets(c = course()) {
  const w = avgWeight();
  if (!w) return null;
  if (setting('mode', 'auto') === 'custom') {
    if (!customPerKg('proteinPerKg', c)) return null;
    const protein = Math.round(w * customPerKg('proteinPerKg', c));
    const fat = Math.round(w * customPerKg('fatPerKg', c));
    const carbs = Math.round(w * customPerKg('carbsPerKg', c));
    return { custom: true, kcal: protein * 4 + fat * 9 + carbs * 4, protein, fat, carbs, weight: w };
  }
  return autoTargets(c);
}

function autoTargets(c) {
  const w = avgWeight();
  const h = num(setting('height'));
  const bd = setting('birthDate');
  if (!w || !h || !bd) return null;
  const age = ageFrom(bd);
  const bmr = 10 * w + 6.25 * h - 5 * age + (setting('sex', 'male') === 'female' ? -161 : 5);
  const tdee = bmr * num(setting('activity', '1.375'));
  const goal = courseInfo(c);
  const kcal = Math.round(tdee * goal[2]);
  const protein = Math.round(w * (c === 'cut' ? 2 : 1.8));
  const fat = Math.round(w * (c === 'cut' ? 0.8 : 1));
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  return { kcal, protein, fat, carbs, weight: w, age, bmr: Math.round(bmr), tdee: Math.round(tdee), goal };
}

// Темп изменения веса с начала курса и подсказка, нормальный ли он
function courseProgress() {
  const start = setting('courseStart');
  const ws = weights();
  if (!start || !ws.length) return null;
  const startEntry = ws.find(w => w.date >= start) || ws[ws.length - 1];
  const days = Math.round((parseDate(today()) - parseDate(start)) / 86400000);
  const change = r1(avgWeight() - startEntry.weight);
  const res = { days, weeks: Math.floor(days / 7), change, startWeight: startEntry.weight };
  if (days < 14) return res; // за первые две недели темп ещё ни о чём не говорит
  const rate = change / (days / 7);
  const w = avgWeight();
  const [lo, hi] = { bulk: [0.25, 0.5], keep: [-0.2, 0.2], cut: [-0.01 * w, -0.005 * w] }[course()];
  res.rate = Math.round(rate * 100) / 100;
  res.range = [Math.round(lo * 100) / 100, Math.round(hi * 100) / 100];
  res.verdict = rate < lo ? 'low' : rate > hi ? 'high' : 'ok';
  return res;
}

function totals(meals) {
  return meals.reduce((s, m) => ({
    protein: s.protein + m.protein, fat: s.fat + m.fat, carbs: s.carbs + m.carbs, kcal: s.kcal + m.kcal,
  }), { protein: 0, fat: 0, carbs: 0, kcal: 0 });
}

const macrosLine = p => `Б ${r1(p.protein)} · Ж ${r1(p.fat)} · У ${r1(p.carbs)} · ${Math.round(p.kcal)} ккал`;

// ---------- Состояние интерфейса ----------

const ui = {
  tab: 'food',
  date: today(),
  foodQuery: '',
  pick: null,          // выбранный продукт в форме добавления еды
  edit: null,          // редактируемая тренировка
  session: store.get('ft.session', null), // идущая тренировка (переживает закрытие приложения)
  sessionOpen: false,
  progressEx: '',
  editProduct: null,
};
ui.sessionOpen = !!ui.session;
// тренировка, начатая до появления таймера, — считаем от текущего момента
if (ui.session && !ui.session.startedAt) Object.assign(ui.session, { startedAt: Date.now(), pausedAt: null, pausedMs: 0 });

const saveSession = () => store.set('ft.session', ui.session);

// ---------- Отрисовка ----------

function render() {
  $('#title').textContent = TITLES[ui.tab];
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));
  $('#view').innerHTML = { food: viewFood, workouts: viewWorkouts, progress: viewProgress, profile: viewProfile }[ui.tab]();
}

function bar(value, target, cls) {
  const pct = target ? Math.min(100, (value / target) * 100) : 0;
  return `<div class="bar ${target && value > target * 1.05 ? 'over' : ''} ${cls || ''}"><i style="width:${pct}%"></i></div>`;
}

function macro(cls, label, value, target) {
  return `<div class="macro ${cls}"><span class="muted small">${label}</span>
    <b>${Math.round(value)}${target ? ` <span class="muted small">/ ${target} г</span>` : ' г'}</b>${bar(value, target)}</div>`;
}

// ----- Питание -----

// Среднее БЖУ в день за прошедшие дни этой недели (с понедельника до выбранного дня, не включая его;
// пустые дни не считаем) и сколько съесть сегодня, чтобы неделя в среднем вышла на норму.
function weekCard(t) {
  const monday = addDays(ui.date, -((parseDate(ui.date).getDay() + 6) % 7));
  const days = {};
  db.Meals.filter(m => m.date >= monday && m.date < ui.date).forEach(m => { (days[m.date] = days[m.date] || []).push(m); });
  const n = Object.keys(days).length;
  if (!n) return '';
  const sum = totals([].concat(...Object.values(days)));
  const cell = (cls, label, key) => {
    const avg = Math.round(sum[key] / n);
    const diff = t ? avg - t[key] : 0;
    return `<div class="macro ${cls}"><span class="muted small">${label}</span>
      <b>${avg} г${t && Math.abs(diff) >= 1 ? ` <span class="small ${diff < 0 ? 'under' : 'muted'}">${diff > 0 ? '+' : '−'}${Math.abs(diff)}</span>` : ''}</b>
      ${bar(avg, t && t[key])}</div>`;
  };
  // сколько нужно сегодня, чтобы среднее за неделю сравнялось с нормой; не больше +30% к дневной норме
  const need = key => Math.max(0, Math.min(Math.round(t[key] * (n + 1) - sum[key]), Math.round(t[key] * 1.3)));
  return `<div class="card week">
    <div class="row between"><h2 style="margin:0">Неделя · среднее за ${n} дн.</h2>
      <span class="muted small" style="white-space:nowrap">${Math.round(sum.kcal / n)} ккал</span></div>
    <div class="macros" style="margin-top:12px">
      ${cell('p', 'Белки', 'protein')}${cell('f', 'Жиры', 'fat')}${cell('c', 'Углеводы', 'carbs')}
    </div>
    ${t ? `<p class="small hint" style="margin:10px 0 0">Чтобы неделя вышла на норму, ${ui.date === today() ? 'сегодня' : 'в этот день'}:
      Б ${need('protein')} · Ж ${need('fat')} · У ${need('carbs')} г</p>` : ''}
  </div>`;
}

function viewFood() {
  const meals = db.Meals.filter(m => m.date === ui.date);
  const sum = totals(meals);
  const t = targets();
  return `
    <div class="datebar">
      <button class="icon-btn" data-act="day" data-d="-1">‹</button>
      <strong>${fmtDay(ui.date)}</strong>
      <button class="icon-btn" data-act="day" data-d="1" ${ui.date >= today() ? 'disabled' : ''}>›</button>
    </div>
    ${weightBanner()}
    ${weekCard(t)}
    <div class="card hero">
      <div class="muted small" style="margin-bottom:6px">Курс: ${courseInfo(course())[1].toLowerCase()}</div>
      ${t
        ? `<div class="row between"><div><span class="kcal-big">${Math.round(sum.kcal)}</span> <span class="muted">/ ${t.kcal} ккал</span></div>
           <span class="muted small">осталось ${Math.max(0, t.kcal - Math.round(sum.kcal))}</span></div>${bar(sum.kcal, t.kcal)}`
        : `<div><span class="kcal-big">${Math.round(sum.kcal)}</span> <span class="muted">ккал</span></div>
           <p class="muted small" style="margin:4px 0 0">${avgWeight() && setting('mode') === 'custom'
             ? `Для курса «${courseInfo(course())[1]}» норма ещё не задана — задай её в Профиле.`
             : 'Заполни профиль и внеси вес — появится дневная норма.'}</p>`}
      <div class="macros">
        ${macro('p', 'Белки', sum.protein, t && t.protein)}
        ${macro('f', 'Жиры', sum.fat, t && t.fat)}
        ${macro('c', 'Углеводы', sum.carbs, t && t.carbs)}
      </div>
    </div>
    <div class="card">
      <h2>Добавить еду</h2>
      <input id="food-q" data-input="food-q" placeholder="Начни вводить продукт…" value="${esc(ui.foodQuery)}" autocomplete="off">
      <ul id="suggest" class="suggest" ${suggestHtml() ? '' : 'hidden'}>${suggestHtml()}</ul>
      <div id="pick-area">${ui.pick ? pickForm() : recentChips()}</div>
    </div>
    <div class="card">
      <h2>Съедено</h2>
      ${meals.length ? `<ul class="list">${meals.map(mealItem).join('')}</ul>` : '<p class="empty">Пока пусто</p>'}
    </div>`;
}

// Дни взвешивания: номера дней недели как в JS (0 — воскресенье)
const WEEKDAYS = [[1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [0, 'Вс']];
const DEFAULT_WEIGH_DAYS = '2,5,0';
const weighDays = () => setting('weighDays', DEFAULT_WEIGH_DAYS).split(',').map(Number).filter(n => !isNaN(n));

function weightBanner() {
  if (ui.date !== today() || db.Weight.some(w => w.date === today())) return '';
  if (!weighDays().includes(new Date().getDay())) return '';
  return `<div class="banner">
    <b>Пора взвеситься</b>
    <p class="small" style="margin:4px 0 8px">Лучше утром, натощак, в одно и то же время.</p>
    <div class="row"><input id="w-today" inputmode="decimal" placeholder="Вес, кг">
    <button class="btn" data-act="save-weight" data-src="w-today">Сохранить</button></div>
  </div>`;
}

function suggestHtml() {
  const q = ui.foodQuery.trim().toLowerCase();
  if (!q || ui.pick) return '';
  const found = db.Products.filter(p => p.name.toLowerCase().includes(q)).slice(0, 6);
  const exact = db.Products.some(p => p.name.toLowerCase() === q);
  return found.map(p => `<li data-act="pick" data-id="${esc(p.id)}">${esc(p.name)}<br><span class="muted small">${macrosLine(p)}</span></li>`).join('')
    + (exact ? '' : `<li data-act="pick-new">+ Новый продукт «${esc(ui.foodQuery.trim())}»</li>`);
}

function recentChips() {
  const seen = new Set();
  const recent = [];
  for (let i = db.Meals.length - 1; i >= 0 && recent.length < 8; i--) {
    const p = db.Products.find(x => x.id === db.Meals[i].productId);
    if (p && !seen.has(p.id)) { seen.add(p.id); recent.push(p); }
  }
  if (!recent.length) return '<p class="muted small" style="margin:8px 0 0">Продукты, которые ты вводишь, запоминаются — в следующий раз достаточно начать печатать название.</p>';
  return `<div class="chips">${recent.map(p => `<button class="chip" data-act="pick" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>`;
}

function pickForm() {
  const p = ui.pick;
  return `<div class="mt">
    ${p.isNew
      ? `<p class="muted small" style="margin:0 0 6px">Новый продукт «${esc(p.name)}». Пищевая ценность на 100 г (есть на упаковке):</p>
         <div class="row">
           <label class="grow">Белки<input id="np" data-input="pick" inputmode="decimal"></label>
           <label class="grow">Жиры<input id="nf" data-input="pick" inputmode="decimal"></label>
           <label class="grow">Углев.<input id="nc" data-input="pick" inputmode="decimal"></label>
           <label class="grow">Ккал<input id="nk" data-input="pick" inputmode="decimal" placeholder="авто"></label>
         </div>`
      : `<p class="muted small" style="margin:0 0 6px"><b>${esc(p.name)}</b> на 100 г: ${macrosLine(p)}</p>`}
    <label>Сколько грамм<input id="grams" data-input="pick" inputmode="decimal" value="${esc(p.grams)}"></label>
    <p id="preview" class="small" style="margin:0 0 10px">${previewText()}</p>
    <div class="row">
      <button class="btn grow" data-act="add-meal">Добавить</button>
      <button class="btn ghost" data-act="cancel-pick">Отмена</button>
    </div>
  </div>`;
}

// Пищевая ценность выбранного продукта на 100 г (для нового — из полей формы)
function pickPer100() {
  const p = ui.pick;
  if (!p.isNew) return p;
  const val = id => ($('#' + id) ? num($('#' + id).value) : 0);
  const protein = val('np'), fat = val('nf'), carbs = val('nc');
  const kcal = val('nk') || Math.round(protein * 4 + fat * 9 + carbs * 4);
  return { protein, fat, carbs, kcal };
}

function previewText() {
  const per = pickPer100();
  const g = $('#grams') ? num($('#grams').value) : num(ui.pick.grams);
  const k = g / 100;
  return `Итого: <b>${Math.round(per.kcal * k)} ккал</b> · Б ${r1(per.protein * k)} · Ж ${r1(per.fat * k)} · У ${r1(per.carbs * k)}`;
}

function mealItem(m) {
  return `<li>
    <div class="info"><div class="name">${esc(m.name)}</div>
    <div class="muted small">${r1(m.grams)} г · Б ${r1(m.protein)} · Ж ${r1(m.fat)} · У ${r1(m.carbs)}</div></div>
    <b>${Math.round(m.kcal)}</b>
    <button class="icon-btn" data-act="del-meal" data-id="${esc(m.id)}">✕</button>
  </li>`;
}

function updateFoodSearch() {
  const html = suggestHtml();
  $('#suggest').innerHTML = html;
  $('#suggest').hidden = !html;
  $('#pick-area').innerHTML = ui.pick ? pickForm() : recentChips();
}

// ----- Тренировки -----

const workoutsSorted = () => db.Workouts.slice().sort((a, b) => a.order - b.order);
const exercisesOf = id => db.Exercises.filter(e => e.workoutId === id).sort((a, b) => a.order - b.order);

function lastDone(workoutId) {
  return db.Log.filter(l => l.workoutId === workoutId).reduce((max, l) => (l.date > max ? l.date : max), '');
}

// ----- Таймер тренировки -----
// Время считается от отметки начала, поэтому не сбивается, если свернуть или закрыть приложение.

function elapsed(s) {
  if (!s || !s.startedAt) return 0;
  return Math.max(0, (s.pausedAt || Date.now()) - s.startedAt - (s.pausedMs || 0));
}
function fmtTimer(ms) {
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
  return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(t % 60);
}
function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} ч ${pad(m % 60)} мин` : `${m} мин`;
}
const sessionsSorted = () => db.Sessions.slice().sort((a, b) => (a.date === b.date ? a.startedAt - b.startedAt : a.date < b.date ? -1 : 1));
const lastSessionOf = workoutId => sessionsSorted().filter(s => s.workoutId === workoutId).pop();

setInterval(() => {
  if (!ui.session) return;
  document.querySelectorAll('[data-timer]').forEach(el => { el.textContent = fmtTimer(elapsed(ui.session)); });
}, 1000);

// Подходы из последней тренировки с этим упражнением
function lastSets(exerciseId) {
  const logs = db.Log.filter(l => l.exerciseId === exerciseId);
  if (!logs.length) return null;
  const date = logs.reduce((max, l) => (l.date > max ? l.date : max), '');
  return logs.filter(l => l.date === date).sort((a, b) => a.set - b.set);
}

// Если в прошлый раз все подходы сделаны на нужное число повторов — предлагаем добавить вес
function suggestion(x) {
  const last = lastSets(x.exerciseId);
  const planW = num(x.weight), planR = num(x.reps);
  if (!last || !planW || !planR || last.length < x.planSets) return 0;
  const allDone = last.every(l => l.reps >= planR) && Math.max(...last.map(l => l.weight)) >= planW;
  if (!allDone) return 0;
  return r1(planW + (planW >= 40 ? 2.5 : 1));
}

function viewWorkouts() {
  if (ui.edit) return viewEdit();
  if (ui.session && ui.sessionOpen) return viewSession();
  const list = workoutsSorted();
  return `
    ${ui.session ? `<div class="banner row between"><span>Идёт тренировка «${esc(ui.session.name)}»
      · <b data-timer>${fmtTimer(elapsed(ui.session))}</b></span>
      <button class="btn" data-act="open-session">Продолжить</button></div>` : ''}
    ${list.length ? list.map(w => {
      const ex = exercisesOf(w.id);
      const lastS = lastSessionOf(w.id);
      const last = lastDone(w.id);
      return `<div class="card">
        <div class="row between"><h3 class="display" style="margin:0;font-size:22px">${esc(w.name)}</h3>
          <button class="icon-btn" data-act="edit-workout" data-id="${esc(w.id)}">${ICON_EDIT}</button></div>
        <p class="muted small">${ex.map(e => esc(e.name)).join(' · ') || 'Нет упражнений'}</p>
        <div class="row between">
          <span class="muted small">${last ? 'Последняя: ' + fmtDay(last) : 'Ещё не выполнялась'}${lastS && lastS.date === last ? ' · ' + fmtDuration(lastS.duration) : ''}</span>
          <button class="btn" data-act="start" data-id="${esc(w.id)}" ${ex.length && !ui.session ? '' : 'disabled'}>Начать</button>
        </div>
      </div>`;
    }).join('') : '<div class="card empty">Создай свои тренировки — например «День A», «День B», «День C».<br>В каждой укажи упражнения, подходы, повторы и рабочий вес.</div>'}
    <button class="btn secondary block" data-act="new-workout">+ Новая тренировка</button>`;
}

function viewEdit() {
  const e = ui.edit;
  return `
    <div class="card">
      <label>Название тренировки<input data-input="edit-name" value="${esc(e.name)}" placeholder="Например: День A — грудь, спина"></label>
    </div>
    ${e.exercises.map((x, i) => `<div class="card">
      <div class="row">
        <input class="grow" data-input="edit-ex" data-i="${i}" data-f="name" value="${esc(x.name)}" placeholder="Упражнение, например Жим лёжа">
        <button class="icon-btn" data-act="ex-up" data-i="${i}" ${i ? '' : 'disabled'}>↑</button>
        <button class="icon-btn" data-act="ex-del" data-i="${i}">✕</button>
      </div>
      <div class="row mt">
        <label class="grow">Подходы<input data-input="edit-ex" data-i="${i}" data-f="sets" inputmode="numeric" value="${esc(x.sets)}"></label>
        <label class="grow">Повторы<input data-input="edit-ex" data-i="${i}" data-f="reps" inputmode="numeric" value="${esc(x.reps)}"></label>
        <label class="grow">Вес, кг<input data-input="edit-ex" data-i="${i}" data-f="weight" inputmode="decimal" value="${esc(x.weight)}"></label>
      </div>
    </div>`).join('')}
    <button class="btn secondary block" data-act="ex-add">+ Упражнение</button>
    <div class="row mt">
      <button class="btn grow" data-act="save-workout">Сохранить</button>
      <button class="btn ghost" data-act="cancel-edit">Отмена</button>
    </div>
    ${e.isNew ? '' : '<button class="btn danger block mt" data-act="del-workout">Удалить тренировку</button>'}`;
}

function viewSession() {
  const s = ui.session;
  return `
    <div class="row between" style="margin-bottom:12px">
      <button class="btn ghost" data-act="close-session">← К списку</button>
      <span class="muted small">${esc(s.name)} · ${fmtDay(s.date)}</span>
    </div>
    <div class="card hero timer-card ${s.pausedAt ? 'paused' : ''}">
      <div class="row between">
        <div>
          <div class="muted small">${s.pausedAt ? 'Пауза' : 'Время тренировки'}</div>
          <div class="kcal-big" data-timer>${fmtTimer(elapsed(s))}</div>
        </div>
        <button class="btn" data-act="timer-toggle">${s.pausedAt ? 'Продолжить' : 'Пауза'}</button>
      </div>
    </div>
    ${s.ex.map((x, i) => {
      const last = lastSets(x.exerciseId);
      const sug = suggestion(x);
      return `<div class="card ex-card">
        <h3>${esc(x.name)}</h3>
        <div class="muted small">План: ${x.planSets}×${x.reps || '—'} · ${r1(num(x.weight))} кг</div>
        ${last ? `<div class="muted small">Прошлый раз (${fmtShort(last[0].date)}): ${last.map(l => `${r1(l.weight)}×${l.reps}`).join(', ')}</div>` : ''}
        ${sug ? `<div class="hint">В прошлый раз всё выполнено — попробуй ${sug} кг
          <button class="btn ghost small" data-act="apply-sug" data-i="${i}" data-w="${sug}">применить</button></div>` : ''}
        <div class="sets">
          <span class="hdr">#</span><span class="hdr">Повторы</span><span class="hdr">Вес, кг</span><span></span>
          ${x.sets.map((st, j) => `
            <span class="muted">${j + 1}</span>
            <input data-input="set" data-i="${i}" data-j="${j}" data-f="reps" inputmode="numeric" value="${esc(st.reps)}">
            <input data-input="set" data-i="${i}" data-j="${j}" data-f="weight" inputmode="decimal" value="${esc(st.weight)}">
            <button class="check ${st.done ? 'on' : ''}" data-act="set-done" data-i="${i}" data-j="${j}">✓</button>`).join('')}
        </div>
        <div class="row mt">
          <button class="btn ghost" data-act="set-add" data-i="${i}">+ подход</button>
          ${x.sets.length > 1 ? `<button class="btn ghost" data-act="set-del" data-i="${i}">− подход</button>` : ''}
        </div>
      </div>`;
    }).join('')}
    <button class="btn block" data-act="finish">Завершить тренировку</button>
    <button class="btn danger block mt" data-act="cancel-session">Отменить без сохранения</button>`;
}

// ----- Прогресс -----

function chart(points, unit) {
  if (points.length < 2) return '<p class="muted small">График появится, когда будет хотя бы 2 записи.</p>';
  const W = 320, H = 160, L = 38, R = 10, T = 10, B = 22;
  const xs = points.map(p => parseDate(p.x).getTime());
  const ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  if (maxY - minY < 1) { minY -= 0.5; maxY += 0.5; }
  const padY = (maxY - minY) * 0.1;
  minY -= padY; maxY += padY;
  const sx = x => L + ((x - minX) / (maxX - minX || 1)) * (W - L - R);
  const sy = y => T + ((maxY - y) / (maxY - minY)) * (H - T - B);
  const grid = [0, 0.5, 1].map(f => {
    const v = minY + (maxY - minY) * f;
    return `<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/>
      <text x="${L - 4}" y="${sy(v) + 4}" text-anchor="end">${r1(v)}</text>`;
  }).join('');
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${sx(xs[i]).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const dots = points.length <= 40 ? points.map((p, i) => `<circle class="dot" cx="${sx(xs[i])}" cy="${sy(p.y)}" r="3"/>`).join('') : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="График, ${unit}">
    ${grid}<path class="line" d="${path}"/>${dots}
    <text x="${L}" y="${H - 4}">${fmtShort(points[0].x)}</text>
    <text x="${W - R}" y="${H - 4}" text-anchor="end">${fmtShort(points[points.length - 1].x)}</text>
  </svg>`;
}

function exerciseOptions() {
  const opts = [];
  workoutsSorted().forEach(w => exercisesOf(w.id).forEach(e => opts.push({ id: e.id, label: `${w.name}: ${e.name}` })));
  // упражнения, которые удалили из плана, но в истории они остались
  db.Log.forEach(l => {
    if (!opts.some(o => o.id === l.exerciseId)) opts.push({ id: l.exerciseId, label: l.name + ' (архив)' });
  });
  return opts;
}

function sessionsCard() {
  const all = sessionsSorted();
  if (!all.length) {
    return '<div class="card"><h2>Время тренировок</h2><p class="muted small" style="margin:0">Появится после первой тренировки с таймером.</p></div>';
  }
  const week = all.filter(s => s.date >= addDays(today(), -6));
  const avg = all.reduce((sum, s) => sum + s.duration, 0) / all.length;
  return `<div class="card">
    <h2>Время тренировок</h2>
    <div class="stats">
      <div><b>${week.length}</b><span class="muted small">за 7 дней</span></div>
      <div><b>${fmtDuration(week.reduce((sum, s) => sum + s.duration, 0))}</b><span class="muted small">время за 7 дней</span></div>
      <div><b>${fmtDuration(avg)}</b><span class="muted small">в среднем</span></div>
    </div>
    <ul class="list mt">${all.slice(-5).reverse().map(s => `<li>
      <div class="info"><div>${fmtDay(s.date)}</div><div class="muted small">${esc(s.name)}</div></div>
      <b>${fmtDuration(s.duration)}</b></li>`).join('')}</ul>
  </div>`;
}

function viewProgress() {
  const ws = weights();
  const avg = avgWeight();
  const last = ws[ws.length - 1];
  let change = '';
  if (last) {
    const monthAgo = ws.filter(w => w.date <= addDays(last.date, -30)).pop() || ws[0];
    const d = r1(avg - monthAgo.weight);
    change = (d > 0 ? '+' : '') + d;
  }

  const opts = exerciseOptions();
  if (!opts.some(o => o.id === ui.progressEx)) {
    const withLogs = opts.find(o => db.Log.some(l => l.exerciseId === o.id));
    ui.progressEx = withLogs ? withLogs.id : (opts[0] ? opts[0].id : '');
  }
  const byDate = {};
  db.Log.filter(l => l.exerciseId === ui.progressEx).forEach(l => { (byDate[l.date] = byDate[l.date] || []).push(l); });
  const dates = Object.keys(byDate).sort();
  const strength = dates.map(d => ({ x: d, y: Math.max(...byDate[d].map(l => l.weight)) }));

  return `
    <div class="card">
      <h2>Вес тела</h2>
      <div class="row">
        <input id="w-date" type="date" value="${today()}" max="${today()}" style="flex:1.3">
        <input id="w-input" inputmode="decimal" placeholder="кг" style="flex:1">
        <button class="btn" data-act="save-weight" data-src="w-input" data-date="w-date">OK</button>
      </div>
      ${ws.length ? `<div class="stats mt">
        <div><b>${avg}</b><span class="muted small">среднее 7 дн.</span></div>
        <div><b>${change}</b><span class="muted small">за 30 дней</span></div>
        <div><b>${ws.length}</b><span class="muted small">записей</span></div>
      </div>` : ''}
      <div class="mt">${chart(ws.filter(w => w.date >= addDays(today(), -120)).map(w => ({ x: w.date, y: w.weight })), 'кг')}</div>
      ${ws.length ? `<ul class="list mt">${ws.slice(-7).reverse().map(w => `<li>
        <div class="info">${fmtDay(w.date)}</div><b>${r1(w.weight)} кг</b>
        <button class="icon-btn" data-act="del-weight" data-id="${esc(w.id)}">✕</button></li>`).join('')}</ul>` : ''}
    </div>
    ${sessionsCard()}
    <div class="card">
      <h2>Силовые</h2>
      ${opts.length ? `
        <select id="prog-ex">${opts.map(o => `<option value="${esc(o.id)}" ${o.id === ui.progressEx ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
        <p class="muted small">Максимальный рабочий вес на каждой тренировке</p>
        ${chart(strength, 'кг')}
        ${dates.length ? `<ul class="list mt">${dates.slice(-6).reverse().map(d => `<li><div class="info">
          <div>${fmtDay(d)}</div><div class="muted small">${byDate[d].sort((a, b) => a.set - b.set).map(l => `${r1(l.weight)}×${l.reps}`).join(', ')}</div>
          </div></li>`).join('')}</ul>` : '<p class="muted small">Ещё нет выполненных тренировок с этим упражнением.</p>'}`
      : '<p class="muted small">Сначала создай тренировки на вкладке «Тренировки».</p>'}
    </div>`;
}

// ----- Профиль -----

function targetStats(t) {
  const perKg = g => `<br><span class="muted small">${r1(g / t.weight)} г/кг</span>`;
  return `<div class="kcal-big">${t.kcal} <span class="muted small">ккал в день</span></div>
    <div class="stats mt">
      <div><b style="color:var(--p)">${t.protein} г</b><span class="muted small">белки</span>${perKg(t.protein)}</div>
      <div><b style="color:var(--f)">${t.fat} г</b><span class="muted small">жиры</span>${perKg(t.fat)}</div>
      <div><b style="color:var(--c)">${t.carbs} г</b><span class="muted small">углеводы</span>${perKg(t.carbs)}</div>
    </div>`;
}

function targetsHtml() {
  const mode = setting('mode', 'auto');
  const t = targets();
  const w = avgWeight();
  const modeSelect = `<label>Как считать<select data-setting="mode">${opt([['auto', 'Автоматически по формуле'], ['custom', 'Свои пропорции']], mode)}</select></label>`;
  const noWeight = '<p class="muted small" style="margin:0">Сначала внеси хотя бы одно взвешивание (вкладка «Прогресс» или баннер на «Питании»).</p>';

  if (mode === 'custom') {
    if (!w) return modeSelect + noWeight;
    // для курса без своей нормы подставляем прежнюю норму (если была) или расчёт по формуле
    const anyCourseSaved = GOALS.some(g => setting(`proteinPerKg_${g[0]}`));
    const legacy = !anyCourseSaved && num(setting('proteinPerKg')) && {
      protein: Math.round(w * num(setting('proteinPerKg'))), fat: Math.round(w * num(setting('fatPerKg'))), carbs: Math.round(w * num(setting('carbsPerKg'))),
    };
    const prefill = t || legacy || autoTargets(course());
    return `${modeSelect}
      <p class="muted small" style="margin:0 0 8px">${t
        ? `Норма для курса «${courseInfo(course())[1]}».`
        : `<b>Для курса «${courseInfo(course())[1]}» норма ещё не задана.</b>
           ${legacy ? 'Ниже — твоя прежняя норма, поправь при необходимости и сохрани.' : prefill ? 'Ниже — расчёт по формуле, поправь под себя и сохрани.' : ''}`}
      Впиши граммы при весе ${w} кг — приложение запомнит их на 1 кг веса и само пересчитает норму, когда вес изменится.</p>
      <div class="row">
        <label class="grow">Белки, г<input id="cu-p" inputmode="decimal" value="${prefill ? prefill.protein : ''}"></label>
        <label class="grow">Жиры, г<input id="cu-f" inputmode="decimal" value="${prefill ? prefill.fat : ''}"></label>
        <label class="grow">Углев., г<input id="cu-c" inputmode="decimal" value="${prefill ? prefill.carbs : ''}"></label>
      </div>
      <button class="btn block" data-act="save-custom">Сохранить</button>
      ${t ? `<div class="mt">${targetStats(t)}</div>
        <p class="muted small">Считается от веса ${t.weight} кг (среднее за 7 дней).</p>` : ''}`;
  }

  if (!t) return modeSelect + (w ? '<p class="muted small" style="margin:0">Заполни рост и дату рождения выше.</p>' : noWeight);
  return `${modeSelect}${targetStats(t)}
    <p class="muted small">Вес ${t.weight} кг (среднее за 7 дней), возраст ${t.age}. Обмен в покое ≈ ${t.bmr} ккал,
    с учётом активности ≈ ${t.tdee} ккал, курс: ${t.goal[1].toLowerCase()}
    (${t.goal[2] === 1 ? 'без поправки' : (t.goal[2] > 1 ? '+' : '−') + Math.round(Math.abs(t.goal[2] - 1) * 100) + '% ккал'}).<br>
    Норма пересчитывается сама, когда меняется твой вес или возраст.</p>`;
}

function opt(list, current) {
  return list.map(o => `<option value="${o[0]}" ${o[0] === current ? 'selected' : ''}>${o[1]}</option>`).join('');
}

function productItem(p) {
  if (ui.editProduct === p.id) {
    return `<li style="display:block">
      <input id="pe-name" value="${esc(p.name)}">
      <div class="row mt">
        <label class="grow">Б<input id="pe-p" inputmode="decimal" value="${r1(p.protein)}"></label>
        <label class="grow">Ж<input id="pe-f" inputmode="decimal" value="${r1(p.fat)}"></label>
        <label class="grow">У<input id="pe-c" inputmode="decimal" value="${r1(p.carbs)}"></label>
        <label class="grow">Ккал<input id="pe-k" inputmode="decimal" value="${Math.round(p.kcal)}"></label>
      </div>
      <div class="row"><button class="btn grow" data-act="save-product" data-id="${esc(p.id)}">Сохранить</button>
      <button class="btn ghost" data-act="cancel-product">Отмена</button>
      <button class="btn danger" data-act="del-product" data-id="${esc(p.id)}">Удалить</button></div>
    </li>`;
  }
  return `<li><div class="info"><div class="name">${esc(p.name)}</div><div class="muted small">на 100 г: ${macrosLine(p)}</div></div>
    <button class="icon-btn" data-act="edit-product" data-id="${esc(p.id)}">${ICON_EDIT}</button></li>`;
}

function courseHtml() {
  const c = course();
  const p = courseProgress();
  const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
  let progress = '<p class="muted small" style="margin:0">Укажи дату начала, чтобы видеть темп изменения веса.</p>';
  if (p) {
    progress = `<div class="stats">
        ${p.weeks
          ? `<div><b>${p.weeks}</b><span class="muted small">${p.weeks === 1 ? 'неделя' : p.weeks <= 4 ? 'недели' : 'недель'}</span></div>`
          : `<div><b>${p.days}</b><span class="muted small">дн. курса</span></div>`}
        <div><b>${signed(p.change)}</b><span class="muted small">кг с начала</span></div>
        <div><b>${p.rate == null ? '—' : signed(p.rate)}</b><span class="muted small">кг в неделю</span></div>
      </div>`;
    if (p.rate == null) {
      progress += '<p class="muted small" style="margin:10px 0 0">Темп появится через 2 недели курса.</p>';
    } else {
      const range = `рекомендуемо ${signed(p.range[0])}…${signed(p.range[1])} кг/нед`;
      const advice = {
        ok: 'Темп в норме',
        low: c === 'cut' ? 'Вес уходит быстрее рекомендуемого — можно добавить 150–200 ккал' : 'Темп ниже рекомендуемого — можно добавить 150–200 ккал',
        high: c === 'cut' ? 'Вес уходит медленнее рекомендуемого — можно убрать 150–200 ккал' : 'Темп выше рекомендуемого — можно убрать 150–200 ккал',
      }[p.verdict];
      progress += `<p class="hint" style="margin:10px 0 0">${advice} (${range}).</p>`;
    }
  }
  return `<div class="segmented">${GOALS.map(g =>
      `<button class="${g[0] === c ? 'on' : ''}" data-act="set-course" data-c="${g[0]}">${g[1]}</button>`).join('')}</div>
    <label class="mt">Начало курса<input type="date" data-setting="courseStart" value="${esc(setting('courseStart'))}" max="${today()}"></label>
    ${progress}`;
}

function viewProfile() {
  const products = db.Products.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return `
    <div class="card">
      <h2>Текущий курс</h2>
      <div id="course">${courseHtml()}</div>
    </div>
    <div class="card">
      <h2>Мои данные</h2>
      <div class="row">
        <label class="grow">Пол<select data-setting="sex">${opt([['male', 'Мужской'], ['female', 'Женский']], setting('sex', 'male'))}</select></label>
        <label class="grow">Рост, см<input data-setting="height" inputmode="numeric" value="${esc(setting('height'))}"></label>
      </div>
      <label>Дата рождения<input type="date" data-setting="birthDate" value="${esc(setting('birthDate'))}"></label>
      <label>Активность<select data-setting="activity">${opt(ACTIVITY, setting('activity', '1.375'))}</select></label>
    </div>
    <div class="card">
      <h2>Дневная норма</h2>
      <div id="targets">${targetsHtml()}</div>
    </div>
    <div class="card">
      <h2>Напоминание о взвешивании</h2>
      <label>Дни взвешивания</label>
      <div class="chips" style="margin:0 0 12px">${WEEKDAYS.map(([d, name]) =>
        `<button class="chip ${weighDays().includes(d) ? 'on' : ''}" data-act="weigh-day" data-d="${d}">${name}</button>`).join('')}</div>
      <label>Письмо на почту утром, если вес ещё не внесён
        <select data-setting="reminder">${opt([['on', 'Включено'], ['off', 'Выключено']], setting('reminder', 'on'))}</select></label>
      <p class="muted small" style="margin:0">Письмо отправляет Google с твоего же адреса. Работает после подключения таблицы. Баннер в приложении появляется в те же дни.</p>
    </div>
    <div class="card">
      <h2>Мои продукты (${products.length})</h2>
      ${products.length ? `<ul class="list">${products.map(productItem).join('')}</ul>` : '<p class="muted small">Пока нет — они появятся, когда будешь добавлять еду.</p>'}
    </div>
    <div class="card">
      <h2>Google Таблица</h2>
      <p class="muted small">${conn.url ? '✓ Подключено. Данные сохраняются в таблицу.' : 'Не подключено: данные хранятся только на этом устройстве.'}</p>
      <label>Адрес веб-приложения<input id="c-url" value="${esc(conn.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off"></label>
      <label>Ключ доступа<input id="c-token" value="${esc(conn.token)}" autocomplete="off"></label>
      <button class="btn block" data-act="connect">${conn.url ? 'Переподключить' : 'Подключить'}</button>
      ${conn.url ? '<button class="btn ghost block mt" data-act="disconnect">Отключить на этом устройстве</button>' : ''}
    </div>`;
}

// ---------- Действия ----------

function saveWeight(el) {
  const input = $('#' + el.dataset.src);
  const w = num(input.value);
  if (w < 20 || w > 400) return toast('Введи вес в килограммах');
  const date = el.dataset.date ? $('#' + el.dataset.date).value || today() : today();
  upsert('Weight', { id: date, date, weight: r1(w) });
  toast('Вес сохранён');
  render();
}

function pickProduct(p) {
  const last = db.Meals.filter(m => m.productId === p.id).pop();
  ui.pick = Object.assign({}, p, { grams: last ? last.grams : 100 });
  ui.foodQuery = p.name;
  render();
  const g = $('#grams');
  g.focus();
  g.select();
}

async function connect() {
  const url = $('#c-url').value.trim();
  const token = $('#c-token').value.trim();
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) return toast('Адрес должен начинаться с https://script.google.com и заканчиваться на /exec');
  if (!token) return toast('Вставь ключ доступа');
  const prev = conn;
  conn = { url, token };
  try {
    await api({ action: 'ping' });
  } catch (e) {
    conn = prev;
    return toast('Не получилось: ' + e.message);
  }
  store.set('ft.conn', conn);
  if (!prev.url && SHEETS.some(s => db[s].length) && confirm('Перенести данные, которые уже есть на этом устройстве, в таблицу?')) {
    // Sessions откладываем: если скрипт ещё старый, этот лист в нём не найдётся
    SHEETS.forEach(s => { if (db[s].length) (s === 'Sessions' ? deferred : queue).push({ action: 'upsert', sheet: s, rows: db[s] }); });
    persist();
  }
  setSetting('appUrl', location.origin + location.pathname);
  await pull();
  toast('Таблица подключена ✓');
  render();
}

const actions = {
  sync: () => pull(),

  // питание
  day: el => { ui.date = addDays(ui.date, Number(el.dataset.d)); render(); },
  'save-weight': saveWeight,
  'del-weight': el => { if (confirm('Удалить запись веса?')) { remove('Weight', el.dataset.id); render(); } },
  pick: el => pickProduct(db.Products.find(p => p.id === el.dataset.id)),
  'pick-new': () => {
    ui.pick = { isNew: true, name: ui.foodQuery.trim(), grams: 100 };
    render();
    $('#np').focus();
  },
  'cancel-pick': () => { ui.pick = null; ui.foodQuery = ''; render(); },
  'add-meal': () => {
    const grams = num($('#grams').value);
    if (!grams) return toast('Укажи количество грамм');
    let product = ui.pick;
    if (product.isNew) {
      const per = pickPer100();
      if (!per.kcal) return toast('Заполни БЖУ на 100 г');
      product = Object.assign({ id: uid(), name: ui.pick.name }, per);
      upsert('Products', product);
    }
    const k = grams / 100;
    upsert('Meals', {
      id: uid(), date: ui.date, productId: product.id, name: product.name, grams,
      protein: r1(product.protein * k), fat: r1(product.fat * k), carbs: r1(product.carbs * k), kcal: Math.round(product.kcal * k),
    });
    ui.pick = null;
    ui.foodQuery = '';
    render();
  },
  'del-meal': el => { remove('Meals', el.dataset.id); render(); },

  // список тренировок и редактор
  'new-workout': () => {
    ui.edit = { id: uid(), isNew: true, name: '', exercises: [{ id: uid(), name: '', sets: '3', reps: '10', weight: '' }] };
    render();
    scrollTop();
  },
  'edit-workout': el => {
    const w = db.Workouts.find(x => x.id === el.dataset.id);
    ui.edit = {
      id: w.id, name: w.name,
      exercises: exercisesOf(w.id).map(e => ({ id: e.id, name: e.name, sets: String(e.sets), reps: String(e.reps), weight: String(e.weight) })),
    };
    render();
    scrollTop();
  },
  'ex-add': () => {
    const prev = ui.edit.exercises[ui.edit.exercises.length - 1];
    ui.edit.exercises.push({ id: uid(), name: '', sets: prev ? prev.sets : '3', reps: prev ? prev.reps : '10', weight: '' });
    render();
  },
  'ex-del': el => { ui.edit.exercises.splice(Number(el.dataset.i), 1); render(); },
  'ex-up': el => {
    const i = Number(el.dataset.i);
    const ex = ui.edit.exercises;
    [ex[i - 1], ex[i]] = [ex[i], ex[i - 1]];
    render();
  },
  'cancel-edit': () => { ui.edit = null; render(); },
  'save-workout': () => {
    const e = ui.edit;
    if (!e.name.trim()) return toast('Назови тренировку');
    const exercises = e.exercises.filter(x => x.name.trim());
    if (!exercises.length) return toast('Добавь хотя бы одно упражнение');
    const existing = db.Workouts.find(w => w.id === e.id);
    upsert('Workouts', { id: e.id, name: e.name.trim(), order: existing ? existing.order : db.Workouts.length });
    upsert('Exercises', exercises.map((x, i) => ({
      id: x.id, workoutId: e.id, name: x.name.trim(), sets: Math.max(1, Math.round(num(x.sets))), reps: Math.round(num(x.reps)), weight: r1(num(x.weight)), order: i,
    })));
    const keep = exercises.map(x => x.id);
    const removed = db.Exercises.filter(x => x.workoutId === e.id && !keep.includes(x.id)).map(x => x.id);
    if (removed.length) remove('Exercises', removed);
    ui.edit = null;
    toast('Тренировка сохранена');
    render();
  },
  'del-workout': () => {
    if (!confirm('Удалить тренировку? История выполненных подходов останется.')) return;
    remove('Exercises', exercisesOf(ui.edit.id).map(x => x.id));
    remove('Workouts', ui.edit.id);
    ui.edit = null;
    render();
  },

  // идущая тренировка
  start: el => {
    const w = db.Workouts.find(x => x.id === el.dataset.id);
    ui.session = {
      workoutId: w.id, name: w.name, date: today(),
      startedAt: Date.now(), pausedAt: null, pausedMs: 0,
      ex: exercisesOf(w.id).map(e => ({
        exerciseId: e.id, name: e.name, reps: e.reps, weight: e.weight, planSets: e.sets,
        sets: Array.from({ length: e.sets || 1 }, () => ({ reps: String(e.reps || ''), weight: String(e.weight || ''), done: false })),
      })),
    };
    ui.sessionOpen = true;
    saveSession();
    render();
    scrollTop();
  },
  'open-session': () => { ui.sessionOpen = true; render(); },
  'timer-toggle': () => {
    const s = ui.session;
    if (s.pausedAt) {
      s.pausedMs = (s.pausedMs || 0) + Date.now() - s.pausedAt;
      s.pausedAt = null;
    } else {
      s.pausedAt = Date.now();
    }
    saveSession();
    render();
  },
  'close-session': () => { ui.sessionOpen = false; render(); },
  'set-done': el => {
    const st = ui.session.ex[el.dataset.i].sets[el.dataset.j];
    st.done = !st.done;
    saveSession();
    el.classList.toggle('on', st.done);
  },
  'set-add': el => {
    const sets = ui.session.ex[el.dataset.i].sets;
    const last = sets[sets.length - 1];
    sets.push({ reps: last.reps, weight: last.weight, done: false });
    saveSession();
    render();
  },
  'set-del': el => { ui.session.ex[el.dataset.i].sets.pop(); saveSession(); render(); },
  'apply-sug': el => {
    ui.session.ex[el.dataset.i].sets.forEach(st => { if (!st.done) st.weight = el.dataset.w; });
    saveSession();
    render();
  },
  'cancel-session': () => {
    if (!confirm('Отменить тренировку? Отмеченные подходы не сохранятся.')) return;
    ui.session = null;
    ui.sessionOpen = false;
    saveSession();
    render();
  },
  finish: () => {
    const s = ui.session;
    const rows = [];
    s.ex.forEach(x => x.sets.forEach((st, j) => {
      if (st.done) rows.push({ id: uid(), date: s.date, workoutId: s.workoutId, exerciseId: x.exerciseId, name: x.name, set: j + 1, reps: Math.round(num(st.reps)), weight: r1(num(st.weight)) });
    }));
    if (!rows.length) {
      if (!confirm('Ни один подход не отмечен галочкой. Закрыть тренировку без сохранения?')) return;
    } else {
      upsert('Log', rows);
      // рабочий вес в плане = максимальный вес, с которым сделал подходы сегодня
      const changed = [];
      s.ex.forEach(x => {
        const done = x.sets.filter(st => st.done);
        const e = db.Exercises.find(ex => ex.id === x.exerciseId);
        if (!done.length || !e) return;
        const maxW = r1(Math.max(...done.map(st => num(st.weight))));
        if (maxW !== e.weight) changed.push(Object.assign({}, e, { weight: maxW }));
      });
      if (changed.length) upsert('Exercises', changed);
      const ms = elapsed(s);
      upsert('Sessions', { id: uid(), date: s.date, workoutId: s.workoutId, name: s.name, duration: Math.round(ms / 1000), startedAt: s.startedAt });
      toast(`Тренировка сохранена, время ${fmtTimer(ms)}. ${changed.length ? 'Веса в плане обновлены.' : ''}`);
    }
    ui.session = null;
    ui.sessionOpen = false;
    saveSession();
    render();
    scrollTop();
  },

  'weigh-day': el => {
    const d = Number(el.dataset.d);
    const days = weighDays();
    const next = days.includes(d) ? days.filter(x => x !== d) : days.concat(d);
    setSetting('weighDays', next.length ? next.join(',') : 'none'); // пустое значение = «по умолчанию»
    el.classList.toggle('on', next.includes(d));
  },
  'save-custom': () => {
    const w = avgWeight();
    const p = num($('#cu-p').value), f = num($('#cu-f').value), c = num($('#cu-c').value);
    if (!p || !f || !c) return toast('Заполни белки, жиры и углеводы');
    const cur = course();
    setSetting(`proteinPerKg_${cur}`, (p / w).toFixed(3));
    setSetting(`fatPerKg_${cur}`, (f / w).toFixed(3));
    setSetting(`carbsPerKg_${cur}`, (c / w).toFixed(3));
    $('#targets').innerHTML = targetsHtml();
    toast(`Норма для курса «${courseInfo(cur)[1]}» сохранена`);
  },
  'set-course': el => {
    const next = el.dataset.c, prev = course();
    if (next === prev) return;
    if (!confirm(`Начать курс «${courseInfo(next)[1]}» с сегодняшнего дня?`)) return;
    // старая норма без курса относилась к текущему курсу — закрепляем её за ним
    if (MACRO_KEYS.every(k => !GOALS.some(g => setting(`${k}_${g[0]}`))) && setting('proteinPerKg')) {
      MACRO_KEYS.forEach(k => setSetting(`${k}_${prev}`, setting(k)));
    }
    setSetting('goal', next);
    setSetting('courseStart', today());
    render();
    toast(`Курс «${courseInfo(next)[1]}» начат`);
  },

  // продукты и подключение
  'edit-product': el => { ui.editProduct = el.dataset.id; render(); },
  'cancel-product': () => { ui.editProduct = null; render(); },
  'save-product': el => {
    const p = db.Products.find(x => x.id === el.dataset.id);
    const name = $('#pe-name').value.trim();
    if (!name) return toast('Введи название');
    upsert('Products', Object.assign({}, p, {
      name, protein: num($('#pe-p').value), fat: num($('#pe-f').value), carbs: num($('#pe-c').value), kcal: num($('#pe-k').value),
    }));
    ui.editProduct = null;
    render();
  },
  'del-product': el => {
    if (!confirm('Удалить продукт из списка? Уже записанная еда останется.')) return;
    remove('Products', el.dataset.id);
    ui.editProduct = null;
    render();
  },
  connect,
  disconnect: () => {
    if (!confirm('Отключить таблицу на этом устройстве? Данные в таблице останутся.')) return;
    conn = { url: '', token: '' };
    queue = [];
    deferred = [];
    serverSheets = null;
    store.set('ft.serverSheets', null);
    store.set('ft.conn', conn);
    persist();
    setSync('local');
    render();
  },
};

// Поля ввода, которые не перерисовывают весь экран (иначе на телефоне пропадает клавиатура)
const inputs = {
  'food-q': el => {
    ui.foodQuery = el.value;
    ui.pick = null;
    updateFoodSearch();
  },
  pick: () => { $('#preview').innerHTML = previewText(); },
  'edit-name': el => { ui.edit.name = el.value; },
  'edit-ex': el => { ui.edit.exercises[el.dataset.i][el.dataset.f] = el.value; },
  set: el => {
    ui.session.ex[el.dataset.i].sets[el.dataset.j][el.dataset.f] = el.value;
    saveSession();
  },
};

// ---------- Запуск ----------

document.addEventListener('click', e => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    ui.tab = tab.dataset.tab;
    ui.editProduct = null;
    render();
    scrollTop();
    return;
  }
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled && actions[el.dataset.act]) actions[el.dataset.act](el, e);
});

document.addEventListener('input', e => {
  const fn = inputs[e.target.dataset.input];
  if (fn) fn(e.target);
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.setting) {
    setSetting(el.dataset.setting, el.value);
    $('#targets').innerHTML = targetsHtml();
    if (el.dataset.setting === 'courseStart') $('#course').innerHTML = courseHtml();
  } else if (el.id === 'prog-ex') {
    ui.progressEx = el.value;
    render();
  }
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'grams' || ['np', 'nf', 'nc', 'nk'].includes(e.target.id)) actions['add-meal']();
  if (e.target.id === 'w-today' || e.target.id === 'w-input') e.target.parentElement.querySelector('[data-act="save-weight"]').click();
});

// Вернулся в приложение — подтягиваем свежие данные; если наступил новый день — показываем его
let lastToday = today();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (lastToday !== today()) {
    if (ui.date === lastToday) ui.date = today();
    lastToday = today();
    render();
  }
  pull();
});

// iPhone «с экрана Домой»: если страница не длиннее окна, iOS даёт окно на высоту
// строки состояния короче экрана и обрезает всё ниже — панель вкладок висит над краем.
// Когда документ длиннее окна, iOS отдаёт весь экран. Поэтому делаем документ всегда
// на 1px выше экрана (постоянно, чтобы высота не менялась и ничего не прыгало).
function fitScreen() {
  const full = navigator.standalone && innerHeight > innerWidth;
  document.documentElement.style.minHeight = full ? screen.height + 1 + 'px' : '';
  document.body.style.height = full ? screen.height + 'px' : '';
}
addEventListener('resize', fitScreen);
addEventListener('orientationchange', () => setTimeout(fitScreen, 300));
fitScreen();

$('#sync').dataset.act = 'sync';
render();
setSync(conn.url ? (queue.length ? 'saving' : 'ok') : 'local');
pull();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
