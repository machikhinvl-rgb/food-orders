/**
 * ============================================================
 *  ЗАКАЗ ЕДЫ — Backend (Google Apps Script)
 *  Прототип для Офиса 1 (Кузьмина/Пифагор — тестовая копия)
 * ============================================================
 *
 *  КУДА ВСТАВЛЯТЬ:
 *  Открыть тестовую офисную таблицу → Расширения → Apps Script
 *  → удалить содержимое стандартного Code.gs → вставить этот файл целиком.
 *
 *  ЧТО НУЖНО ПОМЕНЯТЬ ПЕРЕД ЗАПУСКОМ:
 *  1) MENU_SPREADSHEET_ID — ниже, ID тестовой копии "Тех меню"
 *  2) После первого сохранения — Deploy → New deployment → Web app
 *     Execute as: Me / Who has access: Anyone with the link
 *     Скопировать полученный URL — он нужен в script.js на сайте.
 * ============================================================
 */

// ---------- НАСТРОЙКИ ----------

// ID тестовой таблицы "Тех меню" (из ссылки .../d/ЭТОТ_ID/edit...)
const MENU_SPREADSHEET_ID = '1rRpk5e6Rfqpg7Rjt4QoWGyWxwPEYv7DDieOUwkPw-jg';

const FIRST_DATA_ROW   = 2; // первая строка с сотрудником в листе "четная"/"нечетная"
const ROWS_PER_EMPLOYEE = 8; // строк в блоке одного сотрудника
const FIRST_DAY_COL    = 4; // столбец D = дата дня 1 (понедельник недели)
const DAY_BLOCK_WIDTH  = 4; // Дата | Блюдо | Кол-во | Цена

// Смещения строк внутри блока сотрудника (0 = первая строка блока = строка с кабинетом/ФИО)
const SLOT = {
  SALAD:  0, // 75₽  — салат / легкий завтрак / мелкая выпечка
  SOUP:   1, // 105₽ — плотный завтрак / суп
  HOT:    2, // 235 или 310₽ — горячее
  SIDE:   3, // 75₽  — гарнир
  PASTRY: 4, // 30₽  — выпечка / десерт
  FREE1:  5, // любое блюдо из полного меню
  FREE2:  6  // любое блюдо из полного меню
};
const MAX_QTY_PER_SLOT = 3;

const DAY_NAMES = ['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];

// ---------- ВХОДНЫЕ ТОЧКИ ----------

function doGet(e) {
  const action = (e.parameter && e.parameter.action) || '';
  try {
    let result;
    switch (action) {
      case 'bootstrap':      result = getBootstrap(); break;       // кабинеты + сотрудники + меню за 1 вызов
      case 'employeeOrders': result = getOrders(e.parameter.cabinet, e.parameter.employee); break;
      case 'cabinets':       result = getCabinets(); break;        // оставлено для обратной совместимости
      case 'employees':      result = getEmployees(e.parameter.cabinet); break;
      case 'menu':           result = getMenu(e.parameter.week); break;
      case 'orders':         result = getOrders(e.parameter.cabinet, e.parameter.employee); break;
      default:                result = { error: 'unknown action: ' + action };
    }
    return jsonOut_(result);
  } catch (err) {
    return jsonOut_({ error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    // Новый способ: весь пакет дней за один вызов (быстро).
    if (body.days) return jsonOut_(saveWeekOrders(body));
    // Старый способ: один день за вызов (оставлено для совместимости).
    return jsonOut_(saveOrder(body));
  } catch (err) {
    return jsonOut_({ error: String(err) });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
}

// ---------- НЕДЕЛЯ (чётная/нечётная) ----------

function weekParity_(date) {
  const week = Utilities.formatDate(date, Session.getScriptTimeZone(), 'w');
  return (parseInt(week, 10) % 2 === 0) ? 'even' : 'odd';
}

function getOrderSheet_(dateForParity) {
  const parity = weekParity_(dateForParity || new Date());
  const name = parity === 'even' ? 'четная' : 'нечетная';
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Не найден лист "' + name + '" в этой таблице');
  return sheet;
}

// ---------- КАБИНЕТЫ / СОТРУДНИКИ ----------

function getCabinets() {
  const sheet = getOrderSheet_();
  const lastRow = sheet.getLastRow();
  const values = sheet.getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, 1).getValues();
  const seen = {};
  const cabinets = [];
  values.forEach(function (r) {
    const v = r[0];
    if (v && !seen[v]) { seen[v] = true; cabinets.push(v); }
  });
  return { cabinets: cabinets };
}

// Один вызов вместо трёх (cabinets + employees + menu) — сильно ускоряет
// первую загрузку сайта. Возвращает сразу ВЕСЬ маппинг кабинет→сотрудники,
// поэтому переключение кабинета на сайте происходит без обращения к серверу.
function getBootstrap() {
  const sheet = getOrderSheet_();
  const lastRow = sheet.getLastRow();
  const values = sheet.getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, 2).getValues();

  const cabinets = [];
  const seen = {};
  const employeesByCabinet = {};

  for (let i = 0; i < values.length; i += ROWS_PER_EMPLOYEE) {
    const cab = values[i][0];
    const name = values[i][1];
    if (!cab) continue;
    if (!seen[cab]) { seen[cab] = true; cabinets.push(cab); employeesByCabinet[cab] = []; }
    if (name) employeesByCabinet[cab].push(String(name).trim());
  }

  return {
    cabinets: cabinets,
    employeesByCabinet: employeesByCabinet,
    menu: getMenu()
  };
}

function getEmployees(cabinet) {
  const sheet = getOrderSheet_();
  const lastRow = sheet.getLastRow();
  const values = sheet.getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, 2).getValues();
  const list = [];
  for (let i = 0; i < values.length; i += ROWS_PER_EMPLOYEE) {
    const cab = values[i][0];
    const name = values[i][1];
    if (name && (!cabinet || String(cab).trim() === String(cabinet).trim())) {
      list.push(String(name).trim());
    }
  }
  return { employees: list };
}

function findEmployeeRow_(sheet, cabinet, employee) {
  const lastRow = sheet.getLastRow();
  const values = sheet.getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, 2).getValues();
  for (let i = 0; i < values.length; i += ROWS_PER_EMPLOYEE) {
    const cab = values[i][0];
    const name = values[i][1];
    if (String(name).trim() === String(employee).trim() &&
        (!cabinet || String(cab).trim() === String(cabinet).trim())) {
      return FIRST_DATA_ROW + i;
    }
  }
  return null;
}

// ---------- ТЕКУЩИЕ ЗАКАЗЫ СОТРУДНИКА (для предзаполнения сайта) ----------

function getOrders(cabinet, employee) {
  const sheet = getOrderSheet_();
  const row = findEmployeeRow_(sheet, cabinet, employee);
  if (!row) return { error: 'Сотрудник не найден' };

  const width = FIRST_DAY_COL + DAY_BLOCK_WIDTH * 7 - 1;
  const block = sheet.getRange(row, 1, ROWS_PER_EMPLOYEE, width).getValues();

  const days = [];
  for (let d = 0; d < 7; d++) {
    const dateColIdx = FIRST_DAY_COL - 1 + d * DAY_BLOCK_WIDTH; // 0-based индекс в массиве block
    const date = block[0][dateColIdx];
    const slots = {};
    Object.keys(SLOT).forEach(function (key) {
      const r = SLOT[key];
      slots[key] = {
        dish:  block[r][dateColIdx + 1] || '',
        qty:   block[r][dateColIdx + 2] || 0,
        price: block[r][dateColIdx + 3] || 0
      };
    });
    days.push({ date: formatDate_(date), slots: slots });
  }
  return { cabinet: cabinet, employee: employee, days: days };
}

function formatDate_(d) {
  if (!(d instanceof Date)) return String(d || '');
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd.MM.yyyy');
}

// Сохраняет ВСЮ неделю за один вызов: один запрос к серверу вместо семи,
// и одна пакетная запись в таблицу вместо десятков отдельных setValue().
// payload: { cabinet, employee, days: [{ dayIndex, slots:[{slot,dish,qty}] }, ...] }
function saveWeekOrders(payload) {
  const sheet = getOrderSheet_();
  const row = findEmployeeRow_(sheet, payload.cabinet, payload.employee);
  if (!row) return { error: 'Сотрудник не найден' };

  const width = FIRST_DAY_COL + DAY_BLOCK_WIDTH * 7 - 1;
  const range = sheet.getRange(row, 1, ROWS_PER_EMPLOYEE, width);
  const block = range.getValues(); // одно чтение всего блока сотрудника

  payload.days.forEach(function (day) {
    const dateColIdx = FIRST_DAY_COL - 1 + day.dayIndex * DAY_BLOCK_WIDTH; // 0-based индекс в block
    day.slots.forEach(function (s) {
      const r = SLOT[s.slot];
      if (r === undefined) return;
      const qty = Math.max(0, Math.min(MAX_QTY_PER_SLOT, Number(s.qty) || 0));
      block[r][dateColIdx + 1] = s.dish || '';
      block[r][dateColIdx + 2] = qty || '';
    });
  });

  range.setValues(block); // одна пакетная запись всего блока
  return { ok: true };
}

// ---------- СОХРАНЕНИЕ ОДНОГО ДНЯ (оставлено для совместимости) ----------
// payload: { cabinet, employee, dayIndex (0-6), slots: [{slot:'SALAD', dish, qty}, ...] }
// ЦЕНУ НЕ ПИШЕМ — в таблице она формулой подтягивается по названию блюда.

function saveOrder(payload) {
  const sheet = getOrderSheet_();
  const row = findEmployeeRow_(sheet, payload.cabinet, payload.employee);
  if (!row) return { error: 'Сотрудник не найден' };

  const dateCol = FIRST_DAY_COL + payload.dayIndex * DAY_BLOCK_WIDTH;
  const dishCol = dateCol + 1;
  const qtyCol  = dateCol + 2;

  payload.slots.forEach(function (s) {
    const r = SLOT[s.slot];
    if (r === undefined) return;
    const qty = Math.max(0, Math.min(MAX_QTY_PER_SLOT, Number(s.qty) || 0));
    sheet.getRange(row + r, dishCol).setValue(s.dish || '');
    sheet.getRange(row + r, qtyCol).setValue(qty || '');
  });

  SpreadsheetApp.flush();
  return { ok: true };
}

// ---------- МЕНЮ (отдельная таблица «Тех меню») ----------

function getMenu(weekStartDateStr) {
  const parity = weekParity_(weekStartDateStr ? new Date(weekStartDateStr) : new Date());
  const menuSs = SpreadsheetApp.openById(MENU_SPREADSHEET_ID);
  const sheetName = parity === 'even' ? 'Меню (четная)' : 'Меню (нечетная)';
  const sheet = menuSs.getSheetByName(sheetName);
  if (!sheet) throw new Error('Не найден лист "' + sheetName + '" в таблице меню');

  const data = sheet.getDataRange().getValues();

  // Ищем справочную строку с "Понедельник" (там же лежат Название/Категория/Цена по дням)
  let headerRow = -1;
  for (let i = 0; i < data.length; i++) {
    if (data[i].indexOf('Понедельник') !== -1) { headerRow = i; break; }
  }
  if (headerRow === -1) throw new Error('Не найдена строка с днями недели в листе меню');

  const days = [];
  for (let d = 0; d < 7; d++) {
    const startCol = data[headerRow].indexOf(DAY_NAMES[d]);
    const items = [];
    for (let r = headerRow + 1; r < data.length; r++) {
      const name  = data[r][startCol];
      const cat   = data[r][startCol + 1];
      const price = data[r][startCol + 2];
      if (!name || name === '-') continue;
      if (!price) continue;
      items.push({ name: String(name).trim(), category: String(cat || '').trim(), price: Number(price) });
    }
    days.push({ day: DAY_NAMES[d], slots: groupIntoSlots_(items) });
  }

  return { parity: parity, days: days };
}

// Раскладывает блюда дня по 5 стандартным ячейкам по цене/категории
function groupIntoSlots_(items) {
  const slots = { SALAD: [], SOUP: [], HOT: [], SIDE: [], PASTRY: [] };
  items.forEach(function (it) {
    const cat = it.category.toLowerCase();
    if (cat.indexOf('гарнир') !== -1) {
      slots.SIDE.push(it);
    } else if (it.price === 30) {
      slots.PASTRY.push(it);
    } else if (it.price >= 200) {
      slots.HOT.push(it);
    } else if (it.price === 105) {
      slots.SOUP.push(it);
    } else {
      slots.SALAD.push(it); // 75₽ и не гарнир — салат / лёгкий завтрак / мелкая выпечка
    }
  });
  return slots;
}
