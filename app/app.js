// EventFlow — состояние интерфейса, рендеринг и сценарии (классический скрипт).
(function () {
  'use strict';
  var DB = window.EventFlowDB;
  var openDb = DB.openDb;
  var uuid = DB.uuid;
  var getAllParticipants = DB.getAllParticipants;
  var saveWithActivity = DB.saveWithActivity;
  var bulkAddParticipants = DB.bulkAddParticipants;
  var archiveParticipant = DB.archiveParticipant;
  var unarchiveParticipant = DB.unarchiveParticipant;
  var getSetting = DB.getSetting;
  var ensureSeedEvent = DB.ensureSeedEvent;
  var listActivity = DB.listActivity;
  var replaceAllData = DB.replaceAllData;
  var addActivity = DB.addActivity;

  var ALLOWED_STATUSES = ['new', 'confirmed', 'waitlist', 'cancelled'];
  var ALLOWED_TICKETS = ['standard', 'business', 'vip'];
  var STATUS_LABELS = { new: 'Новый', confirmed: 'Подтверждён', waitlist: 'Лист ожидания', cancelled: 'Отменён' };
  var TICKET_LABELS = { standard: 'Стандартный', business: 'Бизнес', vip: 'VIP' };
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Русские синонимы для значений (поддержка кириллических CSV).
  var TICKET_ALIASES = {
    'standard': 'standard', 'стандартный': 'standard', 'стандарт': 'standard',
    'business': 'business', 'бизнес': 'business',
    'vip': 'vip', 'вип': 'vip'
  };
  var STATUS_ALIASES = {
    'new': 'new', 'новый': 'new', 'новая': 'new',
    'confirmed': 'confirmed', 'подтверждён': 'confirmed', 'подтвержден': 'confirmed',
    'waitlist': 'waitlist', 'лист ожидания': 'waitlist', 'ожидание': 'waitlist',
    'cancelled': 'cancelled', 'отменён': 'cancelled', 'отменен': 'cancelled'
  };
  var HEADER_ALIASES = {
    name: ['name', 'имя', 'фио', 'участник'],
    email: ['email', 'e-mail', 'электронная почта', 'почта'],
    company: ['company', 'компания', 'организация'],
    ticket: ['ticket', 'билет', 'тариф', 'тип билета'],
    status: ['status', 'статус'],
    checked_in: ['checked_in', 'checkedin', 'check-in', 'прибыл', 'прибытие', 'чек-ин', 'чекин', 'пришёл'],
    registered_at: ['registered_at', 'registeredat', 'дата', 'регистрация', 'дата регистрации']
  };

  var state = {
    all: [], activity: [], event: null,
    search: '', status: '', ticket: '', sort: 'name-asc',
    editingId: null, dialogMode: 'create',
    csvPreview: null, restorePreview: null
  };

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    try {
      return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return d.toISOString(); }
  }

  function toast(message, type, action) {
    var box = $('toasts');
    if (!box) { alert(message); return; }
    var el = document.createElement('div');
    el.className = 'toast' + (type === 'success' ? ' toast-success' : type === 'error' ? ' toast-error' : '');
    var span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    if (action) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      btn.addEventListener('click', function () { action.onClick(); if (el.parentNode) el.parentNode.removeChild(el); });
      el.appendChild(btn);
    }
    box.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, action ? 8000 : 4000);
  }

  function safeShowModal(dlg) {
    if (!dlg) return;
    try {
      if (typeof dlg.showModal === 'function') {
        if (!dlg.open) dlg.showModal();
      } else {
        dlg.setAttribute('open', '');
      }
    } catch (e) {
      try { dlg.setAttribute('open', ''); } catch (e2) {}
    }
  }

  function safeCloseModal(dlg) {
    if (!dlg) return;
    try {
      if (typeof dlg.close === 'function' && dlg.open) dlg.close();
      else dlg.removeAttribute('open');
    } catch (e) {
      try { dlg.removeAttribute('open'); } catch (e2) {}
    }
  }

  // ---------- Чтение файлов с кириллицей ----------

  function readFileTextSmart(file) {
    if (file.arrayBuffer) {
      return file.arrayBuffer().then(function (buf) { return decodeBuffer(buf); });
    }
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('Не удалось прочитать файл')); };
      reader.readAsText(file, 'UTF-8');
    });
  }

  function decodeBuffer(buf) {
    var bytes = new Uint8Array(buf);
    var text = '';
    // Пробуем UTF-8 строго, при ошибке — Windows-1251 (Excel RU).
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      try {
        text = new TextDecoder('windows-1251').decode(bytes);
      } catch (e2) {
        text = new TextDecoder('utf-8').decode(bytes);
      }
    }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return text;
  }

  function detectDelimiter(headerLine) {
    var commas = (headerLine.match(/,/g) || []).length;
    var semis = (headerLine.match(/;/g) || []).length;
    var tabs = (headerLine.match(/\t/g) || []).length;
    if (semis > commas && semis >= tabs) return ';';
    if (tabs > commas && tabs > semis) return '\t';
    return ',';
  }

  // ---------- Валидация ----------

  function validateRecord(input, existingEmailsLower, currentId) {
    var errors = {};
    var name = (input.name || '').trim();
    var email = (input.email || '').trim();
    if (!name) errors.name = 'Введите имя. Поле не должно быть пустым.';
    if (!email) errors.email = 'Введите email. Без него нельзя сохранить участника.';
    else if (!EMAIL_RE.test(email)) errors.email = 'Проверьте email: нужен формат вида name@example.ru.';
    else {
      var low = email.toLowerCase();
      var clash = (existingEmailsLower || []).some(function (e) { return e.email === low && e.id !== currentId; });
      if (clash) errors.email = 'Такой email уже есть в базе. Используйте другой адрес.';
    }
    if (ALLOWED_TICKETS.indexOf(input.ticket) === -1) errors.ticket = 'Выберите тип билета: стандартный, бизнес или VIP.';
    if (ALLOWED_STATUSES.indexOf(input.status) === -1) errors.status = 'Выберите статус из списка.';
    if (input.checkedIn === true && input.status !== 'confirmed') {
      errors.checkedIn = 'Отметка о прибытии доступна только для подтверждённых участников.';
    }
    if (input.registeredAt) {
      var d = new Date(input.registeredAt);
      if (isNaN(d.getTime())) errors.registeredAt = 'Некорректная дата регистрации.';
    }
    return { errors: errors, name: name, email: email };
  }

  function collectExistingEmails() {
    return state.all.map(function (p) { return { id: p.id, email: String(p.email || '').toLowerCase() }; });
  }

  // ---------- Загрузка и рендер ----------

  function init() {
    loadUiSettings();
    bindEvents();
    openDb().then(function () {
      return ensureSeedEvent();
    }).then(function (ev) {
      state.event = ev;
      renderEvent();
      return reload();
    }).then(function () {
      $('loading').hidden = true;
      $('statsSection').hidden = false;
    }).catch(function (err) {
      var msg = (err && err.message) || String(err);
      $('loading').textContent = 'Не удалось открыть базу данных: ' + msg + '. Разрешите IndexedDB и откройте через локальный HTTP-сервер.';
      toast('База данных недоступна: ' + msg, 'error');
    });
  }

  function renderEvent() {
    if (!state.event) return;
    $('eventTitle').textContent = state.event.name || 'Событие';
    $('eventVenue').textContent = state.event.venue || '';
    $('eventCapacity').textContent = String(state.event.capacity != null ? state.event.capacity : '—');
  }

  function reload() {
    return getAllParticipants().then(function (rows) {
      state.all = rows || [];
      return listActivity(20);
    }).then(function (act) {
      state.activity = act || [];
      renderAll();
    });
  }

  function activeRows() {
    return state.all.filter(function (p) { return !p.archivedAt; });
  }

  function filteredRows() {
    var q = state.search.trim().toLowerCase();
    var rows = activeRows();
    if (q) {
      rows = rows.filter(function (p) {
        return String(p.name || '').toLowerCase().indexOf(q) !== -1 ||
          String(p.email || '').toLowerCase().indexOf(q) !== -1 ||
          String(p.company || '').toLowerCase().indexOf(q) !== -1;
      });
    }
    if (state.status) rows = rows.filter(function (p) { return p.status === state.status; });
    if (state.ticket) rows = rows.filter(function (p) { return p.ticket === state.ticket; });
    var sorted = rows.slice();
    if (state.sort === 'name-asc') sorted.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'ru'); });
    else if (state.sort === 'name-desc') sorted.sort(function (a, b) { return String(b.name || '').localeCompare(String(a.name || ''), 'ru'); });
    else if (state.sort === 'date-asc') sorted.sort(function (a, b) { return String(a.registeredAt || '').localeCompare(String(b.registeredAt || '')); });
    else sorted.sort(function (a, b) { return String(b.registeredAt || '').localeCompare(String(a.registeredAt || '')); });
    return sorted;
  }

  function renderAll() {
    renderMetrics();
    renderTable();
    renderActivity();
  }

  function renderMetrics() {
    var active = activeRows();
    $('statTotal').textContent = String(active.length);
    $('statConfirmed').textContent = String(active.filter(function (p) { return p.status === 'confirmed'; }).length);
    $('statChecked').textContent = String(active.filter(function (p) { return p.checkedIn === true; }).length);
    $('statWaitlist').textContent = String(active.filter(function (p) { return p.status === 'waitlist'; }).length);
  }

  function renderTable() {
    var rows = filteredRows();
    var hasAny = activeRows().length > 0;
    $('emptyStart').hidden = hasAny;
    $('emptySearch').hidden = !(hasAny && rows.length === 0);
    $('tableWrap').hidden = rows.length === 0;
    var body = $('participantsBody');
    body.innerHTML = '';
    rows.forEach(function (p) {
      var tr = document.createElement('tr');
      var canCheck = p.status === 'confirmed';
      tr.innerHTML =
        '<td><strong>' + escapeHtml(p.name) + '</strong><br><span class="muted">' + escapeHtml(p.email) + '</span>' +
        (p.company ? '<br><span class="muted">' + escapeHtml(p.company) + '</span>' : '') + '</td>' +
        '<td><span class="badge badge-ticket">' + escapeHtml(TICKET_LABELS[p.ticket] || p.ticket) + '</span></td>' +
        '<td><span class="badge badge-' + escapeHtml(p.status) + '">' + escapeHtml(STATUS_LABELS[p.status] || p.status) + '</span></td>' +
        '<td>' + escapeHtml(formatDate(p.registeredAt)) + '</td><td></td><td></td>';
      var checkCell = tr.children[4];
      if (p.checkedIn) {
        var s = document.createElement('span');
        s.className = 'badge badge-confirmed';
        s.textContent = 'Пришёл';
        checkCell.appendChild(s);
      } else if (canCheck) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'btn btn-secondary btn-small'; b.textContent = 'Отметить';
        b.setAttribute('aria-label', 'Отметить прибытие: ' + p.name);
        b.addEventListener('click', function () { toggleCheckin(p.id); });
        checkCell.appendChild(b);
      } else {
        checkCell.innerHTML = '<span class="muted" title="Доступно только для подтверждённых">—</span>';
      }
      var actCell = tr.children[5];
      var wrap = document.createElement('div');
      wrap.className = 'row-actions';
      var bOpen = document.createElement('button');
      bOpen.type = 'button'; bOpen.className = 'btn btn-secondary btn-small'; bOpen.textContent = 'Открыть';
      bOpen.addEventListener('click', function () { openDialog(p.id, 'view'); });
      var bEdit = document.createElement('button');
      bEdit.type = 'button'; bEdit.className = 'btn btn-secondary btn-small'; bEdit.textContent = 'Изменить';
      bEdit.addEventListener('click', function () { openDialog(p.id, 'edit'); });
      var bArch = document.createElement('button');
      bArch.type = 'button'; bArch.className = 'btn btn-danger btn-small'; bArch.textContent = 'В архив';
      bArch.addEventListener('click', function () { archiveWithUndo(p.id); });
      wrap.appendChild(bOpen); wrap.appendChild(bEdit); wrap.appendChild(bArch);
      actCell.appendChild(wrap);
      body.appendChild(tr);
    });
  }

  function renderActivity() {
    var ul = $('activityList');
    ul.innerHTML = '';
    $('activityEmpty').hidden = state.activity.length > 0;
    state.activity.slice(0, 10).forEach(function (a) {
      var li = document.createElement('li');
      var t = document.createElement('time');
      t.textContent = formatDate(a.createdAt);
      li.appendChild(t);
      li.appendChild(document.createTextNode(a.message || a.type));
      ul.appendChild(li);
    });
  }

  // ---------- Форма ----------

  function openDialog(id, mode) {
    state.editingId = id || null;
    state.dialogMode = mode;
    clearFormErrors();
    var dlg = $('participantDialog');
    if (mode === 'create') {
      $('participantDialogTitle').textContent = 'Новый участник';
      $('participantForm').reset();
      $('fTicket').value = 'standard';
      $('fStatus').value = 'new';
      $('fChecked').checked = false;
      setFormDisabled(false);
      $('viewOnlyBox').hidden = true;
      $('btnEditFromView').hidden = true;
      $('btnSave').hidden = false;
    } else {
      var p = null;
      for (var i = 0; i < state.all.length; i++) if (state.all[i].id === id) p = state.all[i];
      if (!p) return;
      $('fName').value = p.name || '';
      $('fEmail').value = p.email || '';
      $('fCompany').value = p.company || '';
      $('fTicket').value = p.ticket || 'standard';
      $('fStatus').value = p.status || 'new';
      $('fChecked').checked = p.checkedIn === true;
      if (mode === 'view') {
        $('participantDialogTitle').textContent = 'Участник: ' + p.name;
        setFormDisabled(true);
        var box = $('viewOnlyBox');
        box.hidden = false;
        box.innerHTML = '<div>Зарегистрирован: ' + escapeHtml(formatDate(p.registeredAt)) + '</div>' +
          (p.archivedAt ? '<div>В архиве с ' + escapeHtml(formatDate(p.archivedAt)) + '</div>' : '');
        $('btnEditFromView').hidden = false;
        $('btnSave').hidden = true;
      } else {
        $('participantDialogTitle').textContent = 'Редактировать: ' + p.name;
        setFormDisabled(false);
        $('viewOnlyBox').hidden = true;
        $('btnEditFromView').hidden = true;
        $('btnSave').hidden = false;
      }
    }
    validateFormLive();
    safeShowModal(dlg);
  }

  function setFormDisabled(dis) {
    ['fName', 'fEmail', 'fCompany', 'fTicket', 'fStatus', 'fChecked'].forEach(function (id) { $(id).disabled = dis; });
  }

  function clearFormErrors() {
    ['errName', 'errEmail', 'errTicket', 'errStatus', 'errChecked'].forEach(function (id) {
      $(id).hidden = true; $(id).textContent = '';
    });
    $('tableError').hidden = true;
  }

  function readForm() {
    return {
      name: $('fName').value,
      email: $('fEmail').value,
      company: $('fCompany').value.trim(),
      ticket: $('fTicket').value,
      status: $('fStatus').value,
      checkedIn: $('fChecked').checked
    };
  }

  function validateFormLive() {
    if (state.dialogMode === 'view') return true;
    clearFormErrors();
    var data = readForm();
    var res = validateRecord(data, collectExistingEmails(), state.editingId);
    var errors = res.errors;
    if (errors.name) { $('errName').textContent = errors.name; $('errName').hidden = false; }
    if (errors.email) { $('errEmail').textContent = errors.email; $('errEmail').hidden = false; }
    if (errors.ticket) { $('errTicket').textContent = errors.ticket; $('errTicket').hidden = false; }
    if (errors.status) { $('errStatus').textContent = errors.status; $('errStatus').hidden = false; }
    if (errors.checkedIn) { $('errChecked').textContent = errors.checkedIn + ' Снимите отметку или смените статус на «Подтверждён».'; $('errChecked').hidden = false; }
    var ok = Object.keys(errors).length === 0;
    $('btnSave').disabled = !ok;
    return ok;
  }

  function saveForm() {
    if (!validateFormLive()) return;
    var data = readForm();
    var now = new Date().toISOString();
    function done(msg) {
      safeCloseModal($('participantDialog'));
      toast(msg, 'success');
      return reload();
    }
    function fail(err) {
      var msg = String((err && err.message) || err);
      if (msg.indexOf('ConstraintError') !== -1 || msg.toLowerCase().indexOf('unique') !== -1) {
        $('errEmail').textContent = 'Такой email уже есть в базе. Используйте другой адрес.';
        $('errEmail').hidden = false;
        safeShowModal($('participantDialog'));
      } else {
        $('tableError').textContent = 'Не удалось сохранить: ' + msg;
        $('tableError').hidden = false;
      }
    }
    if (state.editingId) {
      var prev = null;
      for (var i = 0; i < state.all.length; i++) if (state.all[i].id === state.editingId) prev = state.all[i];
      if (!prev) return;
      var rec = {
        id: prev.id,
        name: data.name.trim(),
        email: data.email.trim(),
        company: data.company,
        ticket: data.ticket,
        status: data.status,
        checkedIn: data.checkedIn,
        registeredAt: prev.registeredAt,
        archivedAt: prev.archivedAt || null
      };
      saveWithActivity(rec, {
        id: uuid(), type: 'update', message: 'Изменён участник: ' + rec.name,
        createdAt: now, participantId: rec.id
      }).then(function () { return done('Изменения сохранены'); }).catch(fail);
    } else {
      var rec2 = {
        id: uuid(),
        name: data.name.trim(),
        email: data.email.trim(),
        company: data.company,
        ticket: data.ticket,
        status: data.status,
        checkedIn: data.checkedIn,
        registeredAt: now,
        archivedAt: null
      };
      saveWithActivity(rec2, {
        id: uuid(), type: 'create', message: 'Добавлен участник: ' + rec2.name,
        createdAt: now, participantId: rec2.id
      }).then(function () { return done('Участник добавлен'); }).catch(fail);
    }
  }

  function toggleCheckin(id) {
    var p = null;
    for (var i = 0; i < state.all.length; i++) if (state.all[i].id === id) p = state.all[i];
    if (!p) return;
    if (p.status !== 'confirmed') {
      toast('Чек-ин доступен только для подтверждённых участников', 'error');
      return;
    }
    var rec = {
      id: p.id, name: p.name, email: p.email, company: p.company,
      ticket: p.ticket, status: p.status, checkedIn: !p.checkedIn,
      registeredAt: p.registeredAt, archivedAt: p.archivedAt || null
    };
    saveWithActivity(rec, {
      id: uuid(), type: 'checkin',
      message: (rec.checkedIn ? 'Отмечено прибытие: ' : 'Снята отметка прибытия: ') + rec.name,
      createdAt: new Date().toISOString(), participantId: id
    }).then(function () {
      toast(rec.checkedIn ? 'Прибытие отмечено' : 'Отметка снята', 'success');
      return reload();
    }).catch(function (err) {
      toast('Не удалось отметить прибытие: ' + err.message, 'error');
    });
  }

  function archiveWithUndo(id) {
    var p = null;
    for (var i = 0; i < state.all.length; i++) if (state.all[i].id === id) p = state.all[i];
    if (!p) return;
    if (!window.confirm('Архивировать участника «' + p.name + '»? Его можно будет восстановить отменой.')) return;
    archiveParticipant(id, {
      id: uuid(), type: 'archive', message: 'Архивирован: ' + p.name,
      createdAt: new Date().toISOString(), participantId: id
    }).then(function () {
      return reload();
    }).then(function () {
      toast('Участник архивирован', 'info', {
        label: 'Отменить',
        onClick: function () {
          unarchiveParticipant(id).then(function () { return reload(); }).then(function () {
            toast('Архивация отменена', 'success');
          });
        }
      });
    }).catch(function (err) {
      toast('Не удалось архивировать: ' + err.message, 'error');
    });
  }

  // ---------- CSV ----------

  function parseCsv(text, delimiter) {
    var rows = [];
    var cur = '', row = [], inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (c === '"') {
        if (inQ && text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (c === delimiter && !inQ) { row.push(cur); cur = ''; }
      else if ((c === '\n' || c === '\r') && !inQ) {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); cur = '';
        if (row.length > 1 || row[0].trim() !== '') rows.push(row);
        row = [];
      } else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.map(function (r) { return r.map(function (v) { return v.trim(); }); });
  }

  function normKey(s) {
    return String(s || '').trim().toLowerCase().replace(/[_\-\s]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function mapHeader(headerCells) {
    var idx = { name: -1, email: -1, company: -1, ticket: -1, status: -1, checked_in: -1, registered_at: -1 };
    var normed = headerCells.map(function (h) {
      return String(h || '').trim().toLowerCase().replace(/["']/g, '');
    });
    Object.keys(HEADER_ALIASES).forEach(function (key) {
      var aliases = HEADER_ALIASES[key];
      for (var i = 0; i < normed.length; i++) {
        var h = normed[i].replace(/[_\-\s]+/g, '');
        for (var j = 0; j < aliases.length; j++) {
          var a = aliases[j].replace(/[_\-\s]+/g, '');
          if (h === a) { idx[key] = i; break; }
        }
        if (idx[key] !== -1) break;
      }
    });
    return idx;
  }

  function parseBoolCsv(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'да', 'д', '+'].indexOf(s) !== -1) return { value: true };
    if (['false', '0', 'no', 'n', 'нет', 'н', '-', ''].indexOf(s) !== -1) return { value: false };
    return { error: 'Некорректное значение прибытия «' + v + '». Допустимо true/false.' };
  }

  function previewCsvRows(matrix, existingLower) {
    if (!matrix.length) return { fatal: 'Файл пуст.' };
    var idx = mapHeader(matrix[0]);
    var missing = Object.keys(idx).filter(function (k) { return idx[k] === -1; });
    if (missing.length) {
      return { fatal: 'Неверный заголовок. Не найдены колонки: ' + missing.join(', ') + '. Ожидается: name, email, company, ticket, status, checked_in, registered_at (разделитель — запятая или точка с запятой, кодировка — UTF-8 или Windows-1251).' };
    }
    var valid = [], errors = [];
    var seen = {};
    var dbSet = {};
    (existingLower || []).forEach(function (e) { dbSet[e.email] = true; });
    for (var i = 1; i < matrix.length; i++) {
      var r = matrix[i];
      if (r.every(function (c) { return c === ''; })) continue;
      var line = i + 1;
      var ticketRaw = String(r[idx.ticket] || '');
      var statusRaw = String(r[idx.status] || '');
      var ticketNorm = TICKET_ALIASES[normKey(ticketRaw)] || ticketRaw.trim().toLowerCase();
      var statusNorm = STATUS_ALIASES[normKey(statusRaw)] || statusRaw.trim().toLowerCase();
      var raw = {
        name: r[idx.name] || '', email: r[idx.email] || '', company: r[idx.company] || '',
        ticket: ticketNorm, status: statusNorm,
        checkedRaw: r[idx.checked_in] || '', registeredAt: r[idx.registered_at] || ''
      };
      var reasons = [];
      if (!raw.name.trim()) reasons.push('пустое имя — введите имя участника');
      if (!EMAIL_RE.test(raw.email.trim())) reasons.push('некорректный email «' + raw.email + '»');
      else {
        var low = raw.email.trim().toLowerCase();
        if (seen[low]) reasons.push('дубликат email внутри файла: ' + raw.email);
        if (dbSet[low]) reasons.push('email уже есть в базе: ' + raw.email);
      }
      if (ALLOWED_TICKETS.indexOf(raw.ticket) === -1) reasons.push('неизвестный тип билета «' + ticketRaw + '». Допустимо: standard, business, vip');
      if (ALLOWED_STATUSES.indexOf(raw.status) === -1) reasons.push('неизвестный статус «' + statusRaw + '». Допустимо: new, confirmed, waitlist, cancelled');
      var b = parseBoolCsv(raw.checkedRaw);
      if (b.error) reasons.push(b.error);
      else if (b.value === true && raw.status !== 'confirmed') reasons.push('прибытие отмечено для статуса «' + statusRaw + '» — допустимо только для confirmed');
      var d = new Date(raw.registeredAt);
      if (!raw.registeredAt || isNaN(d.getTime())) reasons.push('некорректная дата регистрации «' + raw.registeredAt + '»');
      if (reasons.length) errors.push({ line: line, reasons: reasons, raw: r.join(', ') });
      else {
        seen[low] = true;
        valid.push({
          id: uuid(), name: raw.name.trim(), email: raw.email.trim(), company: raw.company.trim(),
          ticket: raw.ticket, status: raw.status, checkedIn: b.value,
          registeredAt: d.toISOString(), archivedAt: null
        });
      }
      if (raw.email && EMAIL_RE.test(raw.email.trim())) seen[raw.email.trim().toLowerCase()] = true;
    }
    return { valid: valid, errors: errors, total: matrix.length - 1 };
  }

  function handleCsvFile(file) {
    readFileTextSmart(file).then(function (text) {
      if (!text || !text.trim()) {
        toast('Файл пуст', 'error');
        return;
      }
      var firstLine = text.split(/\r?\n/)[0] || '';
      var delimiter = detectDelimiter(firstLine);
      var matrix = parseCsv(text, delimiter);
      var preview = previewCsvRows(matrix, collectExistingEmails());
      state.csvPreview = { valid: preview.valid, errors: preview.errors, total: preview.total, fatal: preview.fatal, fileName: file.name };
      renderCsvPreview();
      safeShowModal($('csvDialog'));
    }).catch(function (err) {
      toast('Ошибка чтения файла: ' + (err.message || err), 'error');
    });
  }

  function renderCsvPreview() {
    var p = state.csvPreview;
    if (!p) return;
    if (p.fatal) {
      $('csvSummary').textContent = p.fatal;
      $('csvErrors').innerHTML = '';
      $('btnCsvConfirm').disabled = true;
      return;
    }
    $('csvSummary').textContent =
      'Файл «' + p.fileName + '»: строк ' + p.total + ', корректных ' + p.valid.length + ', с ошибками ' + p.errors.length + '. До подтверждения ничего не записано в базу.';
    var box = $('csvErrors');
    box.innerHTML = '';
    if (p.errors.length) {
      var ul = document.createElement('ul');
      p.errors.forEach(function (e) {
        var li = document.createElement('li');
        li.textContent = 'Строка ' + e.line + ': ' + e.reasons.join('; ');
        ul.appendChild(li);
      });
      box.appendChild(ul);
    } else {
      box.textContent = 'Ошибок нет. Можно импортировать все строки.';
    }
    $('btnCsvConfirm').disabled = p.valid.length === 0;
    $('btnCsvConfirm').textContent = 'Импортировать корректные (' + p.valid.length + ')';
  }

  function confirmCsvImport() {
    var p = state.csvPreview;
    if (!p || !p.valid) return;
    bulkAddParticipants(p.valid, {
      id: uuid(), type: 'import',
      message: 'Импорт CSV «' + p.fileName + '»: добавлено ' + p.valid.length + ', ошибок ' + p.errors.length,
      createdAt: new Date().toISOString(),
      meta: { file: p.fileName, imported: p.valid.length, failed: p.errors.length }
    }).then(function () {
      safeCloseModal($('csvDialog'));
      state.csvPreview = null;
      toast('Импортировано записей: ' + p.valid.length, 'success');
      return reload();
    }).catch(function (err) {
      toast('Импорт не выполнен: ' + (err.message || err), 'error');
    });
  }

  // ---------- Экспорт / восстановление ----------

  function exportJson() {
    getAllParticipants().then(function (rows) {
      return getSetting('event').then(function (evWrap) {
        var ev = (evWrap && evWrap.value) || state.event;
        return listActivity(0).then(function (acts) {
          var payload = {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            event: ev,
            participants: rows,
            activity: acts
          };
          var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'eventflow-backup-' + new Date().toISOString().slice(0, 10) + '.json';
          document.body.appendChild(a);
          a.click();
          setTimeout(function () {
            try { URL.revokeObjectURL(a.href); } catch (e) {}
            if (a.parentNode) a.parentNode.removeChild(a);
          }, 2000);
          return addActivity({ id: uuid(), type: 'export', message: 'Экспортирована копия: ' + rows.length + ' записей', createdAt: new Date().toISOString() });
        });
      });
    }).then(function () {
      return listActivity(20);
    }).then(function (acts) {
      state.activity = acts || [];
      renderActivity();
      toast('Резервная копия скачана', 'success');
    }).catch(function (err) {
      toast('Не удалось экспортировать: ' + (err.message || err), 'error');
    });
  }

  function handleRestoreFile(file) {
    readFileTextSmart(file).then(function (text) {
      var data;
      try { data = JSON.parse(text); }
      catch (e) { throw new Error('Файл не является корректным JSON.'); }
      if (!data || typeof data !== 'object') throw new Error('Неверная структура файла.');
      if (data.schemaVersion !== 1) throw new Error('Несовместимая версия схемы: ' + data.schemaVersion + '. Ожидается 1.');
      if (!Array.isArray(data.participants)) throw new Error('В файле отсутствует список participants.');
      if (!data.event || typeof data.event !== 'object') throw new Error('В файле отсутствует объект event.');
      var emails = {};
      for (var i = 0; i < data.participants.length; i++) {
        var r = data.participants[i];
        if (!r.id || !r.name || !r.email) throw new Error('Запись №' + (i + 1) + ' повреждена: нужны id, name, email.');
        if (!EMAIL_RE.test(String(r.email))) throw new Error('Запись №' + (i + 1) + ': некорректный email.');
        if (r.ticket && ALLOWED_TICKETS.indexOf(r.ticket) === -1) throw new Error('Запись №' + (i + 1) + ': неизвестный билет.');
        if (r.status && ALLOWED_STATUSES.indexOf(r.status) === -1) throw new Error('Запись №' + (i + 1) + ': неизвестный статус.');
        if (r.checkedIn === true && r.status !== 'confirmed') throw new Error('Запись №' + (i + 1) + ': прибытие допустимо только для confirmed.');
        var low = String(r.email).toLowerCase();
        if (emails[low]) throw new Error('Дубликат email в файле: ' + r.email);
        emails[low] = true;
      }
      state.restorePreview = { data: data, fileName: file.name };
      $('restoreSummary').textContent = 'Файл «' + file.name + '»: участников ' + data.participants.length +
        ', действий журнала ' + (Array.isArray(data.activity) ? data.activity.length : 0) + '. Текущие данные будут заменены.';
      $('btnRestoreConfirm').disabled = false;
      safeShowModal($('restoreDialog'));
    }).catch(function (err) {
      state.restorePreview = null;
      toast('Восстановление невозможно: ' + (err.message || err), 'error');
    });
  }

  function confirmRestore() {
    var p = state.restorePreview;
    if (!p) return;
    var acts = (p.data.activity || []).slice();
    acts.push({
      id: uuid(), type: 'restore',
      message: 'Восстановлена копия «' + p.fileName + '»: ' + p.data.participants.length + ' записей',
      createdAt: new Date().toISOString()
    });
    replaceAllData({
      participants: p.data.participants,
      activity: acts,
      event: p.data.event
    }).then(function () {
      state.event = p.data.event;
      renderEvent();
      safeCloseModal($('restoreDialog'));
      state.restorePreview = null;
      return reload();
    }).then(function () {
      toast('Данные восстановлены из копии', 'success');
    }).catch(function (err) {
      toast('Не удалось восстановить: ' + (err.message || err), 'error');
    });
  }

  // ---------- Настройки интерфейса ----------

  function loadUiSettings() {
    try {
      var raw = localStorage.getItem('eventflow-ui');
      if (!raw) return;
      var s = JSON.parse(raw);
      state.search = s.search || '';
      state.status = s.status || '';
      state.ticket = s.ticket || '';
      state.sort = s.sort || 'name-asc';
    } catch (e) {}
  }

  function persistUiSettings() {
    try {
      localStorage.setItem('eventflow-ui', JSON.stringify({
        search: state.search, status: state.status, ticket: state.ticket, sort: state.sort
      }));
    } catch (e) {}
  }

  function openFileDialog(input) {
    try {
      input.value = '';
      if (typeof input.showPicker === 'function') {
        try { input.showPicker(); return; } catch (e) {}
      }
      input.click();
    } catch (e) {
      toast('Не удалось открыть выбор файла: ' + e.message, 'error');
    }
  }

  function bindEvents() {
    $('searchInput').addEventListener('input', function (e) { state.search = e.target.value; persistUiSettings(); renderTable(); });
    $('statusFilter').addEventListener('change', function (e) { state.status = e.target.value; persistUiSettings(); renderTable(); });
    $('ticketFilter').addEventListener('change', function (e) { state.ticket = e.target.value; persistUiSettings(); renderTable(); });
    $('sortSelect').addEventListener('change', function (e) { state.sort = e.target.value; persistUiSettings(); renderTable(); });
    $('searchInput').value = state.search;
    $('statusFilter').value = state.status;
    $('ticketFilter').value = state.ticket;
    $('sortSelect').value = state.sort;

    var navBtns = document.querySelectorAll('.nav-item');
    for (var i = 0; i < navBtns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var name = btn.getAttribute('data-section') || btn.textContent.trim();
          if (name === 'Участники') {
            var main = $('main');
            if (main) main.scrollIntoView();
            var s = $('searchInput');
            if (s) s.focus();
            return;
          }
          toast('Раздел «' + name + '» не входит в эту версию. Работаем в «Участниках».', 'info');
        });
      })(navBtns[i]);
    }

    $('btnAdd').addEventListener('click', function () { openDialog(null, 'create'); });
    var emptyAdd = document.querySelector('[data-action="empty-add"]');
    if (emptyAdd) emptyAdd.addEventListener('click', function () { openDialog(null, 'create'); });
    var emptyImport = document.querySelector('[data-action="empty-import"]');
    if (emptyImport) emptyImport.addEventListener('click', function () { openFileDialog($('csvFile')); });
    $('btnResetFilters').addEventListener('click', function () {
      state.search = ''; state.status = ''; state.ticket = '';
      $('searchInput').value = ''; $('statusFilter').value = ''; $('ticketFilter').value = '';
      persistUiSettings(); renderTable();
    });

    $('participantForm').addEventListener('submit', function (e) { e.preventDefault(); saveForm(); });
    ['fName', 'fEmail', 'fCompany', 'fTicket', 'fStatus', 'fChecked'].forEach(function (id) {
      $(id).addEventListener('input', validateFormLive);
      $(id).addEventListener('change', validateFormLive);
    });
    $('btnCancelDialog').addEventListener('click', function () { safeCloseModal($('participantDialog')); });
    $('btnEditFromView').addEventListener('click', function () {
      state.dialogMode = 'edit';
      $('participantDialogTitle').textContent = 'Редактировать участника';
      setFormDisabled(false);
      $('viewOnlyBox').hidden = true;
      $('btnEditFromView').hidden = true;
      $('btnSave').hidden = false;
      validateFormLive();
      $('fName').focus();
    });

    $('btnImport').addEventListener('click', function () { openFileDialog($('csvFile')); });
    $('csvFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) handleCsvFile(f);
    });
    $('csvFile').addEventListener('click', function (e) { e.target.value = ''; });
    $('btnCsvCancel').addEventListener('click', function () { safeCloseModal($('csvDialog')); state.csvPreview = null; });
    $('btnCsvConfirm').addEventListener('click', confirmCsvImport);

    $('btnExport').addEventListener('click', exportJson);
    $('btnRestore').addEventListener('click', function () { openFileDialog($('jsonFile')); });
    $('jsonFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) handleRestoreFile(f);
    });
    $('jsonFile').addEventListener('click', function (e) { e.target.value = ''; });
    $('btnRestoreCancel').addEventListener('click', function () { safeCloseModal($('restoreDialog')); state.restorePreview = null; });
    $('btnRestoreConfirm').addEventListener('click', confirmRestore);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
