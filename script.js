// ============================================================
// НАСТРОЙКА: вставьте сюда URL вашего Apps Script Web App
// (Deploy → New deployment → Web app → скопировать "Web app URL")
// ============================================================
const GAS_URL = 'https://script.google.com/macros/s/AKfycbyWTAsAHEpMNAr-9Dv3J90DI05yQH523n6HRg21oJyyKCvPorYy3n0R9DWQCTGQEF57/exec';

const SLOT_KEYS = ['SALAD', 'SOUP', 'HOT', 'SIDE', 'PASTRY', 'FREE1', 'FREE2'];
const SLOT_LABELS = {
  SALAD: 'Салат / лёгкий завтрак',
  SOUP: 'Завтрак плотный / суп',
  HOT: 'Горячее',
  SIDE: 'Гарнир',
  PASTRY: 'Выпечка',
  FREE1: 'Любое блюдо',
  FREE2: 'Любое блюдо'
};
const DOW_SHORT = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС'];
const DOW_FULL = ['понедельник','вторник','среда','четверг','пятница','суббота','воскресенье'];
const MAX_QTY = 3;

let state = {
  cabinet: null,
  employee: null,
  menu: null,      // ответ getMenu: {parity, days:[{day, slots}]}
  orders: null,     // ответ getOrders: {days:[{date, slots}]}
  selectedDayIndex: 0,
  // локальные изменения по дням: cart[dayIndex][slotKey] = {dish, qty, price}
  cart: {}
};

const $ = (id) => document.getElementById(id);

async function api(action, params) {
  const url = new URL(GAS_URL);
  url.searchParams.set('action', action);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  return res.json();
}

async function apiPost(body) {
  const res = await fetch(GAS_URL, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return res.json();
}

function setStatus(msg, isError) {
  const el = $('statusMsg');
  el.textContent = msg;
  el.className = 'status-msg' + (isError ? ' error' : '');
}

// ---------- ИНИЦИАЛИЗАЦИЯ ----------

async function loadCabinets() {
  const data = await api('cabinets');
  const sel = $('cabinetSelect');
  sel.innerHTML = '';
  (data.cabinets || []).forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  });
  if (data.cabinets && data.cabinets.length) {
    sel.value = data.cabinets[0];
    await loadEmployees(sel.value);
  }
}

async function loadEmployees(cabinet) {
  const data = await api('employees', { cabinet });
  const sel = $('employeeSelect');
  sel.innerHTML = '';
  (data.employees || []).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  });
  if (data.employees && data.employees.length) {
    sel.value = data.employees[0];
    await onEmployeeChosen();
  }
}

async function onEmployeeChosen() {
  state.cabinet = $('cabinetSelect').value;
  state.employee = $('employeeSelect').value;
  if (!state.employee) return;

  setStatus('Загрузка меню и заказов…');
  const [menu, orders] = await Promise.all([
    api('menu', {}),
    api('orders', { cabinet: state.cabinet, employee: state.employee })
  ]);
  state.menu = menu;
  state.orders = orders;
  state.cart = {};

  if (orders.days) {
    orders.days.forEach((d, i) => {
      state.cart[i] = {};
      SLOT_KEYS.forEach(key => {
        const s = d.slots[key] || {};
        state.cart[i][key] = { dish: s.dish || '', qty: Number(s.qty) || 0, price: Number(s.price) || 0 };
      });
    });
  }

  setStatus('');
  renderDayTabs();
  selectDay(0);
}

// ---------- ДНИ НЕДЕЛИ ----------

function renderDayTabs() {
  const wrap = $('dayTabs');
  wrap.innerHTML = '';
  const days = (state.orders && state.orders.days) || [];
  days.forEach((d, i) => {
    const [dd, mm] = (d.date || '').split('.');
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

// ---------- СОХРАНЕНИЕ ----------

async function saveWeek() {
  setStatus('Сохраняю…');
  try {
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      const day = state.cart[dayIndex] || {};
      const slots = SLOT_KEYS.map(key => ({
        slot: key,
        dish: (day[key] && day[key].dish) || '',
        qty: (day[key] && day[key].qty) || 0
      }));
      const res = await apiPost({
        cabinet: state.cabinet,
        employee: state.employee,
        dayIndex,
        slots
      });
      if (res.error) throw new Error(res.error);
    }
    setStatus('✅ Неделя сохранена');
  } catch (err) {
    setStatus('Ошибка: ' + err.message, true);
  }
}

// ---------- СОБЫТИЯ ----------

$('cabinetSelect').addEventListener('change', (e) => loadEmployees(e.target.value));
$('employeeSelect').addEventListener('change', onEmployeeChosen);
$('saveWeekBtn').addEventListener('click', saveWeek);
$('refreshBtn').addEventListener('click', () => onEmployeeChosen());

loadCabinets().catch(err => setStatus('Ошибка загрузки: ' + err.message, true));
