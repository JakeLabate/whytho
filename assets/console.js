/* Why console
   Receives note sets from the annotator, stores them in this browser, exports them. */
(function () {
  'use strict';

  var KEY = 'why:console:v1';
  var ORIGIN = location.origin === 'null' ? 'https://why.jakelabate.com' : location.origin;
  var SRC = ORIGIN.replace(/\/$/, '') + '/assets/annotator.js';
  var BOOKMARKLET = "javascript:(function(){if(window.__why__){window.__why__.toggle();return}var s=document.createElement('script');s.src='" + SRC + "?t='+Date.now();document.body.appendChild(s)})()";

  var CATEGORY_LABELS = { seo: 'SEO', content: 'Content', tech: 'Technical', a11y: 'Accessibility', perf: 'Performance', ux: 'UX' };
  var CATEGORY_COLORS = { seo: '#5b21b6', content: '#0f766e', tech: '#b45309', a11y: '#be123c', perf: '#1d4ed8', ux: '#7c2d12' };

  var $ = function (s) { return document.querySelector(s); };
  var current = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 2800);
  }

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || { pages: [] }; }
    catch (e) { return { pages: [] }; }
  }

  function save(db) {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { toast('This browser refused to store the notes. Export them to a file instead.'); }
  }

  function pageId(p) { return (p.origin || '') + (p.path || ''); }

  function merge(incoming) {
    var db = load();
    var added = 0, updated = 0;
    (incoming.pages || []).forEach(function (page) {
      if (!page || !page.notes) return;
      var existing = null;
      db.pages.forEach(function (p) { if (pageId(p) === pageId(page)) existing = p; });
      if (!existing) {
        db.pages.push(page);
        added += page.notes.length;
        return;
      }
      existing.title = page.title || existing.title;
      existing.url = page.url || existing.url;
      existing.updatedAt = page.updatedAt || existing.updatedAt;
      page.notes.forEach(function (n) {
        var hit = -1;
        existing.notes.forEach(function (e, i) { if (e.id === n.id) hit = i; });
        if (hit > -1) { existing.notes[hit] = n; updated++; }
        else { existing.notes.push(n); added++; }
      });
    });
    save(db);
    renderLibrary();
    toast(added + ' note' + (added === 1 ? '' : 's') + ' imported' + (updated ? ', ' + updated + ' updated' : '') + '.');
  }

  function decodeHash() {
    var m = location.hash.match(/#import=(.+)$/);
    if (!m) return;
    var parsed = null;
    try {
      var b = m[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      parsed = JSON.parse(decodeURIComponent(escape(atob(b))));
    } catch (e) {
      toast('That import link could not be read.');
      return;
    }
    merge(parsed);
    history.replaceState(null, '', location.pathname + '#library');
    var lib = document.getElementById('library');
    if (lib && lib.scrollIntoView) lib.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- library ---------- */

  function renderLibrary() {
    var db = load();
    var wrap = $('#library-list');
    wrap.innerHTML = '';
    if (!db.pages.length) {
      wrap.innerHTML = '<div class="blank">Nothing here yet. Annotate a page, then choose <b>Send to console</b> in the Why toolbar and the notes land in this list.</div>';
      return;
    }
    db.pages
      .slice()
      .sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); })
      .forEach(function (p) {
        var row = document.createElement('button');
        row.className = 'page-row';
        row.innerHTML =
          '<span class="dot"></span>' +
          '<span><span class="path">' + esc(p.path || '/') + '</span><br><span class="host">' + esc((p.origin || '').replace(/^https?:\/\//, '')) + '</span></span>' +
          '<span class="count">' + p.notes.length + ' note' + (p.notes.length === 1 ? '' : 's') +
          (p.updatedAt ? ' &middot; ' + esc(new Date(p.updatedAt).toLocaleDateString()) : '') + '</span>';
        row.addEventListener('click', function () { openPage(pageId(p)); });
        wrap.appendChild(row);
      });
  }

  /* ---------- viewer ---------- */

  function openPage(id) {
    var db = load();
    current = null;
    db.pages.forEach(function (p) { if (pageId(p) === id) current = p; });
    if (!current) return;

    $('#viewer-title').textContent = current.title || current.path || 'Page';
    var urlEl = $('#viewer-url');
    urlEl.innerHTML = '<a href="' + esc(current.url) + '" rel="noopener">' + esc(current.url) + '</a>';

    var notes = $('#viewer-notes');
    notes.innerHTML = '';
    current.notes.forEach(function (n, i) {
      var d = document.createElement('div');
      d.className = 'note';
      d.style.borderLeftColor = CATEGORY_COLORS[n.category] || '#5b21b6';
      var vp = n.viewport ? n.viewport.breakpoint + ' ' + n.viewport.width + 'px' : 'viewport not recorded';
      d.innerHTML =
        '<div class="top"><b>' + (i + 1) + '</b><span>' + esc(CATEGORY_LABELS[n.category] || n.category) + '</span>' +
        '<span>' + esc(n.status || '') + '</span><span>' + esc(vp) + '</span></div>' +
        '<div class="body">' + esc(n.body) + '</div>' +
        '<code>' + esc(n.selector) + '</code>' +
        '<div class="top" style="margin-top:10px"><span>' + esc(n.author || 'unattributed') + '</span>' +
        '<span>' + esc(n.createdAt ? new Date(n.createdAt).toLocaleString() : '') + '</span></div>';
      notes.appendChild(d);
    });

    $('#viewer').hidden = false;
    if ($('#viewer').scrollIntoView) $('#viewer').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- exports ---------- */

  function toMarkdown(p) {
    var out = ['# Why this page is built this way', '', p.title ? '**' + p.title + '**' : '', p.url, '', '' ];
    p.notes.forEach(function (n, i) {
      var vp = n.viewport ? n.viewport.breakpoint + ' at ' + n.viewport.width + 'px' : 'viewport not recorded';
      out.push('## ' + (i + 1) + '. ' + (CATEGORY_LABELS[n.category] || n.category) + ', ' + (n.status || ''));
      out.push('');
      out.push('`' + n.selector + '`');
      out.push('');
      out.push(n.body);
      out.push('');
      out.push('Recorded by ' + (n.author || 'unattributed') + ', ' + vp + (n.createdAt ? ', ' + new Date(n.createdAt).toLocaleDateString() : '') + '.');
      out.push('');
    });
    return out.join('\n');
  }

  function toCSV(p) {
    var rows = [['index', 'selector', 'category', 'status', 'note', 'author', 'breakpoint', 'viewport_width', 'created_at', 'url']];
    p.notes.forEach(function (n, i) {
      rows.push([
        i + 1, n.selector, n.category, n.status, n.body, n.author || '',
        n.viewport ? n.viewport.breakpoint : '', n.viewport ? n.viewport.width : '',
        n.createdAt || '', p.url || ''
      ]);
    });
    return rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
  }

  function copy(text, label) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(label + ' copied.'); }, function () { fallback(text, label); });
    } else fallback(text, label);
  }

  function fallback(text, label) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(label + ' copied.'); }
    catch (e) { toast('Copy failed in this browser.'); }
    ta.remove();
  }

  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------- wiring ---------- */

  document.addEventListener('DOMContentLoaded', function () {
    var bm = $('#bookmarklet');
    bm.setAttribute('href', BOOKMARKLET);
    bm.addEventListener('click', function (e) {
      e.preventDefault();
      toast('Drag this to your bookmarks bar, or copy the code below.');
    });

    $('#copy-bookmarklet').addEventListener('click', function () { copy(BOOKMARKLET, 'Bookmarklet'); });
    $('#copy-snippet').addEventListener('click', function () { copy($('#snippet').textContent, 'Script tag'); });

    $('#import-btn').addEventListener('click', function () {
      var raw = $('#import-text').value.trim();
      if (!raw) { toast('Paste an export first.'); return; }
      try { merge(JSON.parse(raw)); $('#import-text').value = ''; }
      catch (e) { toast('That is not valid Why JSON.'); }
    });

    $('#viewer-close').addEventListener('click', function () {
      $('#viewer').hidden = true;
      document.getElementById('library').scrollIntoView({ behavior: 'smooth' });
    });

    $('#viewer-delete').addEventListener('click', function () {
      if (!current) return;
      var db = load();
      db.pages = db.pages.filter(function (p) { return pageId(p) !== pageId(current); });
      save(db);
      current = null;
      $('#viewer').hidden = true;
      renderLibrary();
      toast('Page deleted from this console.');
    });

    document.querySelectorAll('[data-export]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!current) return;
        var kind = btn.getAttribute('data-export');
        var stem = 'why-' + (current.origin || '').replace(/^https?:\/\//, '').replace(/[^\w.-]/g, '-') +
          (current.path || '').replace(/[^\w.-]/g, '-');
        if (kind === 'json') copy(JSON.stringify({ schema: 'why/1', pages: [current] }, null, 2), 'JSON');
        if (kind === 'md') copy(toMarkdown(current), 'Markdown');
        if (kind === 'csv') { download(stem + '.csv', toCSV(current), 'text/csv'); toast('CSV downloaded.'); }
      });
    });

    ['dragenter', 'dragover'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); document.body.classList.add('dragging'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); document.body.classList.remove('dragging'); });
    });
    document.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try { merge(JSON.parse(r.result)); }
        catch (err) { toast('That file is not a Why export.'); }
      };
      r.readAsText(f);
    });

    renderLibrary();
    decodeHash();
    window.addEventListener('hashchange', decodeHash);
  });
})();
