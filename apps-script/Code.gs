/**
 * Fit Tracker — серверная часть.
 * Хранит данные в листах этой Google Таблицы и отдаёт их приложению по API.
 *
 * Первая настройка: выбери функцию setup в списке сверху и нажми «Выполнить».
 */

// Листы таблицы и их колонки
const SHEETS = {
  Settings:  ['id', 'value'],
  Products:  ['id', 'name', 'protein', 'fat', 'carbs', 'kcal'],
  Meals:     ['id', 'date', 'productId', 'name', 'grams', 'protein', 'fat', 'carbs', 'kcal'],
  Workouts:  ['id', 'name', 'order'],
  Exercises: ['id', 'workoutId', 'name', 'sets', 'reps', 'weight', 'order'],
  Log:       ['id', 'date', 'workoutId', 'exerciseId', 'name', 'set', 'reps', 'weight'],
  Weight:    ['id', 'date', 'weight'],
  Sessions:  ['id', 'date', 'workoutId', 'name', 'duration', 'startedAt'], // duration — секунды
};

// Колонки, которые храним как текст, чтобы таблица не превращала их в даты/числа
const TEXT_COLUMNS = ['id', 'date', 'productId', 'workoutId', 'exerciseId', 'name', 'value'];

const REMINDER_HOUR = 9; // во сколько присылать напоминание о взвешивании

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(name => {
    const cols = SHEETS[name];
    const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    sheet.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    cols.forEach((col, i) => {
      if (TEXT_COLUMNS.includes(col)) sheet.getRange(1, i + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
    });
  });
  const blank = ss.getSheetByName('Лист1') || ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailyReminder')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyReminder').timeBased().everyDays(1).atHour(REMINDER_HOUR).create();

  Logger.log('Готово! Твой ключ доступа (вставь его в приложении): ' + props.getProperty('TOKEN'));
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    if (!req.token || req.token !== PropertiesService.getScriptProperties().getProperty('TOKEN')) {
      throw new Error('Неверный ключ доступа');
    }
    out = { ok: true, data: handle(req) };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput('Fit Tracker API работает.');
}

function handle(req) {
  switch (req.action) {
    case 'ping':   return 'pong';
    case 'all':    return readAll();
    case 'upsert': return withLock(() => upsert(req.sheet, req.rows));
    case 'remove': return withLock(() => remove(req.sheet, req.ids));
    default: throw new Error('Неизвестное действие: ' + req.action);
  }
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function getSheet(name) {
  if (!SHEETS[name]) throw new Error('Неизвестный лист: ' + name);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Нет листа ' + name + ' — запусти setup()');
  return sheet;
}

function readSheet(name) {
  const sheet = getSheet(name);
  const cols = SHEETS[name];
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const tz = Session.getScriptTimeZone();
  return sheet.getRange(2, 1, last - 1, cols.length).getValues()
    .filter(r => r[0] !== '')
    .map(r => {
      const obj = {};
      cols.forEach((c, i) => {
        const v = r[i];
        obj[c] = v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : v;
      });
      return obj;
    });
}

function readAll() {
  const data = {};
  Object.keys(SHEETS).forEach(name => { data[name] = readSheet(name); });
  return data;
}

function upsert(name, rows) {
  const sheet = getSheet(name);
  const cols = SHEETS[name];
  const last = sheet.getLastRow();
  const ids = last < 2 ? [] : sheet.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0]));
  const toAppend = [];
  (rows || []).forEach(row => {
    const values = cols.map(c => row[c] === undefined || row[c] === null ? '' : row[c]);
    const idx = ids.indexOf(String(row.id));
    if (idx >= 0) sheet.getRange(idx + 2, 1, 1, cols.length).setValues([values]);
    else toAppend.push(values);
  });
  if (toAppend.length) sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, cols.length).setValues(toAppend);
  return true;
}

function remove(name, ids) {
  const sheet = getSheet(name);
  const last = sheet.getLastRow();
  if (last < 2) return true;
  const wanted = (ids || []).map(String);
  const col = sheet.getRange(2, 1, last - 1, 1).getValues();
  // удаляем снизу вверх, чтобы номера строк не съезжали
  for (let i = col.length - 1; i >= 0; i--) {
    if (wanted.includes(String(col[i][0]))) sheet.deleteRow(i + 2);
  }
  return true;
}

const DEFAULT_WEIGH_DAYS = '2,5,0'; // вторник, пятница, воскресенье (0 — воскресенье)

// Запускается каждый день: если сегодня день взвешивания и нет записи веса — присылает письмо
function dailyReminder() {
  const settings = {};
  readSheet('Settings').forEach(r => { settings[r.id] = r.value; });
  if (settings.reminder === 'off') return;

  const tz = Session.getScriptTimeZone();
  const weekday = Number(Utilities.formatDate(new Date(), tz, 'u')) % 7; // 'u': 1 — пн … 7 — вс
  const days = String(settings.weighDays || DEFAULT_WEIGH_DAYS).split(',').map(Number);
  if (!days.includes(weekday)) return;

  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  if (readSheet('Weight').some(r => r.date === today)) return;

  const link = settings.appUrl ? '\n\nОткрыть приложение: ' + settings.appUrl : '';
  MailApp.sendEmail(
    Session.getEffectiveUser().getEmail(),
    '⚖️ Пора взвеситься',
    'Сегодня ещё нет записи веса. Взвесься натощак и внеси результат в Fit Tracker.' + link
  );
}
