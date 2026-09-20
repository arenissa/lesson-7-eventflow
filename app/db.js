// EventFlow — слой IndexedDB (классический скрипт, без модулей).
// Имя базы: eventflow-db, версия: 1.
// Хранилища: participants (ключ id), settings (ключ key), activity (ключ id).
(function () {
  'use strict';
  var DB_NAME = 'eventflow-db';
  var DB_VERSION = 1;
  var dbPromise = null;

  function uuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'id-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = function (event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains('participants')) {
          var store = db.createObjectStore('participants', { keyPath: 'id' });
          store.createIndex('email', 'email', { unique: true });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('registeredAt', 'registeredAt', { unique: false });
          store.createIndex('archivedAt', 'archivedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('activity')) {
          db.createObjectStore('activity', { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () {};
    });
    return dbPromise;
  }

  function txPromise(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('Транзакция прервана')); };
    });
  }

  function reqPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function getAllParticipants() {
    return openDb().then(function (db) {
      var tx = db.transaction('participants', 'readonly');
      return reqPromise(tx.objectStore('participants').getAll()).then(function (rows) { return rows || []; });
    });
  }

  function getParticipant(id) {
    return openDb().then(function (db) {
      var tx = db.transaction('participants', 'readonly');
      return reqPromise(tx.objectStore('participants').get(id));
    });
  }

  function bulkAddParticipants(records, activityEntry) {
    return openDb().then(function (db) {
      var tx = db.transaction(['participants', 'activity'], 'readwrite');
      var pStore = tx.objectStore('participants');
      for (var i = 0; i < records.length; i++) pStore.add(records[i]);
      if (activityEntry) tx.objectStore('activity').add(activityEntry);
      return txPromise(tx);
    });
  }

  function saveWithActivity(record, activityEntry) {
    return openDb().then(function (db) {
      var tx = db.transaction(['participants', 'activity'], 'readwrite');
      tx.objectStore('participants').put(record);
      if (activityEntry) tx.objectStore('activity').add(activityEntry);
      return txPromise(tx);
    });
  }

  function archiveParticipant(id, activityEntry) {
    return openDb().then(function (db) {
      var tx = db.transaction(['participants', 'activity'], 'readwrite');
      var pStore = tx.objectStore('participants');
      return reqPromise(pStore.get(id)).then(function (rec) {
        if (!rec) throw new Error('Участник не найден');
        rec.archivedAt = new Date().toISOString();
        pStore.put(rec);
        if (activityEntry) tx.objectStore('activity').add(activityEntry);
        return txPromise(tx).then(function () { return rec; });
      });
    });
  }

  function unarchiveParticipant(id) {
    return openDb().then(function (db) {
      var tx = db.transaction(['participants', 'activity'], 'readwrite');
      var pStore = tx.objectStore('participants');
      return reqPromise(pStore.get(id)).then(function (rec) {
        if (!rec) throw new Error('Участник не найден');
        rec.archivedAt = null;
        pStore.put(rec);
        tx.objectStore('activity').add({
          id: uuid(),
          type: 'unarchive',
          message: 'Архивация отменена: ' + (rec.name || rec.email),
          createdAt: new Date().toISOString(),
          participantId: id
        });
        return txPromise(tx).then(function () { return rec; });
      });
    });
  }

  function getSetting(key) {
    return openDb().then(function (db) {
      var tx = db.transaction('settings', 'readonly');
      return reqPromise(tx.objectStore('settings').get(key));
    });
  }

  function setSetting(key, value) {
    return openDb().then(function (db) {
      var tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({ key: key, value: value });
      return txPromise(tx);
    });
  }

  function ensureSeedEvent() {
    return getSetting('event').then(function (existing) {
      if (!existing) {
        return setSetting('event', {
          name: 'Практикум «Продукты с ИИ»',
          venue: 'Учебный центр',
          capacity: 120
        });
      }
    }).then(function () {
      return getSetting('event');
    }).then(function (ev) {
      return ev ? ev.value : null;
    });
  }

  function addActivity(entry) {
    return openDb().then(function (db) {
      var tx = db.transaction('activity', 'readwrite');
      tx.objectStore('activity').add(entry);
      return txPromise(tx);
    });
  }

  function listActivity(limit) {
    if (typeof limit === 'undefined') limit = 30;
    return openDb().then(function (db) {
      var tx = db.transaction('activity', 'readonly');
      return reqPromise(tx.objectStore('activity').getAll()).then(function (rows) {
        rows = rows || [];
        rows.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
        return limit ? rows.slice(0, limit) : rows;
      });
    });
  }

  function replaceAllData(data) {
    var participants = data.participants || [];
    var activity = data.activity || [];
    var event = data.event;
    return openDb().then(function (db) {
      var tx = db.transaction(['participants', 'settings', 'activity'], 'readwrite');
      tx.objectStore('participants').clear();
      tx.objectStore('activity').clear();
      for (var i = 0; i < participants.length; i++) tx.objectStore('participants').add(participants[i]);
      for (var j = 0; j < activity.length; j++) tx.objectStore('activity').put(activity[j]);
      if (event) tx.objectStore('settings').put({ key: 'event', value: event });
      return txPromise(tx);
    });
  }

  window.EventFlowDB = {
    uuid: uuid,
    openDb: openDb,
    getAllParticipants: getAllParticipants,
    getParticipant: getParticipant,
    bulkAddParticipants: bulkAddParticipants,
    saveWithActivity: saveWithActivity,
    archiveParticipant: archiveParticipant,
    unarchiveParticipant: unarchiveParticipant,
    getSetting: getSetting,
    setSetting: setSetting,
    ensureSeedEvent: ensureSeedEvent,
    addActivity: addActivity,
    listActivity: listActivity,
    replaceAllData: replaceAllData
  };
})();
