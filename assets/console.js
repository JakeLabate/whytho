/* WhyTho console
   Account, library, and exports. Notes live in Postgres behind row level security,
   so an account only ever sees its own rows. */
(function () {
  'use strict';

  var CFG = window.WHY_CONFIG;
  var LOCAL_KEY = 'why:console:v1';
  var CATEGORY_LABELS = { seo: 'SEO', content: 'Content', tech: 'Technical', a11y: 'Accessibility', perf: 'Performance', ux: 'UX' };
  var CATEGORY_COLORS = { seo: '#5b21b6', content: '#0f766e', tech: '#b45309', a11y: '#be123c', perf: '#1d4ed8', ux: '#7c2d12' };

  var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.publishableKey);
  var user = null;
  var token = null;
  var current = null;      // { page, notes }

  var $ = function (s) { return document.querySelector(s); };

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
    toast._t = setTimeout(function () { t.hidden = true; }, 3400);
  }

  function fromRow(r) {
    return {
      id: r.client_id, selector: r.selector, fallbackSelector: r.fallback_selector,
      tag: r.tag, textSnippet: r.text_snippet, category: r.category, status: r.status,
      body: r.body, author: r.author, viewport: r.viewport || {}, createdAt: r.created_at
    };
  }

  /* ---------- local store, kept for imports and for signed out use ---------- */

  function localDb() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || { pages: [] }; }
    catch (e) { return { pages: [] }; }
  }
  function saveLocal(db) {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(db)); }
    catch (e) { toast('This browser refused to store the notes.'); }
  }
  function pageId(p) { return (p.origin || '') + (p.path || ''); }

  function mergeLocal(incoming) {
    var db = localDb(), added = 0;
    (incoming.pages || []).forEach(function (page) {
      if (!page || !page.notes) return;
      var existing = null;
      db.pages.forEach(function (p) { if (pageId(p) === pageId(page)) existing = p; });
      if (!existing) { db.pages.push(page); added += page.notes.length; return; }
      existing.updatedAt = page.updatedAt || existing.updatedAt;
      page.notes.forEach(function (n) {
        var hit = -1;
        existing.notes.forEach(function (e, i) { if (e.id === n.id) hit = i; });
        if (hit > -1) existing.notes[hit] = n; else { existing.notes.push(n); added++; }
      });
    });
    saveLocal(db);
    if (user) uploadLocal(); else renderLibrary();
    toast(added + ' note' + (added === 1 ? '' : 's') + ' imported.');
  }

  /* ---------- account ---------- */

  function randomToken() {
    var a = new Uint8Array(24);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function ensureToken() {
    return sb.from('why_tokens').select('token').eq('revoked', false).limit(1)
      .then(function (res) {
        if (res.data && res.data.length) { token = res.data[0].token; return token; }
        var t = randomToken();
        return sb.from('why_tokens').insert({ token: t, user_id: user.id, label: 'bookmarklet' })
          .then(function () { token = t; return t; });
      });
  }

  function bookmarkletCode() {
    var src = CFG.consoleUrl.replace(/\/$/, '') + '/assets/annotator.js';
    var t = token || '';
    return "javascript:(function(){if(window.__why__){window.__why__.toggle();return}" +
      "var s=document.createElement('script');s.src='" + src + "?t='+Date.now();" +
      (t ? "s.setAttribute('data-why-token','" + t + "');" : "") +
      "document.body.appendChild(s)})()";
  }

  function renderAccount() {
    var box = $('#account-box');
    if (user) {
      box.innerHTML =
        '<div class="acct-row"><div><b>' + esc(user.email) + '</b><br>' +
        '<span class="sub">Notes on this account save from any browser you use.</span></div>' +
        '<button class="btn quiet small" id="signout">Sign out</button></div>';
      $('#signout').addEventListener('click', function () {
        sb.auth.signOut().then(function () { location.reload(); });
      });
    } else {
      box.innerHTML =
        '<button class="btn oauth" type="button" id="github">Continue with GitHub</button>' +
        '<div class="or"><span>or use an email address</span></div>' +
        '<form class="auth" id="auth-form">' +
        '<input type="email" id="email" placeholder="you@company.com" autocomplete="email" required>' +
        '<input type="password" id="password" placeholder="Password, 8 characters or more" autocomplete="current-password" minlength="8">' +
        '<div class="auth-actions">' +
        '<button class="btn small" type="submit" id="signin">Sign in</button>' +
        '<button class="btn quiet small" type="button" id="signup">Create account</button>' +
        '<button class="btn quiet small" type="button" id="magic">Email me a link</button>' +
        '</div><p class="sub" id="auth-msg">Without an account, notes stay in this browser. If you have signed in to another of these apps with GitHub, use that button and skip the password.</p>' +
        '<p class="sub note-small">If GitHub sends you to a different app, this domain is not in the Supabase redirect allowlist yet.</p></form>';

      $('#github').addEventListener('click', function () {
        sb.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: CFG.consoleUrl } })
          .then(function (res) { if (res.error) toast(res.error.message); });
      });
      $('#auth-form').addEventListener('submit', function (e) { e.preventDefault(); doAuth('in'); });
      $('#signup').addEventListener('click', function () { doAuth('up'); });
      $('#magic').addEventListener('click', function () { doAuth('magic'); });
    }
    renderSetup();
  }

  function doAuth(kind) {
    var email = $('#email').value.trim(), password = $('#password').value;
    var msg = $('#auth-msg');
    if (!email) { toast('Enter your email address.'); return; }

    if (kind === 'magic') {
      sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: CFG.consoleUrl } })
        .then(function (res) {
          if (res.error) { msg.textContent = res.error.message; return; }
          msg.textContent = 'Sign in link sent to ' + email + '. It works once and expires in an hour.';
        });
      return;
    }

    if (password.length < 8) { toast('Passwords need at least 8 characters.'); return; }

    var call = kind === 'up'
      ? sb.auth.signUp({ email: email, password: password, options: { emailRedirectTo: CFG.consoleUrl } })
      : sb.auth.signInWithPassword({ email: email, password: password });

    call.then(function (res) {
      if (res.error) {
        // A wrong password and an account with no password look the same from here,
        // so say what to try rather than repeating the server wording.
        msg.textContent = res.error.message.indexOf('Invalid login credentials') > -1
          ? 'That email and password did not match. If you created this account with GitHub, there is no password on it. Use Continue with GitHub, or email yourself a link.'
          : res.error.message;
        return;
      }
      // Supabase answers a repeat signup with a 200 and an empty identity list, and
      // sends no email. Without this check the page would tell you to wait for one.
      var u = res.data && res.data.user;
      if (kind === 'up' && u && Array.isArray(u.identities) && u.identities.length === 0) {
        msg.textContent = 'That email already has an account. Sign in instead, or email yourself a link if you do not have a password.';
        return;
      }
      if (kind === 'up' && u && !res.data.session) {
        msg.textContent = 'Check your email to confirm the account, then sign in.';
        return;
      }
      boot();
    });
  }

  function renderSetup() {
    var bm = $('#bookmarklet');
    bm.setAttribute('href', bookmarkletCode());
    $('#bookmarklet-state').textContent = user && token
      ? 'This bookmarklet is tied to your account. Notes you take with it save to ' + user.email + '.'
      : 'Sign in first and this bookmarklet will carry your account with it. Right now it saves notes in the browser only.';
    $('#snippet').textContent = '<script src="' + CFG.consoleUrl.replace(/\/$/, '') + '/assets/annotator.js"' +
      (token ? ' data-why-token="' + token + '"' : '') + ' defer><\/script>';
  }

  /* ---------- library ---------- */

  function renderLibrary() {
    var wrap = $('#library-list');
    if (!user) {
      var db = localDb();
      wrap.innerHTML = '';
      if (!db.pages.length) {
        wrap.innerHTML = '<div class="blank">Nothing here yet. Sign in above to save notes to your account, or annotate a page and choose <b>Send to console</b> to keep them in this browser.</div>';
        return;
      }
      db.pages.forEach(function (p) { wrap.appendChild(row(p.path, p.origin, p.notes.length, p.updatedAt, function () { openLocal(pageId(p)); })); });
      var cta = document.createElement('div');
      cta.className = 'blank';
      cta.innerHTML = 'These notes are in this browser only. Sign in and they move to your account.';
      wrap.appendChild(cta);
      return;
    }

    wrap.innerHTML = '<div class="blank">Loading your pages.</div>';
    sb.from('why_pages').select('*').order('updated_at', { ascending: false }).then(function (res) {
      if (res.error) { wrap.innerHTML = '<div class="blank">' + esc(res.error.message) + '</div>'; return; }
      var pages = res.data || [];
      if (!pages.length) {
        wrap.innerHTML = '<div class="blank">No pages yet. Run the bookmarklet on a page, leave a note, and it lands here.</div>';
        maybeOfferUpload();
        return;
      }
      sb.from('why_notes').select('page_id').is('deleted_at', null).then(function (nres) {
        var counts = {};
        (nres.data || []).forEach(function (n) { counts[n.page_id] = (counts[n.page_id] || 0) + 1; });
        wrap.innerHTML = '';
        pages.forEach(function (p) {
          wrap.appendChild(row(p.path, p.origin, counts[p.id] || 0, p.updated_at, function () { openCloud(p); }));
        });
        maybeOfferUpload();
      });
    });
  }

  function row(path, origin, count, updated, onClick) {
    var b = document.createElement('button');
    b.className = 'page-row';
    b.innerHTML =
      '<span class="dot"></span>' +
      '<span><span class="path">' + esc(path || '/') + '</span><br><span class="host">' +
      esc(String(origin || '').replace(/^https?:\/\//, '')) + '</span></span>' +
      '<span class="count">' + count + ' note' + (count === 1 ? '' : 's') +
      (updated ? ' &middot; ' + esc(new Date(updated).toLocaleDateString()) : '') + '</span>';
    b.addEventListener('click', onClick);
    return b;
  }

  function maybeOfferUpload() {
    var db = localDb();
    if (!db.pages.length || !user) return;
    var n = db.pages.reduce(function (a, p) { return a + p.notes.length; }, 0);
    var el = document.createElement('div');
    el.className = 'blank';
    el.innerHTML = n + ' note' + (n === 1 ? '' : 's') + ' from this browser are not on your account yet. ' +
      '<button class="btn small" id="upload-local">Move them to my account</button>';
    $('#library-list').appendChild(el);
    $('#upload-local').addEventListener('click', uploadLocal);
  }

  function uploadLocal() {
    var db = localDb();
    if (!db.pages.length) return;
    var jobs = db.pages.map(function (p) {
      return sb.from('why_pages').upsert(
        { user_id: user.id, origin: p.origin, path: p.path, url: p.url, title: p.title },
        { onConflict: 'user_id,origin,path' }
      ).select('id').single().then(function (res) {
        if (res.error || !res.data) return;
        var rows = p.notes.map(function (n) {
          return {
            page_id: res.data.id, user_id: user.id, client_id: n.id, selector: n.selector,
            fallback_selector: n.fallbackSelector || null, tag: n.tag || null,
            text_snippet: n.textSnippet || null, category: n.category || 'seo',
            status: n.status || 'decided', body: n.body, author: n.author || null,
            viewport: n.viewport || {}, created_at: n.createdAt || new Date().toISOString(), deleted_at: null
          };
        });
        if (!rows.length) return;
        return sb.from('why_notes').upsert(rows, { onConflict: 'user_id,client_id' });
      });
    });
    Promise.all(jobs).then(function () {
      localStorage.removeItem(LOCAL_KEY);
      toast('Local notes moved to your account.');
      renderLibrary();
    });
  }

  /* ---------- viewer ---------- */

  function showViewer(title, url, notes, onDelete) {
    $('#viewer-title').textContent = title || 'Page';
    $('#viewer-url').innerHTML = url ? '<a href="' + esc(url) + '" rel="noopener">' + esc(url) + '</a>' : '';
    var wrap = $('#viewer-notes');
    wrap.innerHTML = '';
    notes.forEach(function (n, i) {
      var d = document.createElement('div');
      d.className = 'note';
      d.style.borderLeftColor = CATEGORY_COLORS[n.category] || '#5b21b6';
      var vp = n.viewport && n.viewport.width ? n.viewport.breakpoint + ' ' + n.viewport.width + 'px' : 'viewport not recorded';
      d.innerHTML =
        '<div class="top"><b>' + (i + 1) + '</b><span>' + esc(CATEGORY_LABELS[n.category] || n.category) + '</span>' +
        '<span>' + esc(n.status || '') + '</span><span>' + esc(vp) + '</span></div>' +
        '<div class="body">' + esc(n.body) + '</div><code>' + esc(n.selector) + '</code>' +
        '<div class="top" style="margin-top:10px"><span>' + esc(n.author || 'unattributed') + '</span>' +
        '<span>' + esc(n.createdAt ? new Date(n.createdAt).toLocaleString() : '') + '</span></div>';
      wrap.appendChild(d);
    });
    $('#viewer').hidden = false;
    current = { title: title, url: url, notes: notes, remove: onDelete };
    if ($('#viewer').scrollIntoView) $('#viewer').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openLocal(id) {
    var db = localDb(), p = null;
    db.pages.forEach(function (x) { if (pageId(x) === id) p = x; });
    if (!p) return;
    showViewer(p.title || p.path, p.url, p.notes, function () {
      var d = localDb();
      d.pages = d.pages.filter(function (x) { return pageId(x) !== id; });
      saveLocal(d); $('#viewer').hidden = true; renderLibrary(); toast('Page removed.');
    });
  }

  function openCloud(page) {
    sb.from('why_notes').select('*').eq('page_id', page.id).is('deleted_at', null)
      .order('created_at', { ascending: true })
      .then(function (res) {
        if (res.error) { toast(res.error.message); return; }
        showViewer(page.title || page.path, page.url, (res.data || []).map(fromRow), function () {
          sb.from('why_pages').delete().eq('id', page.id).then(function () {
            $('#viewer').hidden = true; renderLibrary(); toast('Page deleted from your account.');
          });
        });
      });
  }

  /* ---------- exports ---------- */

  function toMarkdown(c) {
    var out = ['# Why this page is built this way', '', c.title ? '**' + c.title + '**' : '', c.url || '', ''];
    c.notes.forEach(function (n, i) {
      var vp = n.viewport && n.viewport.width ? n.viewport.breakpoint + ' at ' + n.viewport.width + 'px' : 'viewport not recorded';
      out.push('## ' + (i + 1) + '. ' + (CATEGORY_LABELS[n.category] || n.category) + ', ' + (n.status || ''), '',
        '`' + n.selector + '`', '', n.body, '',
        'Recorded by ' + (n.author || 'unattributed') + ', ' + vp +
        (n.createdAt ? ', ' + new Date(n.createdAt).toLocaleDateString() : '') + '.', '');
    });
    return out.join('\n');
  }

  function toCSV(c) {
    var rows = [['index', 'selector', 'category', 'status', 'note', 'author', 'breakpoint', 'viewport_width', 'created_at', 'url']];
    c.notes.forEach(function (n, i) {
      rows.push([i + 1, n.selector, n.category, n.status, n.body, n.author || '',
      n.viewport ? n.viewport.breakpoint : '', n.viewport ? n.viewport.width : '',
      n.createdAt || '', c.url || '']);
    });
    return rows.map(function (r) {
      return r.map(function (x) { return '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"'; }).join(',');
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
    try { document.execCommand('copy'); toast(label + ' copied.'); } catch (e) { toast('Copy failed in this browser.'); }
    ta.remove();
  }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------- hash import from the annotator ---------- */

  function decodeHash() {
    var m = location.hash.match(/#import=(.+)$/);
    if (!m) return;
    var parsed = null;
    try {
      var b = m[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      parsed = JSON.parse(decodeURIComponent(escape(atob(b))));
    } catch (e) { toast('That import link could not be read.'); return; }
    mergeLocal(parsed);
    history.replaceState(null, '', location.pathname + '#library');
  }

  /* ---------- boot ---------- */

  function boot() {
    sb.auth.getUser().then(function (res) {
      user = (res.data && res.data.user) || null;
      if (user) {
        ensureToken().then(function () { renderAccount(); renderLibrary(); });
      } else {
        token = null; renderAccount(); renderLibrary();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('#bookmarklet').addEventListener('click', function (e) {
      e.preventDefault();
      toast('Drag this to your bookmarks bar, or copy the code.');
    });
    $('#copy-bookmarklet').addEventListener('click', function () { copy(bookmarkletCode(), 'Bookmarklet'); });
    $('#copy-snippet').addEventListener('click', function () { copy($('#snippet').textContent, 'Script tag'); });

    $('#import-btn').addEventListener('click', function () {
      var raw = $('#import-text').value.trim();
      if (!raw) { toast('Paste an export first.'); return; }
      try { mergeLocal(JSON.parse(raw)); $('#import-text').value = ''; }
      catch (e) { toast('That is not valid WhyTho JSON.'); }
    });

    $('#viewer-close').addEventListener('click', function () {
      $('#viewer').hidden = true;
      var lib = document.getElementById('library');
      if (lib && lib.scrollIntoView) lib.scrollIntoView({ behavior: 'smooth' });
    });
    $('#viewer-delete').addEventListener('click', function () { if (current && current.remove) current.remove(); });

    document.querySelectorAll('[data-export]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!current) return;
        var kind = btn.getAttribute('data-export');
        var stem = 'why-' + String(current.url || 'page').replace(/^https?:\/\//, '').replace(/[^\w.-]/g, '-');
        if (kind === 'json') copy(JSON.stringify({ schema: 'why/1', pages: [{ url: current.url, title: current.title, notes: current.notes }] }, null, 2), 'JSON');
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
        try { mergeLocal(JSON.parse(r.result)); } catch (err) { toast('That file is not a WhyTho export.'); }
      };
      r.readAsText(f);
    });

    sb.auth.onAuthStateChange(function (evt) {
      if (evt === 'SIGNED_IN' || evt === 'SIGNED_OUT') boot();
    });

    boot();
    decodeHash();
    window.addEventListener('hashchange', decodeHash);
  });
})();
