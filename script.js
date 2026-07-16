// ============================================================
// НАСТРОЙКА: URL Apps Script Web App для каждого офиса.
// У каждого офиса — своя таблица и свой отдельный деплой Apps Script
// (тот же самый код Code.gs, вставленный в таблицу каждого офиса).
// Впишите URL по мере подключения таблицы каждого офиса.
// ============================================================
const OFFICE_URLS = {
  'Пифагор':    'https://script.google.com/macros/s/AKfycbwbhjN3voXok0dqnqmYJOxh0SkFQxnj8HqnNXMkMFCAO-nDa5ZLYPox-ADSgagCzas6/exec', // уже подключён и протестирован
  'Мойка':      '',
  'Средний пр': '',
  'Фонтанка':   '',
  'Невский':    '',
  'Тележная':   ''
};

function currentGasUrl() {
  const office = $('officeSelect') ? $('officeSelect').value : Object.keys(OFFICE_URLS)[0];
  const url = OFFICE_URLS[office];
  return (url && url.startsWith('https://script.google.com/')) ? url : null;
}

const SLOT_KEYS = ['SALAD', 'SOUP', 'HOT', 'SIDE', 'PASTRY', 'FREE1', 'FREE2'];
const DOW_SHORT = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС'];
const DOW_FULL = ['понедельник','вторник','среда','четверг','пятница','суббота','воскресенье'];
const MAX_QTY = 3;

let state = {
  cabinet: null,
  employee: null,
  employeesByCabinet: {}, // кэш из bootstrap — переключение кабинета без обращения к серверу
  menu: null,             // кэш меню — не запрашивается заново при смене сотрудника
  orders: null,
  selectedDayIndex: 0,
  cart: {}
};

const $ = (id) => document.getElementById(id);

async function api(action, params) {
  const gasUrl = currentGasUrl();
  if (!gasUrl) throw new Error('Для этого офиса ещё не подключён Apps Script (нет URL)');
  const url = new URL(gasUrl);
  url.searchParams.set('action', action);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  return res.json();
}

async function apiPost(body) {
  const gasUrl = currentGasUrl();
  if (!gasUrl) throw new Error('Для этого офиса ещё не подключён Apps Script (нет URL)');
  const res = await fetch(gasUrl, { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}

function setStatus(msg, isError) {
  const el = $('statusMsg');
  el.textContent = msg;
  el.className = 'status-msg' + (isError ? ' error' : '');
}

function setLoading(isLoading) {
  document.querySelectorAll('select, button').forEach(el => el.disabled = isLoading);
}

// ---------- ОФИС ----------

function initOfficeSelect() {
  const sel = $('officeSelect');
  sel.innerHTML = Object.keys(OFFICE_URLS).map(o => `<option value="${o}">${o}</option>`).join('');
  const saved = localStorage.getItem('foodOrders.office');
  if (saved && OFFICE_URLS[saved] !== undefined) sel.value = saved;
}

async function onOfficeChanged() {
  localStorage.setItem('foodOrders.office', $('officeSelect').value);
  if (!currentGasUrl()) {
    setStatus('Для этого офиса приложение ещё не подключено — выберите другой офис', true);
    $('cabinetSelect').innerHTML = '<option value="">—</option>';
    $('employeeSelect').innerHTML = '<option value="">—</option>';
    return;
  }
  await loadBootstrap();
}

// ---------- ЗАГРУЗКА (1 запрос вместо трёх) ----------

async function loadBootstrap() {
  setLoading(true);
  setStatus('Загрузка…');
  try {
    const data = await api('bootstrap');
    if (data.error) throw new Error(data.error);

    state.employeesByCabinet = data.employeesByCabinet || {};
    state.menu = data.menu;

    const cabSel = $('cabinetSelect');
    cabSel.innerHTML = (data.cabinets || []).map(c => `<option value="${c}">${c}</option>`).join('');
    const saved = localStorage.getItem('foodOrders.cabinet.' + $('officeSelect').value);
    if (saved && data.cabinets.includes(saved)) cabSel.value = saved;

    renderEmployeesForCabinet(cabSel.value);
    setStatus('');
  } catch (err) {
    setStatus('Ошибка загрузки: ' + err.message, true);
  } finally {
    setLoading(false);
  }
}

// Переключение кабинета — БЕЗ обращения к серверу, из кэша bootstrap
function renderEmployeesForCabinet(cabinet) {
  const list = state.employeesByCabinet[cabinet] || [];
  const sel = $('employeeSelect');
  const saved = localStorage.getItem('foodOrders.employee.' + cabinet);
  sel.innerHTML = list.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  if (saved && list.includes(saved)) sel.value = saved;
  if (list.length) loadEmployeeOrders();
}

// Заказы конкретного сотрудника — 1 запрос (меню уже в кэше, заново не грузим)
async function loadEmployeeOrders() {
  state.cabinet = $('cabinetSelect').value;
  state.employee = $('employeeSelect').value;
  if (!state.employee) return;

  localStorage.setItem('foodOrders.cabinet.' + $('officeSelect').value, state.cabinet);
  localStorage.setItem('foodOrders.employee.' + state.cabinet, state.employee);

  setLoading(true);
  setStatus('Загрузка заказов…');
  try {
    const orders = await api('employeeOrders', { cabinet: state.cabinet, employee: state.employee });
    if (orders.error) throw new Error(orders.error);
    state.orders = orders;
    state.cart = {};
    orders.days.forEach((d, i) => {
      state.cart[i] = {};
      SLOT_KEYS.forEach(key => {
        const s = d.slots[key] || {};
        state.cart[i][key] = { dish: s.dish || '', qty: Number(s.qty) || 0, price: Number(s.price) || 0 };
      });
    });
    setStatus('');
    renderDayTabs();
    selectDay(0);
  } catch (err) {
    setStatus('Ошибка: ' + err.message, true);
  } finally {
    setLoading(false);
  }
}

// ---------- ДНИ НЕДЕЛИ ----------

function renderDayTabs() {
  const wrap = $('dayTabs');
  wrap.innerHTML = '';
  const days = (state.orders && state.orders.days) || [];
  days.forEach((d, i) => {
    const [dd] = (d.date || '').split('.');
    const tab = document.createElement('div');
    tab.className = 'day-tab' + (i === state.selectedDayIndex ? ' active' : '');
    tab.innerHTML = `
      <div class="num">${dd || '?'}</div>
      <div class="dow">${DOW_SHORT[i]}</div>
      <div class="sum">${dayTotal(i)} ₽</div>
    `;
    tab.addEventListener('click', () => selectDay(i));
    wrap.appendChild(tab);
  });
}

function dayTotal(dayIndex) {
  const day = state.cart[dayIndex];
  if (!day) return 0;
  return SLOT_KEYS.reduce((sum, key) => {
    const item = day[key];
    if (!item || !item.dish) return sum;
    return sum + (item.price || 0) * (item.qty || 1);
  }, 0);
}

function selectDay(index) {
  state.selectedDayIndex = index;
  renderDayTabs();
  renderDayDetail();
}

// ---------- ДЕТАЛИ ДНЯ / ВЫБОР БЛЮД ----------

function renderDayDetail() {
  const idx = state.selectedDayIndex;
  const orderDay = state.orders.days[idx];
  const menuDay = state.menu.days[idx];

  $('dayTitle').textContent = `${DOW_FULL[idx]}, ${orderDay.date}`;
  $('dayTotal').textContent = `Итого: ${dayTotal(idx)} ₽`;

  const list = $('slotsList');
  list.innerHTML = '';

  SLOT_KEYS.forEach(key => {
    const current = state.cart[idx][key] || { dish: '', qty: 0, price: 0 };
    const options = key.startsWith('FREE') ? allDishesForDay(menuDay) : (menuDay.slots[key] || []);

    const row = document.createElement('div');
    row.className = 'slot-row';

    const select = document.createElement('select');
    select.innerHTML = '<option value="">—</option>' + options.map(o =>
      `<option value="${escapeHtml(o.name)}" data-price="${o.price}" ${o.name === current.dish ? 'selected' : ''}>${escapeHtml(o.name)} (${o.price}₽)</option>`
    ).join('');

    const qty = document.createElement('input');
    qty.type = 'number';
    qty.className = 'slot-qty';
    qty.min = 0; qty.max = MAX_QTY;
    qty.value = current.dish ? (current.qty || 1) : 0;

    const price = document.createElement('div');
    price.className = 'slot-price';
    price.textContent = (current.price || 0) + ' ₽';

    select.addEventListener('change', () => {
      const opt = select.selectedOptions[0];
      const dish = select.value;
      const p = dish ? Number(opt.dataset.price) : 0;
      qty.value = dish ? Math.max(1, Number(qty.value) || 1) : 0;
      state.cart[idx][key] = { dish, qty: Number(qty.value), price: p };
      price.textContent = p + ' ₽';
      renderDayTabs();
      $('dayTotal').textContent = `Итого: ${dayTotal(idx)} ₽`;
    });

    qty.addEventListener('change', () => {
      let v = Math.max(0, Math.min(MAX_QTY, Number(qty.value) || 0));
      qty.value = v;
      state.cart[idx][key].qty = v;
      if (v === 0) { state.cart[idx][key].dish = ''; select.value = ''; state.cart[idx][key].price = 0; price.textContent = '0 ₽'; }
      renderDayTabs();
      $('dayTotal').textContent = `Итого: ${dayTotal(idx)} ₽`;
    });

    row.appendChild(select);
    row.appendChild(qty);
    row.appendChild(price);
    list.appendChild(row);
  });
}

function allDishesForDay(menuDay) {
  return Object.values(menuDay.slots).flat();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- СОХРАНЕНИЕ (вся неделя за 1 запрос вместо семи) ----------

async function saveWeek() {
  setLoading(true);
  setStatus('Сохраняю…');
  try {
    const days = [];
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      const day = state.cart[dayIndex] || {};
      days.push({
        dayIndex,
        slots: SLOT_KEYS.map(key => ({
          slot: key,
          dish: (day[key] && day[key].dish) || '',
          qty: (day[key] && day[key].qty) || 0
        }))
      });
    }
    const res = await api('saveWeek', { payload: JSON.stringify({ cabinet: state.cabinet, employee: state.employee, days }) });
    if (res.error) throw new Error(res.error);
    setStatus('✅ Неделя сохранена');
  } catch (err) {
    setStatus('Ошибка: ' + err.message, true);
  } finally {
    setLoading(false);
  }
}

// ---------- СОБЫТИЯ ----------

$('officeSelect').addEventListener('change', onOfficeChanged);
$('cabinetSelect').addEventListener('change', (e) => renderEmployeesForCabinet(e.target.value));
$('employeeSelect').addEventListener('change', loadEmployeeOrders);
$('saveWeekBtn').addEventListener('click', saveWeek);
$('refreshBtn').addEventListener('click', () => loadBootstrap());

initOfficeSelect();
onOfficeChanged().catch(err => setStatus('Ошибка загрузки: ' + err.message, true));
