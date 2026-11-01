/* Lokaler Ersatz für Claudes Artefakt-Speicher.
   Stellt window.claude.use('db') und window.claude.use('downloads') bereit, gespeichert in IndexedDB auf dem Gerät.
   Dazu: Komplett-Sicherung (JSON) und Wiederherstellung aus JSON oder aus dem CSV-Export der alten Version. */
(function () {
  'use strict';
  var DB_NAME = 'haushaltsbuch', STORE = 'docs';
  var cache = null;            // Map path -> data
  var ready = null;
  var listeners = [];          // {kind:'col'|'doc', path, cb}

  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB nicht verfügbar')); return; }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  var idb = null;
  function load() {
    if (ready) return ready;
    ready = openDb().then(function (db) {
      idb = db;
      return new Promise(function (resolve, reject) {
        var out = new Map();
        var t = db.transaction(STORE, 'readonly'), s = t.objectStore(STORE);
        var req = s.openCursor();
        req.onsuccess = function () {
          var c = req.result;
          if (c) { out.set(String(c.key), c.value); c.continue(); } else { cache = out; resolve(); }
        };
        req.onerror = function () { reject(req.error); };
      });
    });
    return ready;
  }
  function persist(ops) { // ops: [{path, data|null}]
    return new Promise(function (resolve, reject) {
      var t = idb.transaction(STORE, 'readwrite'), s = t.objectStore(STORE);
      ops.forEach(function (o) { if (o.data == null) s['delete'](o.path); else s.put(o.data, o.path); });
      t.oncomplete = function () { resolve(); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error('abort')); };
    });
  }

  function colSnap(col) {
    var docs = [];
    cache.forEach(function (v, k) {
      var i = k.indexOf('/');
      if (k.slice(0, i) === col) docs.push({ id: k.slice(i + 1), data: (function (val) { return function () { return clone(val); }; })(v) });
    });
    return { docs: docs, size: docs.length, empty: !docs.length };
  }
  function docSnap(path) {
    var v = cache.get(path);
    return { id: path.split('/').pop(), exists: v !== undefined, data: function () { return v === undefined ? undefined : clone(v); } };
  }
  var pending = false;
  function notify() {
    if (pending) return; pending = true;
    Promise.resolve().then(function () {
      pending = false;
      listeners.slice().forEach(function (l) {
        try { l.cb(l.kind === 'col' ? colSnap(l.path) : docSnap(l.path)); } catch (e) { console.error(e); }
      });
    });
  }
  async function write(ops) {
    await load();
    ops.forEach(function (o) { if (o.data == null) cache.delete(o.path); else cache.set(o.path, clone(o.data)); });
    notify();
    await persist(ops);
  }
  function listen(kind, path, cb, err) {
    var l = { kind: kind, path: path, cb: cb };
    listeners.push(l);
    load().then(function () { cb(kind === 'col' ? colSnap(path) : docSnap(path)); }, function (e) { if (err) err({ code: 'unavailable', message: String(e) }); });
    return function () { var i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
  }

  var db = {
    collection: function (name) {
      return {
        onSnapshot: function (cb, err) { return listen('col', name, cb, err); },
        doc: function (id) { return db.doc(name + '/' + id); },
        get: function () { return load().then(function () { return colSnap(name); }); }
      };
    },
    doc: function (path) {
      return {
        set: function (data) { return write([{ path: path, data: data }]); },
        update: function (data) { return load().then(function () { return write([{ path: path, data: Object.assign({}, cache.get(path) || {}, data) }]); }); },
        'delete': function () { return write([{ path: path, data: null }]); },
        onSnapshot: function (cb, err) { return listen('doc', path, cb, err); },
        get: function () { return load().then(function () { return docSnap(path); }); }
      };
    }
  };

  /* ---------- Dateien ausgeben ---------- */
  async function saveFile(filename, data, type) {
    var blob = new Blob([data], { type: type || 'text/plain;charset=utf-8' });
    try {
      var file = new File([blob], filename, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
    } catch (e) { if (e && e.name === 'AbortError') { var c = new Error('cancelled'); c.code = 'cancelled'; throw c; } }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }
  var downloads = {
    save: function (o) {
      var type = /\.csv$/i.test(o.filename) ? 'text/csv;charset=utf-8' : /\.json$/i.test(o.filename) ? 'application/json' : 'text/plain;charset=utf-8';
      return saveFile(o.filename, o.data, type);
    }
  };

  window.claude = {
    use: function (name) {
      if (name === 'db') return load().then(function () { return db; });
      if (name === 'downloads') return Promise.resolve(downloads);
      return Promise.resolve(null);
    }
  };

  /* ---------- Sicherung & Wiederherstellung ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function msg(t, bad) {
    var el = document.getElementById('sichMsg');
    if (el) { el.textContent = t; el.style.color = bad ? 'var(--out)' : ''; }
  }

  async function backup() {
    await load();
    var docs = {};
    cache.forEach(function (v, k) { docs[k] = v; });
    var n = 0; Object.keys(docs).forEach(function (k) { if (k.indexOf('monate/') === 0 && docs[k] && Array.isArray(docs[k].items)) n += docs[k].items.length; });
    try {
      await saveFile('Haushaltsbuch-Sicherung-' + today() + '.json', JSON.stringify({ app: 'haushaltsbuch', format: 1, erstellt: new Date().toISOString(), docs: docs }), 'application/json');
      msg('Sicherung erstellt: ' + n.toLocaleString('de-DE') + ' Buchungen plus Einstellungen.');
    } catch (e) { if (!e || e.code !== 'cancelled') msg('Sicherung nicht möglich.', true); }
  }

  function key(it) { return [it.d, it.t, it.c, it.a, it.z || '', it.k || '', it.n || ''].join('|'); }
  function rid() { return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  async function restoreJson(obj) {
    if (!obj || typeof obj.docs !== 'object') throw new Error('Keine Sicherungsdatei des Haushaltsbuchs.');
    await load();
    var ops = [], months = 0, items = 0, settings = 0;
    Object.keys(obj.docs).forEach(function (path) {
      if (!/^(monate|einstellungen)\/[^/]+$/.test(path)) return;
      var data = obj.docs[path];
      if (path.indexOf('monate/') === 0) {
        if (!data || !Array.isArray(data.items)) return;
        // mit vorhandenen Buchungen zusammenführen, Dubletten (gleiche id oder gleicher Inhalt) überspringen
        var cur = (cache.get(path) || { items: [] }).items.slice();
        var ids = new Set(cur.map(function (i) { return i.id; })), keys = new Set(cur.map(key));
        data.items.forEach(function (it) { if (!ids.has(it.id) && !keys.has(key(it))) { cur.push(it); items++; } });
        cur.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
        ops.push({ path: path, data: { items: cur } }); months++;
      } else { ops.push({ path: path, data: data }); settings++; }
    });
    if (!ops.length) throw new Error('Die Datei enthält keine Daten.');
    await write(ops);
    return items.toLocaleString('de-DE') + ' Buchungen' + (settings ? ' und ' + settings + ' Einstellungsbereiche' : '') + ' übernommen.';
  }

  function splitLine(line) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true; else if (c === ';') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur); return out;
  }
  async function restoreCsv(text) {
    text = text.replace(/^﻿/, '');
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (!lines.length || !/^Datum;Art;Betrag;Kategorie;Konto/i.test(lines[0].replace(/"/g, ''))) throw new Error('Unbekanntes CSV-Format. Erwartet wird der CSV-Export des Haushaltsbuchs.');
    await load();
    var byMonth = {}, bad = 0, added = 0, dup = 0;
    var art = { 'Ausgabe': 'A', 'Einnahme': 'E', 'Umbuchung': 'U' };
    for (var i = 1; i < lines.length; i++) {
      var c = splitLine(lines[i]);
      var m = /^(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/.exec((c[0] || '').trim());
      if (m && m[3].length === 2) m[3] = '20' + m[3];
      var t = art[(c[1] || '').trim()];
      var amt = Math.round(Math.abs(parseFloat((c[2] || '').replace(/\./g, '').replace(',', '.'))) * 100);
      var a = (c[4] || '').trim();
      if (!m || !t || !isFinite(amt) || !amt || !a) { bad++; continue; }
      var it = { a: a, c: amt, d: m[3] + '-' + m[2] + '-' + m[1], id: rid() + i, k: (c[3] || '').trim(), t: t };
      if ((c[5] || '').trim()) it.z = c[5].trim();
      if ((c[6] || '').trim()) it.n = c[6].trim();
      var mk = 'monate/' + it.d.slice(0, 7);
      if (!byMonth[mk]) {
        var cur = (cache.get(mk) || { items: [] }).items.slice();
        byMonth[mk] = { items: cur, keys: new Set(cur.map(key)) };
      }
      var b = byMonth[mk];
      if (b.keys.has(key(it))) { dup++; continue; }
      b.keys.add(key(it)); b.items.push(it); added++;
    }
    var ops = Object.keys(byMonth).map(function (p) {
      var items = byMonth[p].items.sort(function (x, y) { return x.d < y.d ? -1 : x.d > y.d ? 1 : 0; });
      return { path: p, data: { items: items } };
    });
    if (ops.length) await write(ops);
    return added.toLocaleString('de-DE') + ' Buchungen übernommen' + (dup ? ', ' + dup + ' Dubletten übersprungen' : '') + (bad ? ', ' + bad + ' Zeilen nicht lesbar' : '') + '.';
  }

  async function restoreFile(file) {
    if (!file) return;
    msg('Lese ' + file.name + ' …');
    try {
      var text = await file.text();
      var res;
      if (/^\s*\{/.test(text)) res = await restoreJson(JSON.parse(text));
      else res = await restoreCsv(text);
      msg(res);
    } catch (e) { msg('Wiederherstellung fehlgeschlagen: ' + (e && e.message || e), true); }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('sichBackup'), r = document.getElementById('sichRestore'), f = document.getElementById('sichFile');
    if (b) b.addEventListener('click', backup);
    if (r && f) {
      r.addEventListener('click', function () { f.click(); });
      f.addEventListener('change', function () { restoreFile(f.files && f.files[0]).then(function () { f.value = ''; }); });
    }
  });

  /* ---------- Tageswechsel ----------
     iOS setzt Home-Bildschirm-Apps beim erneuten Öffnen fort, statt sie neu zu laden.
     Datum im Formular und automatische Fixkosten-Buchungen werden aber nur beim Laden berechnet.
     Deshalb: Hat seit dem Laden ein neuer Tag begonnen, wird die App neu geladen. Die Daten liegen sicher in IndexedDB. */
  var loadedDay = today();
  function busyTyping() {
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
    var b = document.getElementById('fBetrag');
    return !!(b && b.value.trim());
  }
  function checkDay() {
    if (document.visibilityState === 'hidden') return;
    if (today() !== loadedDay && !busyTyping()) location.reload();
  }
  document.addEventListener('visibilitychange', checkDay);
  window.addEventListener('pageshow', checkDay);
  window.addEventListener('focus', checkDay);
  setInterval(checkDay, 60000);

  if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist(); } catch (e) {} }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
