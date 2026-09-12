/* WhyTho console
   Account, library, and exports. Notes live in Postgres behind row level security,
   so an account only ever sees its own rows. */
(function () {
  'use strict';

  var CFG = window.WHY_CONFIG;
  var BUILD = '5.0';
  var authProviders = null;   // filled from the project's own settings endpoint

  function loadProviders() {
    if (authProviders) return Promise.resolve(authProviders);

    // Never let this block the sign in screen from rendering. A missing or blocked
    // fetch falls back to the provider we know is configured.
    var call;
    try {
      call = fetch(CFG.supabaseUrl.replace(/\/$/, '') + '/auth/v1/settings', {
        headers: { apikey: CFG.publishableKey }
      });
    } catch (e) {
      authProviders = ['github'];
      return Promise.resolve(authProviders);
    }

    return call.then(function (r) { return r.json(); }).then(function (s) {
      var ext = (s && s.external) || {};
      authProviders = Object.keys(CFG.providers).filter(function (id) { return ext[id] === true; });
      if (!authProviders.length) authProviders = ['github'];
      return authProviders;
    }, function () {
      authProviders = ['github'];
      return authProviders;
    });
  }

  function providerButtons(prefix) {
    return (authProviders || ['github']).map(function (id) {
      return '<button class="btn oauth" type="button" data-provider="' + id + '" id="' + prefix + '-' + id + '">' +
        'Continue with ' + esc(CFG.providers[id] || id) + '</button>';
    }).join('');
  }

  function wireProviders(root, redirectTo) {
    root.querySelectorAll('[data-provider]').forEach(function (b) {
      b.addEventListener('click', function () {
        sb.auth.signInWithOAuth({
          provider: b.getAttribute('data-provider'),
          options: { redirectTo: redirectTo }
        }).then(function (res) { if (res.error) toast(res.error.message); });
      });
    });
  }
  var LOCAL_KEY = 'why:console:v1';
  var CATEGORY_LABELS = { seo: 'SEO', content: 'Content', tech: 'Technical', a11y: 'Accessibility', perf: 'Performance', ux: 'UX' };
  var CATEGORY_COLORS = { seo: '#5b21b6', content: '#0f766e', tech: '#b45309', a11y: '#be123c', perf: '#1d4ed8', ux: '#7c2d12' };

  var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.publishableKey);
  var user = null;
  var token = null;
  var profile = null;      // display name and active workspace
  var orgs = [];           // organizations this account belongs to
  var myRole = null;
  var current = null;      // { page, notes }

  var $ = function (s) { return document.querySelector(s); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function highlight(text) {
    return esc(text).replace(/@([A-Za-z0-9][A-Za-z0-9 ._-]{0,40})/g, function (whole) {
      return '<span class="tagged">' + whole + '</span>';
    });
  }

  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 3400);
  }

  var WIDTH_COLS = [
    { id: 'mobile', label: 'Mobile' },
    { id: 'tablet', label: 'Tablet' },
    { id: 'laptop', label: 'Laptop' },
    { id: 'desktop', label: 'Desktop' }
  ];
  var noteLayout = 'list';

  function scopeOf(n) {
    var a = n.appliesTo || n.applies_to;
    return (Array.isArray(a) && a.length) ? a : ['all'];
  }

  function scopeLabel(n) {
    var a = scopeOf(n);
    if (a.indexOf('all') > -1) return 'All widths';
    return a.map(function (id) {
      var hit = id;
      WIDTH_COLS.forEach(function (w) { if (w.id === id) hit = w.label; });
      return hit;
    }).join(', ') + ' only';
  }

  function fromRow(r) {
    return {
      appliesTo: Array.isArray(r.applies_to) ? r.applies_to : ['all'],
      context: r.context || {},
      shotPath: r.shot_path || null,
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
    if (user) {
      uploadLocal();
    } else {
      renderLibrary();
      toast(added + ' note' + (added === 1 ? '' : 's') + ' imported into this browser. Sign in to keep them on your account.');
    }
  }

  /* ---------- shell and routing ---------- */

  // account is reachable from the identity link in the bar, so it has no tab
  var TABS = ['notes', 'inbox', 'changes', 'workspace', 'setup', 'api', 'account'];

  function currentRoute() {
    var m = (location.hash || '').match(/^#\/([a-z]+)/);
    return m && TABS.concat(['page']).indexOf(m[1]) > -1 ? m[1] : 'notes';
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach(function (v) {
      v.hidden = v.getAttribute('data-view') !== name;
    });
    document.querySelectorAll('#tabs a').forEach(function (a) {
      var tab = a.getAttribute('data-tab');
      a.classList.toggle('on', tab === name || (name === 'page' && tab === 'notes'));
    });
    var who = $('#app-who');
    if (who) who.classList.toggle('on', name === 'account');
    if (window.scrollTo) window.scrollTo(0, 0);
  }

  function go(route) {
    if (location.hash === '#/' + route) showView(route);
    else location.hash = '#/' + route;
  }

  function route() {
    if (!user) return;
    var name = currentRoute();
    if (name === 'page' && !current) name = 'notes';
    showView(name);
  }

  function applyAuthState() {
    $('#gate').hidden = !!user;
    $('#app').hidden = !user;
    if (user) route();
  }

  function renderWho() {
    var box = $('#app-who');
    if (!user) { box.innerHTML = ''; return; }
    var org = activeOrg();
    var name = (profile && profile.display_name) || user.email;
    var initial = (name || '?').trim().charAt(0).toUpperCase();
    var avatar = profile && profile.avatar_url
      ? '<img class="who-avatar" src="' + esc(profile.avatar_url) + '" alt="">'
      : '<span class="who-avatar who-initial">' + esc(initial) + '</span>';
    box.innerHTML = '<a class="who" href="#/account">' + avatar +
      '<span class="who-text"><b>' + esc(name) + '</b><span class="sub">' +
      esc(org ? org.name : 'Personal') + '</span></span></a>';
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

  function renderBuild() {
    var b = $('#build-stamp');
    if (b) b.textContent = 'Build ' + BUILD + (extVersion ? ', extension ' + extVersion : '');
  }

  function renderAccount() {
    var box = user ? $('#account-box') : $('#signin-box');
    if (user) {
      box.innerHTML =
        '<div class="acct-row"><div><b>' + esc((profile && profile.display_name) || user.email) + '</b><br>' +
        '<span class="sub">' + esc(user.email) + '. Notes on this account save from any browser you use, ' +
        'and are signed with this name.</span></div>' +
        '<button class="btn quiet small" id="signout">Sign out</button></div>';
      $('#signout').addEventListener('click', function () {
        sb.auth.signOut().then(function () { location.reload(); });
      });
    } else {
      box.innerHTML =
        providerButtons('sso') +
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

      wireProviders(box, CFG.consoleUrl);
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
          ? 'That email and password did not match. If you created this account with a sign in button above, there is no password on it. Use that button, or email yourself a link.'
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

  /* ---------- install instructions, per browser and per device ---------- */

  var INSTALL = {
    'chrome': {
      label: 'Chrome', drag: true,
      steps: [
        'Show the bookmarks bar if it is hidden: <b>Cmd+Shift+B</b> on a Mac, <b>Ctrl+Shift+B</b> on Windows.',
        'Drag the black pill above onto that bar. It becomes a bookmark called Annotate with WhyTho.',
        'Open any page you want to document and click that bookmark. The toolbar appears at the bottom.'
      ]
    },
    'edge': {
      label: 'Edge', drag: true,
      steps: [
        'Show the favourites bar with <b>Ctrl+Shift+B</b>, or <b>Cmd+Shift+B</b> on a Mac.',
        'Drag the black pill above onto that bar.',
        'Open any page and click the bookmark to start annotating.'
      ]
    },
    'firefox': {
      label: 'Firefox', drag: true,
      steps: [
        'Show the bookmarks toolbar: <b>Cmd+Shift+B</b> on a Mac, <b>Ctrl+Shift+B</b> on Windows.',
        'Drag the black pill above onto that toolbar.',
        'Open any page and click the bookmark. If Firefox blocks it once, allow it and click again.'
      ]
    },
    'safari': {
      label: 'Safari', drag: true,
      steps: [
        'Turn on the favourites bar: <b>View</b> menu, then <b>Show Favourites Bar</b>, or press <b>Cmd+Shift+B</b>.',
        'Drag the black pill above onto that bar.',
        'Open any page and click the bookmark to start annotating.'
      ]
    },
    'ios': {
      label: 'iPhone or iPad', drag: false,
      steps: [
        'Tap <b>Copy the code</b> below.',
        'In Safari, open any page, tap the share button, then <b>Add Bookmark</b>. Save it to Favourites.',
        'Tap the bookmarks icon, then <b>Edit</b>, and open the bookmark you just made.',
        'Rename it <b>WhyTho</b>, clear the address field, and paste the copied code in its place. Tap Done.',
        'To use it: open a page, tap the bookmarks icon, and tap WhyTho. Safari will not run it from the address bar, only from a bookmark.'
      ]
    },
    'android': {
      label: 'Android', drag: false,
      steps: [
        'Tap <b>Copy the code</b> below.',
        'In Chrome, open any page and tap the star to bookmark it.',
        'Open <b>Bookmarks</b>, press and hold that bookmark, choose <b>Edit</b>.',
        'Rename it <b>WhyTho</b> and replace the URL with the copied code. Save.',
        'To use it: open a page, type <b>WhyTho</b> in the address bar, and tap the bookmark suggestion. Chrome on Android runs bookmarklets from the address bar, not from the bookmarks list.'
      ]
    }
  };

  function detectTarget() {
    var ua = navigator.userAgent;
    var touch = /iPhone|iPad|iPod/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua));
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    if (touch) return 'ios';
    if (/Edg\//.test(ua)) return 'edge';
    if (/Firefox\//.test(ua)) return 'firefox';
    if (/Chrome\/|Chromium\//.test(ua)) return 'chrome';   // covers Brave, Arc, Opera
    if (/Safari\//.test(ua)) return 'safari';
    return 'chrome';
  }

  var installTarget = null;

  /* ---------- extension ---------- */

  var extVersion = null;
  var extConnected = false;

  function detectExtension() {
    extVersion = document.documentElement.getAttribute('data-whytho-extension');
  }

  function renderExtension() {
    var box = $('#ext-state');
    if (!box) return;
    detectExtension();

    var latest = CFG.extensionVersion || '';
    var stale = extVersion && latest && extVersion !== latest;

    var install =
      '<div class="ext-install">' +
      '<a class="btn small" href="whytho-extension.zip" download>Download the extension</a>' +
      '<a class="btn quiet small" href="install.html">Full install instructions</a>' +
      '</div>' +
      '<ol class="steps ext-steps">' +
      '<li>Unzip it and keep the folder somewhere permanent. Chrome reads it from disk on every start.</li>' +
      '<li>Open <code>chrome://extensions</code> and turn on <b>Developer mode</b>, top right.</li>' +
      '<li>Choose <b>Load unpacked</b> and pick the folder, not the zip.</li>' +
      '<li>Come back here and press <b>Connect this account</b>.</li>' +
      '</ol>' +
      '<p class="sub">Chrome, Edge, Brave and Arc take this package. Firefox and Safari need their own builds, so use the bookmarklet there. Share <b>whytho.jakelabate.com/install.html</b> with anyone else who needs it.</p>';

    if (!extVersion) {
      box.innerHTML =
        '<div class="ext-row"><span class="ext-dot"></span><span>Not installed in this browser</span></div>' + install;
      return;
    }

    box.innerHTML =
      '<div class="ext-row"><span class="ext-dot on"></span><span>Installed, version ' + esc(extVersion) +
      (extConnected ? '. Connected to your account.' : '. Not connected to your account yet.') + '</span></div>' +
      (stale ? '<p class="warn-inline">Version ' + esc(latest) + ' is available. Download it below, replace the folder, then press the reload arrow on the extension card in chrome://extensions.</p>' : '') +
      '<button class="btn small" id="ext-connect">' + (extConnected ? 'Reconnect this account' : 'Connect this account') + '</button>' +
      '<p class="sub">Connecting hands the extension the same annotator token the bookmarklet uses. Nothing else is shared with it.</p>' +
      '<details class="ext-more"><summary>Install it somewhere else, or send it to someone</summary>' + install + '</details>';

    $('#ext-connect').addEventListener('click', function () {
      if (!token) { toast('Still setting up your account, try again in a moment.'); return; }
      window.postMessage({
        type: 'whytho:connect',
        token: token,
        account: (profile && profile.display_name) || (user && user.email) || ''
      }, window.location.origin);
    });
  }

  window.addEventListener('message', function (e) {
    // The bridge posts from this same page, so anything with another source is not ours.
    if (!e.data || typeof e.data !== 'object') return;
    if (e.source && e.source !== window) return;
    if (e.data.type === 'whytho:connected') {
      extConnected = true;
      renderExtension();
      toast('Extension connected. Notes from it save to your account.');
    }
    if (e.data.type === 'whytho:state') {
      extConnected = !!e.data.connected;
      renderExtension();
    }
  });

  function renderInstallGuide() {
    var wrap = $('#install-guide');
    if (!wrap) return;
    if (!installTarget) installTarget = detectTarget();
    var here = detectTarget();
    var conf = INSTALL[installTarget] || INSTALL.chrome;

    var chips = Object.keys(INSTALL).map(function (k) {
      return '<button class="chip-btn' + (k === installTarget ? ' on' : '') + '" data-install="' + k + '">' +
        esc(INSTALL[k].label) + (k === here ? ' <span class="sub">this device</span>' : '') + '</button>';
    }).join('');

    wrap.innerHTML =
      '<div class="guide-head"><span class="ws-label">Instructions for</span><div class="ws-chips">' + chips + '</div></div>' +
      '<ol class="steps">' + conf.steps.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ol>' +
      '<button class="btn quiet small" id="copy-bookmarklet">Copy the code</button>' +
      '<p class="sub guide-note">Installing this is per browser and per device. The bookmarklet you add on a laptop does not follow you to your phone, and the steps differ, so open the matching set above when you set up somewhere new. Your notes are on your account either way.</p>';

    // The pill is only draggable where dragging exists.
    var dragLine = $('#drag-line');
    if (dragLine) dragLine.hidden = !conf.drag;

    var bm = $('#bookmarklet');
    if (bm) bm.setAttribute('href', bookmarkletCode());

    wrap.querySelectorAll('[data-install]').forEach(function (b) {
      b.addEventListener('click', function () {
        installTarget = b.getAttribute('data-install');
        renderInstallGuide();
    renderExtension();
    enhanceCode(document.querySelector('[data-view="setup"]'));
      });
    });
    $('#copy-bookmarklet').addEventListener('click', function () { copy(bookmarkletCode(), 'Bookmarklet code'); });
  }

  function renderSetup() {
    var bm = $('#bookmarklet');
    if (!bm) return;
    bm.setAttribute('href', bookmarkletCode());
    $('#bookmarklet-state').textContent = user && token
      ? 'This bookmarklet is tied to your account. Notes you take with it save to ' + user.email + '.'
      : 'Sign in first and this bookmarklet will carry your account with it. Right now it saves notes in the browser only.';
    $('#snippet').textContent = '<script src="' + CFG.consoleUrl.replace(/\/$/, '') + '/assets/annotator.js"' +
      (token ? ' data-why-token="' + token + '"' : '') + ' defer><\/script>';
    renderInstallGuide();
    renderExtension();
    enhanceCode(document.querySelector('[data-view="setup"]'));
  }

  /* ---------- workspace ---------- */

  function loadWorkspace() {
    if (!user) { renderWorkspace(); return Promise.resolve(); }
    return sb.from('why_profiles').select('*').eq('user_id', user.id).maybeSingle()
      .then(function (res) {
        profile = res.data || { user_id: user.id, display_name: null, active_org_id: null, active_team_id: null };
        return sb.from('why_org_members').select('org_id, role').eq('user_id', user.id);
      })
      .then(function (res) {
        var roles = {};
        (res.data || []).forEach(function (m) { roles[m.org_id] = m.role; });
        return sb.from('why_orgs').select('id, name').then(function (o) {
          orgs = (o.data || []).map(function (x) { x.role = roles[x.id] || 'member'; return x; });
          myRole = profile.active_org_id ? (roles[profile.active_org_id] || 'member') : null;
        });
      });
  }

  function setActive(orgId, teamId) {
    return sb.from('why_profiles').upsert({
      user_id: user.id, active_org_id: orgId, active_team_id: teamId || null, updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' }).then(function (res) {
      if (res.error) { toast(res.error.message); return; }
      return boot();
    });
  }

  function activeOrg() {
    var found = null;
    orgs.forEach(function (o) { if (profile && o.id === profile.active_org_id) found = o; });
    return found;
  }

  function renderWorkspace() {
    var box = $('#workspace-box');
    if (!user) {
      box.innerHTML = '<p class="sub">Sign in to create an organization or join one.</p>';
      return;
    }

    var org = activeOrg();
    var html = '<div class="ws-head"><div><b>' +
      (org ? esc(org.name) : 'Working on your own') + '</b><br><span class="sub">' +
      (org ? 'Everyone in this organization sees notes written here. You are ' + esc(myRole) + '.'
           : 'Notes are private to ' + esc(profile.display_name || user.email) + '.') +
      '</span></div></div>';

    if (orgs.length) {
      html += '<div class="ws-row"><label class="ws-label">Active workspace</label><select id="org-switch">';
      html += '<option value="">Personal, private to me</option>';
      orgs.forEach(function (o) {
        html += '<option value="' + o.id + '"' + (org && o.id === org.id ? ' selected' : '') + '>' + esc(o.name) + '</option>';
      });
      html += '</select></div>';
    }

    html += '<div id="ws-detail"></div>';
    html += '<details class="ws-more"><summary>Create or join an organization</summary>' +
      '<div class="ws-row"><input id="org-name" placeholder="Organization name"><button class="btn small" id="org-create">Create</button></div>' +
      '<div class="ws-row"><input id="join-code" placeholder="Invite code"><button class="btn quiet small" id="join-go">Join</button></div>' +
      '</details>';

    box.innerHTML = html;

    if ($('#org-switch')) {
      $('#org-switch').addEventListener('change', function (e) { setActive(e.target.value || null, null); });
    }
    $('#org-create').addEventListener('click', function () {
      var name = $('#org-name').value.trim();
      if (!name) { toast('Name the organization first.'); return; }
      sb.rpc('why_create_org', { p_name: name }).then(function (res) {
        var out = res.data || {};
        if (res.error || out.error) { toast((res.error && res.error.message) || out.error); return; }
        toast(name + ' created. You are the owner.');
        boot();
      });
    });
    $('#join-go').addEventListener('click', function () {
      var code = $('#join-code').value.trim();
      if (!code) { toast('Paste the invite code.'); return; }
      sb.rpc('why_redeem_invite', { p_code: code }).then(function (res) {
        var out = res.data || {};
        if (res.error || out.error) { toast((res.error && res.error.message) || out.error); return; }
        toast('Joined.');
        boot();
      });
    });

    if (org) renderOrgDetail(org);
  }

  function renderOrgDetail(org) {
    var wrap = $('#ws-detail');
    wrap.innerHTML = '<p class="sub">Loading teams and people.</p>';
    var teams = [], members = [], myTeams = [];

    sb.from('why_teams').select('id, name').eq('org_id', org.id)
      .then(function (r) { teams = r.data || []; return sb.from('why_org_members').select('user_id, role').eq('org_id', org.id); })
      .then(function (r) {
        members = r.data || [];
        return sb.from('why_profiles').select('user_id, display_name').in('user_id', members.map(function (m) { return m.user_id; }));
      })
      .then(function (r) {
        var names = {};
        (r.data || []).forEach(function (p) { names[p.user_id] = p.display_name; });
        return sb.from('why_team_members').select('team_id').eq('user_id', user.id).then(function (t) {
          myTeams = (t.data || []).map(function (x) { return x.team_id; });
          paint(names);
        });
      });

    function paint(names) {
      var isAdmin = myRole === 'owner' || myRole === 'admin';
      var html = '';

      html += '<div class="ws-block"><label class="ws-label">Teams</label>';
      if (!teams.length) html += '<p class="sub">No teams yet. Notes will be attributed to you and to the organization.</p>';
      html += '<div class="ws-chips">';
      teams.forEach(function (t) {
        var on = profile.active_team_id === t.id;
        html += '<button class="chip-btn' + (on ? ' on' : '') + '" data-team="' + t.id + '">' + esc(t.name) +
          (myTeams.indexOf(t.id) > -1 ? '' : ' <span class="sub">join</span>') + '</button>';
      });
      html += '</div>';
      if (isAdmin) {
        html += '<div class="ws-row"><input id="team-name" placeholder="New team name"><button class="btn quiet small" id="team-create">Add team</button></div>';
      }
      html += '</div>';

      html += '<div class="ws-block"><label class="ws-label">People</label><ul class="ws-people">';
      members.forEach(function (m) {
        html += '<li><b>' + esc(names[m.user_id] || 'Unnamed account') + '</b> <span class="sub">' + esc(m.role) +
          (m.user_id === user.id ? ', you' : '') + '</span></li>';
      });
      html += '</ul>';

      if (isAdmin) {
        html += '<div class="ws-row"><select id="invite-team"><option value="">No specific team</option>';
        teams.forEach(function (t) { html += '<option value="' + t.id + '">' + esc(t.name) + '</option>'; });
        html += '</select><select id="invite-role"><option value="member">Member</option><option value="admin">Admin</option></select>' +
          '<button class="btn small" id="invite-make">Create invite code</button></div>' +
          '<p class="sub" id="invite-out"></p>';
      }
      html += '</div>';

      wrap.innerHTML = html;

      wrap.querySelectorAll('[data-team]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-team');
          sb.from('why_team_members').upsert({ team_id: id, user_id: user.id }, { onConflict: 'team_id,user_id' })
            .then(function () { return setActive(org.id, id); });
        });
      });

      if ($('#team-create')) {
        $('#team-create').addEventListener('click', function () {
          var name = $('#team-name').value.trim();
          if (!name) { toast('Name the team first.'); return; }
          sb.from('why_teams').insert({ org_id: org.id, name: name }).then(function (r) {
            if (r.error) { toast(r.error.message); return; }
            toast(name + ' added.');
            renderOrgDetail(org);
          });
        });
      }

      if ($('#invite-make')) {
        $('#invite-make').addEventListener('click', function () {
          var code = randomToken().slice(0, 12);
          sb.from('why_invites').insert({
            code: code, org_id: org.id,
            team_id: $('#invite-team').value || null,
            role: $('#invite-role').value,
            created_by: user.id
          }).then(function (r) {
            if (r.error) { toast(r.error.message); return; }
            $('#invite-out').innerHTML = 'Send this code, it works for 30 days: <code>' + code + '</code>';
            copy(code, 'Invite code');
          });
        });
      }
    }
  }

  /* ---------- inbox ---------- */

  var inbox = [];

  function loadInbox() {
    if (!user) { inbox = []; return Promise.resolve(); }
    return sb.rpc('why_notifications_feed', { p_limit: 100 }).then(function (res) {
      // Never let an unexpected shape from the feed take down the whole app boot.
      inbox = (!res.error && Array.isArray(res.data)) ? res.data : [];
    });
  }

  function unreadCount() {
    return inbox.filter(function (n) { return !n.read_at; }).length;
  }

  function renderBadge() {
    var b = $('#inbox-badge');
    if (!b) return;
    var n = unreadCount();
    b.hidden = n === 0;
    b.textContent = n === 0 ? '' : (n > 99 ? '99+' : String(n));
  }

  function markRead(ids) {
    if (!ids.length) return Promise.resolve();
    var now = new Date().toISOString();
    inbox.forEach(function (n) { if (ids.indexOf(n.id) > -1) n.read_at = now; });
    renderBadge();
    return sb.from('why_notifications').update({ read_at: now }).in('id', ids);
  }

  function renderInbox() {
    var wrap = $('#inbox-list');
    if (!wrap) return;
    renderBadge();

    if (!inbox.length) {
      wrap.innerHTML = '<div class="blank">Nothing yet. When somebody types <b>@' +
        esc((profile && profile.display_name) || 'your name') +
        '</b> or the name of a team you are in, it arrives here.</div>';
      return;
    }

    wrap.innerHTML = '';
    inbox.forEach(function (n) {
      var card = document.createElement('button');
      card.className = 'notif' + (n.read_at ? '' : ' unread');
      var why = n.via_team ? 'tagged <b>' + esc(n.via_team) + '</b>' : 'tagged <b>you</b>';
      card.innerHTML =
        '<div class="notif-top">' + (n.read_at ? '' : '<span class="dot-unread"></span>') +
        '<b>' + esc(n.actor || 'Someone') + '</b> ' + why +
        '<span class="notif-when">' + esc(new Date(n.created_at).toLocaleString()) + '</span></div>' +
        '<div class="notif-body">' + esc(n.body) + '</div>' +
        '<div class="notif-foot"><code>' + esc(n.selector || '') + '</code>' +
        '<span class="sub">' + esc((n.origin || '').replace(/^https?:\/\//, '') + (n.path || '')) + '</span></div>';
      card.addEventListener('click', function () {
        markRead([n.id]);
        if (!n.page_id) return;
        sb.from('why_pages').select('*').eq('id', n.page_id).maybeSingle().then(function (r) {
          if (r.data) openCloud(r.data);
        });
      });
      wrap.appendChild(card);
    });
  }

  /* ---------- library ---------- */

  /* ---------- code blocks ----------
     A small tokenizer rather than a highlighting library: five languages, patterns
     written with non capturing groups so the match index maps to a rule. */

  var LANGS = {
    bash: { label: 'Shell', rules: [
      ['comment', /#[^\n]*/],
      ['str', /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/],
      ['var', /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\((?:[^)]*)\)/],
      ['flag', /(?:^|\s)--?[A-Za-z][A-Za-z-]*/],
      ['fn', /\b(?:curl|jq|node|npm|date|export|echo|python3?|pip)\b/]
    ]},
    javascript: { label: 'JavaScript', rules: [
      ['comment', /\/\/[^\n]*/],
      ['str', /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/],
      ['kw', /\b(?:const|let|var|await|async|for|of|in|if|else|return|new|function|import|from|export|process|true|false|null|undefined)\b/],
      ['fn', /\b(?:fetch|console|JSON|Object|Array|encodeURIComponent)\b/],
      ['num', /\b\d+(?:\.\d+)?\b/]
    ]},
    python: { label: 'Python', rules: [
      ['comment', /#[^\n]*/],
      ['str', /"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/],
      ['kw', /\b(?:import|from|as|for|in|while|with|if|else|elif|break|continue|return|def|class|True|False|None|not|and|or)\b/],
      ['fn', /\b(?:print|open|sorted|set|requests|csv|json)\b/],
      ['num', /\b\d+(?:\.\d+)?\b/]
    ]},
    json: { label: 'JSON', rules: [
      ['key', /"(?:\\.|[^"\\])*"(?=\s*:)/],
      ['str', /"(?:\\.|[^"\\])*"/],
      ['kw', /\b(?:true|false|null)\b/],
      ['num', /-?\b\d+(?:\.\d+)?\b/]
    ]},
    yaml: { label: 'YAML', rules: [
      ['comment', /#[^\n]*/],
      ['str', /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/],
      ['key', /^\s*-?\s*[A-Za-z_][A-Za-z0-9_-]*(?=:)/m],
      ['var', /\$\{\{[^}]*\}\}/]
    ]},
    html: { label: 'HTML', rules: [
      ['str', /"(?:\\.|[^"\\])*"/],
      ['kw', /<\/?[A-Za-z][A-Za-z0-9-]*|\/?>/],
      ['key', /\b[a-z-]+(?==)/]
    ]},
    text: { label: '', rules: [] }
  };

  var compiled = {};
  function langRegex(lang) {
    if (compiled[lang]) return compiled[lang];
    var rules = LANGS[lang].rules;
    if (!rules.length) return (compiled[lang] = null);
    var flags = 'g' + (rules.some(function (r) { return r[1].flags.indexOf('m') > -1; }) ? 'm' : '');
    compiled[lang] = new RegExp(rules.map(function (r) { return '(' + r[1].source + ')'; }).join('|'), flags);
    return compiled[lang];
  }

  function tokenize(src, lang) {
    var conf = LANGS[lang] || LANGS.text;
    var re = langRegex(lang);
    if (!re) return esc(src);
    var out = '', last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      if (m[0] === '') { re.lastIndex++; continue; }
      out += esc(src.slice(last, m.index));
      var cls = 'tok';
      for (var i = 1; i < m.length; i++) {
        if (m[i] !== undefined) { cls = 'tok-' + conf.rules[i - 1][0]; break; }
      }
      out += '<span class="' + cls + '">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    return out + esc(src.slice(last));
  }

  function enhanceCode(root) {
    (root || document).querySelectorAll('pre > code[data-lang]').forEach(function (codeEl) {
      var raw = codeEl.textContent;
      if (codeEl.getAttribute('data-raw') === raw) return;   // already painted, unchanged
      codeEl.setAttribute('data-raw', raw);

      var lang = codeEl.getAttribute('data-lang');
      codeEl.innerHTML = tokenize(raw, lang);

      var pre = codeEl.parentNode;
      var block = pre.parentNode && pre.parentNode.classList.contains('code-block') ? pre.parentNode : null;
      if (!block) {
        block = document.createElement('div');
        block.className = 'code-block';
        pre.parentNode.insertBefore(block, pre);
        var bar = document.createElement('div');
        bar.className = 'code-bar';
        bar.innerHTML = '<span class="code-lang">' + esc((LANGS[lang] || LANGS.text).label) + '</span>';
        var btn = document.createElement('button');
        btn.className = 'code-copy';
        btn.type = 'button';
        btn.textContent = 'Copy';
        btn.addEventListener('click', function () {
          copy(codeEl.getAttribute('data-raw') || codeEl.textContent, 'Snippet');
          btn.textContent = 'Copied';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
        });
        bar.appendChild(btn);
        block.appendChild(bar);
        block.appendChild(pre);
      }
    });
  }

  /* ---------- change requests ---------- */

  var changes = [];
  var repos = [];

  function loadChanges() {
    if (!user) { changes = []; return Promise.resolve(); }
    return sb.from('why_changes').select('*').order('created_at', { ascending: false }).limit(100)
      .then(function (r) { changes = (!r.error && Array.isArray(r.data)) ? r.data : []; });
  }

  function loadRepos() {
    if (!user) { repos = []; return Promise.resolve(); }
    return sb.from('why_repos').select('*').order('origin')
      .then(function (r) { repos = (!r.error && Array.isArray(r.data)) ? r.data : []; });
  }

  function renderChangesBadge() {
    var b = $('#changes-badge');
    if (!b) return;
    var live = changes.filter(function (c) { return c.status === 'queued' || c.status === 'working'; }).length;
    b.hidden = live === 0;
    b.textContent = live === 0 ? '' : String(live);
  }

  var CHANGE_LABEL = {
    queued: 'Queued', working: 'Drafting', opened: 'Pull request open',
    failed: 'Failed', skipped: 'Not applied'
  };

  function renderChanges() {
    var wrap = $('#changes-list');
    if (!wrap) return;
    renderChangesBadge();

    if (!changes.length) {
      wrap.innerHTML = '<div class="blank">Nothing yet. In the annotator, choose <b>Ask for a change</b> instead of Record why, and the request lands here.</div>';
      return;
    }

    wrap.innerHTML = changes.map(function (c) {
      return '<div class="change ' + esc(c.status) + '">' +
        '<div class="change-top"><span class="change-state">' + esc(CHANGE_LABEL[c.status] || c.status) + '</span>' +
        '<span class="sub">' + esc(new Date(c.created_at).toLocaleString()) + '</span></div>' +
        (c.summary ? '<div class="change-body">' + esc(c.summary) + '</div>' : '') +
        (c.file_path ? '<code>' + esc(c.file_path) + '</code>' : '') +
        (c.error ? '<div class="change-error">' + esc(c.error) + '</div>' : '') +
        '<div class="change-actions">' +
        (c.pr_url ? '<a class="btn quiet small" href="' + esc(c.pr_url) + '" target="_blank" rel="noopener">Review pull request #' + c.pr_number + '</a>' : '') +
        (c.status === 'failed' || c.status === 'skipped' ? '<button class="btn quiet small" data-retry="' + c.id + '">Try again</button>' : '') +
        '</div></div>';
    }).join('');

    wrap.querySelectorAll('[data-retry]').forEach(function (b) {
      b.addEventListener('click', function () {
        b.disabled = true; b.textContent = 'Working';
        fetch(CFG.supabaseUrl.replace(/\/$/, '') + '/functions/v1/why-apply', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ token: token, change_id: b.getAttribute('data-retry') })
        }).then(function () {
          setTimeout(function () { loadChanges().then(renderChanges); }, 4000);
        }, function () { toast('Could not reach the drafting service.'); });
      });
    });
  }

  function renderRepos() {
    var wrap = $('#repo-list');
    if (!wrap) return;
    if (!repos.length) {
      wrap.innerHTML = '<p class="sub">No sites mapped yet.</p>';
      return;
    }
    wrap.innerHTML = '<ul class="key-list">' + repos.map(function (r) {
      return '<li><div><b>' + esc(String(r.origin).replace(/^https?:\/\//, '')) + '</b>' +
        '<br><span class="sub">' + esc(r.repo) + ' &middot; ' + esc(r.branch) + '</span></div>' +
        '<button class="btn quiet small danger" data-unmap="' + r.id + '">Remove</button></li>';
    }).join('') + '</ul>';

    wrap.querySelectorAll('[data-unmap]').forEach(function (b) {
      b.addEventListener('click', function () {
        sb.from('why_repos').delete().eq('id', b.getAttribute('data-unmap')).then(function (r) {
          if (r.error) { toast(r.error.message); return; }
          loadRepos().then(renderRepos);
        });
      });
    });
  }

  function addRepo() {
    var origin = $('#repo-origin').value.trim().replace(/\/$/, '');
    var repo = $('#repo-name').value.trim();
    var branch = $('#repo-branch').value.trim() || 'main';
    if (!/^https?:\/\//.test(origin)) { toast('Start the site with https://'); return; }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast('Repository looks like owner/name.'); return; }
    sb.from('why_repos').insert({
      user_id: user.id,
      org_id: profile ? profile.active_org_id : null,
      origin: origin, repo: repo, branch: branch
    }).then(function (r) {
      if (r.error) { toast(r.error.message); return; }
      $('#repo-origin').value = ''; $('#repo-name').value = '';
      toast(origin + ' mapped to ' + repo + '.');
      loadRepos().then(renderRepos);
    });
  }

  /* ---------- API keys ---------- */

  var apiKeys = [];

  function apiBase() {
    return CFG.apiBase || (CFG.supabaseUrl.replace(/\/$/, '') + '/functions/v1/why-api');
  }

  function hashKey(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    });
  }

  function loadKeys() {
    if (!user) { apiKeys = []; return Promise.resolve(); }
    return sb.from('why_api_keys').select('*').order('created_at', { ascending: false })
      .then(function (r) { apiKeys = (!r.error && Array.isArray(r.data)) ? r.data : []; });
  }

  function renderApi() {
    var base = $('#api-base');
    if (!base) return;
    base.textContent = apiBase();
    var mcp = $('#mcp-url');
    if (mcp) mcp.textContent = CFG.mcpUrl || (CFG.supabaseUrl.replace(/\/$/, '') + '/functions/v1/why-mcp/mcp');
    renderConnections();
    document.querySelectorAll('.api-host').forEach(function (n) { n.textContent = apiBase(); });
    enhanceCode(document.querySelector('[data-view="api"]'));

    var list = $('#key-list');
    if (!apiKeys.length) {
      list.innerHTML = '<p class="sub">No keys yet.</p>';
      return;
    }

    list.innerHTML = '<ul class="key-list">' + apiKeys.map(function (k) {
      var org = k.org_id ? (activeOrg() && k.org_id === activeOrg().id ? activeOrg().name : 'an organization') : 'Personal';
      var write = Array.isArray(k.scopes) && k.scopes.indexOf('write') > -1;
      return '<li class="' + (k.revoked ? 'revoked' : '') + '">' +
        '<div><code>' + esc(k.key_prefix) + '\u2026</code> <b>' + esc(k.name || 'Unnamed key') + '</b>' +
        '<span class="key-scope' + (write ? ' write' : '') + '">' + (write ? 'read and write' : 'read only') + '</span>' +
        '<br><span class="sub">' + esc(org) + ' &middot; created ' + esc(new Date(k.created_at).toLocaleDateString()) +
        (k.last_used_at ? ' &middot; last used ' + esc(new Date(k.last_used_at).toLocaleDateString()) : ' &middot; never used') +
        (k.revoked ? ' &middot; revoked' : '') + '</span></div>' +
        (k.revoked ? '' : '<button class="btn quiet small danger" data-revoke="' + k.id + '">Revoke</button>') +
        '</li>';
    }).join('') + '</ul>';

    list.querySelectorAll('[data-revoke]').forEach(function (b) {
      b.addEventListener('click', function () {
        sb.from('why_api_keys').update({ revoked: true }).eq('id', b.getAttribute('data-revoke'))
          .then(function (r) {
            if (r.error) { toast(r.error.message); return; }
            toast('Key revoked. It stops working immediately.');
            loadKeys().then(renderApi);
          });
      });
    });
  }

  // Anything the person has connected through OAuth, so it can be taken away again.
  function renderConnections() {
    var box = $('#mcp-connections');
    if (!box || !user) return;
    sb.from('why_oauth_tokens').select('id, client_id, scope, created_at, last_used_at, revoked')
      .order('created_at', { ascending: false })
      .then(function (r) {
        var rows = (!r.error && Array.isArray(r.data)) ? r.data.filter(function (x) { return !x.revoked; }) : [];
        if (!rows.length) { box.innerHTML = ''; return; }
        box.innerHTML = '<p class="ws-label" style="margin-top:18px">Connected applications</p><ul class="key-list">' +
          rows.map(function (c) {
            return '<li><div><b>Claude</b><span class="key-scope' + (c.scope.indexOf('write') > -1 ? ' write' : '') + '">' +
              esc(c.scope.indexOf('write') > -1 ? 'read and write' : 'read only') + '</span>' +
              '<br><span class="sub">connected ' + esc(new Date(c.created_at).toLocaleDateString()) +
              (c.last_used_at ? ' &middot; last used ' + esc(new Date(c.last_used_at).toLocaleDateString()) : ' &middot; never used') +
              '</span></div><button class="btn quiet small danger" data-disconnect="' + c.id + '">Disconnect</button></li>';
          }).join('') + '</ul>';

        box.querySelectorAll('[data-disconnect]').forEach(function (b) {
          b.addEventListener('click', function () {
            sb.from('why_oauth_tokens').update({ revoked: true }).eq('id', b.getAttribute('data-disconnect'))
              .then(function (res) {
                if (res.error) { toast(res.error.message); return; }
                toast('Disconnected. Claude will need to be reconnected to reach your notes.');
                renderConnections();
              });
          });
        });
      });
  }

  function createKey() {
    var name = $('#key-name').value.trim();
    var wants = $('#key-scope') ? $('#key-scope').value : 'read';
    var scopes = wants === 'write' ? ['read', 'write'] : ['read'];
    var raw = 'why_live_' + randomToken() + randomToken().slice(0, 8);
    hashKey(raw).then(function (hash) {
      return sb.from('why_api_keys').insert({
        user_id: user.id,
        org_id: profile ? profile.active_org_id : null,
        name: name || null,
        key_hash: hash,
        key_prefix: raw.slice(0, 17),
        scopes: scopes
      });
    }).then(function (r) {
      if (r && r.error) { toast(r.error.message); return; }
      $('#key-name').value = '';
      var box = $('#key-fresh');
      box.hidden = false;
      box.innerHTML = '<p class="key-fresh-note"><b>Copy this now.</b> Only a hash is stored, so this is the one time it is shown.</p>' +
        '<pre><code data-lang="text">' + esc(raw) + '</code></pre>' +
        '<button class="btn small" id="key-copy">Copy key</button>';
      $('#key-copy').addEventListener('click', function () { copy(raw, 'API key'); });
      enhanceCode(box);
      loadKeys().then(renderApi);
    });
  }

  /* ---------- the notes tree ----------
     Pages are grouped by site, then nested along their URL path, so /products/ sits
     above /products/whytho/. Every level carries the totals of everything beneath it. */

  function unreadByPage() {
    var map = {};
    inbox.forEach(function (n) {
      if (n.read_at || !n.page_id) return;
      map[n.page_id] = (map[n.page_id] || 0) + 1;
    });
    return map;
  }

  function buildTree(pages, counts, unread) {
    var sites = {};
    pages.forEach(function (p) {
      var host = String(p.origin || '').replace(/^https?:\/\//, '');
      var site = sites[host] || (sites[host] = { name: host, origin: p.origin, children: {}, page: null, updated: '' });
      if ((p.updated_at || '') > site.updated) site.updated = p.updated_at || '';

      var segs = String(p.path || '/').split('/').filter(Boolean);
      var node = site, acc = '';
      segs.forEach(function (seg) {
        acc += '/' + seg;
        node = node.children[seg] || (node.children[seg] = { name: seg, path: acc + '/', children: {}, page: null });
      });
      node.page = p;
      node.notes = counts[p.id] || 0;
      node.unread = unread[p.id] || 0;
      node.scope = p.org_id ? (activeOrg() && p.org_id === activeOrg().id ? activeOrg().name : 'Shared') : 'Personal';
    });
    Object.keys(sites).forEach(function (k) { compress(sites[k]); total(sites[k]); });
    return sites;
  }

  // A folder with no page of its own and a single child is a level that tells you
  // nothing, so fold it into the child: /menu/ + wings/ becomes /menu/wings/.
  function compress(node) {
    Object.keys(node.children).forEach(function (k) {
      var child = node.children[k];
      compress(child);
      var grandKeys = Object.keys(child.children);
      if (!child.page && grandKeys.length === 1) {
        var only = child.children[grandKeys[0]];
        delete node.children[k];
        node.children[only.path || grandKeys[0]] = only;
      }
    });
  }

  function total(node) {
    var urls = node.page ? 1 : 0;
    var notes = node.page ? (node.notes || 0) : 0;
    var unread = node.page ? (node.unread || 0) : 0;
    Object.keys(node.children).forEach(function (k) {
      var t = total(node.children[k]);
      urls += t.urls; notes += t.notes; unread += t.unread;
    });
    node.totals = { urls: urls, notes: notes, unread: unread };
    return node.totals;
  }

  function countsLine(t) {
    var bits = [t.urls + (t.urls === 1 ? ' URL' : ' URLs'), t.notes + (t.notes === 1 ? ' note' : ' notes')];
    var html = '<span class="acc-counts">' + bits.join(' &middot; ') + '</span>';
    if (t.unread) html += '<span class="acc-unread">' + t.unread + ' unread</span>';
    return html;
  }

  function nodeElement(node, depth, onOpen) {
    var kids = Object.keys(node.children).sort();
    var t = node.totals;

    // A leaf page is a row you click. Anything with children is an accordion.
    if (!kids.length) {
      var b = document.createElement('button');
      b.className = 'acc-leaf';
      b.style.paddingLeft = (14 + depth * 16) + 'px';
      b.innerHTML = '<span class="acc-name">' + esc(node.path || '/') + '</span>' +
        (node.scope ? '<span class="scope-tag">' + esc(node.scope) + '</span>' : '') +
        '<span class="acc-right">' + countsLine(t) + '</span>';
      if (node.page) b.addEventListener('click', function () { onOpen(node.page); });
      return b;
    }

    var d = document.createElement('details');
    d.className = 'acc';
    if (t.unread) d.open = true;      // anything waiting on you opens itself
    var sum = document.createElement('summary');
    sum.style.paddingLeft = (14 + depth * 16) + 'px';
    sum.innerHTML = '<span class="acc-name">' + esc(node.path || node.name) + '</span>' +
      '<span class="acc-right">' + countsLine(t) + '</span>';
    d.appendChild(sum);

    if (node.page) {
      var self = document.createElement('button');
      self.className = 'acc-leaf acc-self';
      self.style.paddingLeft = (14 + (depth + 1) * 16) + 'px';
      self.innerHTML = '<span class="acc-name">' + esc(node.path) + '</span>' +
        (node.scope ? '<span class="scope-tag">' + esc(node.scope) + '</span>' : '') +
        '<span class="acc-right">' + countsLine({ urls: 1, notes: node.notes || 0, unread: node.unread || 0 }) + '</span>';
      self.addEventListener('click', function () { onOpen(node.page); });
      d.appendChild(self);
    }

    kids.forEach(function (k) { d.appendChild(nodeElement(node.children[k], depth + 1, onOpen)); });
    return d;
  }

  function paintTree(wrap, pages, counts, unread, onOpen) {
    var sites = buildTree(pages, counts, unread);
    wrap.innerHTML = '';
    Object.keys(sites)
      .sort(function (a, b) { return (sites[b].updated || '').localeCompare(sites[a].updated || ''); })
      .forEach(function (host) {
        var site = sites[host];
        var d = document.createElement('details');
        d.className = 'acc acc-site';
        if (site.totals.unread) d.open = true;
        var sum = document.createElement('summary');
        sum.innerHTML = '<span class="acc-host">' + esc(host) + '</span>' +
          '<span class="acc-right">' + countsLine(site.totals) + '</span>';
        d.appendChild(sum);
        Object.keys(site.children).sort().forEach(function (k) {
          d.appendChild(nodeElement(site.children[k], 1, onOpen));
        });
        if (site.page) {
          var rootRow = nodeElement({ name: '/', path: '/', children: {}, page: site.page,
            notes: site.notes, unread: site.unread, scope: site.scope,
            totals: { urls: 1, notes: site.notes || 0, unread: site.unread || 0 } }, 1, onOpen);
          d.insertBefore(rootRow, d.children[1] || null);
        }
        wrap.appendChild(d);
      });
  }

  function renderLibrary() {
    var wrap = $('#library-list');
    var scope = $('#notes-scope');
    if (scope) {
      var org = activeOrg();
      scope.textContent = !user ? ''
        : org ? 'Pages annotated in ' + org.name + ', by anyone in the organization.'
              : 'Pages you have annotated. These are private to you.';
    }
    if (!user) {
      var db = localDb();
      wrap.innerHTML = '';
      if (!db.pages.length) {
        wrap.innerHTML = '<div class="blank">Nothing here yet. Sign in above to save notes to your account, or annotate a page and choose <b>Send to console</b> to keep them in this browser.</div>';
        return;
      }
      var localCounts = {}, ids = {};
      db.pages.forEach(function (p) { p.id = pageId(p); localCounts[p.id] = p.notes.length; ids[p.id] = p; });
      paintTree(wrap, db.pages.map(function (p) {
        return { id: p.id, origin: p.origin, path: p.path, org_id: null, updated_at: p.updatedAt };
      }), localCounts, {}, function (page) { openLocal(page.id); });
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
        return;
      }
      sb.from('why_notes').select('page_id').is('deleted_at', null).then(function (nres) {
        var counts = {};
        (nres.data || []).forEach(function (n) { counts[n.page_id] = (counts[n.page_id] || 0) + 1; });
        paintTree(wrap, pages, counts, unreadByPage(), openCloud);
      });
    });
  }


  // Anything still sitting in this browser belongs on the account. Move it quietly.
  function absorbLocal() {
    if (!user) return Promise.resolve();
    var db = localDb();
    if (!db.pages.length) return Promise.resolve();
    return uploadLocal(true);
  }

  function uploadLocal(quiet) {
    var db = localDb();
    if (!db.pages.length) return Promise.resolve();
    var moved = db.pages.reduce(function (a, p) { return a + p.notes.length; }, 0);
    var jobs = db.pages.map(function (p) {
      var orgId = profile ? profile.active_org_id : null;
      return sb.from('why_pages').upsert(
        { user_id: user.id, org_id: orgId, origin: p.origin, path: p.path, url: p.url, title: p.title },
        { onConflict: orgId ? 'org_id,origin,path' : 'user_id,origin,path' }
      ).select('id').single().then(function (res) {
        if (res.error || !res.data) return;
        var rows = p.notes.map(function (n) {
          return {
            page_id: res.data.id, user_id: user.id, org_id: orgId,
            team_id: profile ? profile.active_team_id : null,
            client_id: n.id, selector: n.selector,
            fallback_selector: n.fallbackSelector || null, tag: n.tag || null,
            text_snippet: n.textSnippet || null, category: n.category || 'seo',
            status: n.status || 'decided', body: n.body,
            author: (profile && profile.display_name) || null,
            viewport: n.viewport || {}, created_at: n.createdAt || new Date().toISOString(), deleted_at: null
          };
        });
        if (!rows.length) return;
        return sb.from('why_notes').upsert(rows, { onConflict: 'user_id,client_id' });
      });
    });
    return Promise.all(jobs).then(function (results) {
      var failed = results.filter(function (r) { return r && r.error; });
      if (failed.length) { toast('Could not move local notes: ' + failed[0].error.message); renderLibrary(); return; }
      localStorage.removeItem(LOCAL_KEY);
      toast(moved + ' note' + (moved === 1 ? '' : 's') + ' from this browser moved to your account.');
      renderLibrary();
    });
  }

  /* ---------- viewer ---------- */

  function showViewer(title, url, notes, onDelete) {
    $('#viewer-title').textContent = title || 'Page';
    $('#viewer-url').innerHTML = url ? '<a href="' + esc(url) + '" rel="noopener">' + esc(url) + '</a>' : '';
    current = { title: title, url: url, notes: notes, remove: onDelete };
    paintNotes();
    go('page');
  }

  function noteCard(n, i) {
    var vp = n.viewport && n.viewport.width ? n.viewport.breakpoint + ' ' + n.viewport.width + 'px' : 'viewport not recorded';
    var d = document.createElement('div');
    d.className = 'note';
    d.style.borderLeftColor = CATEGORY_COLORS[n.category] || '#5b21b6';
    d.innerHTML =
      '<div class="top"><b>' + (i + 1) + '</b><span>' + esc(CATEGORY_LABELS[n.category] || n.category) + '</span>' +
      '<span>' + esc(n.status || '') + '</span><span>' + esc(vp) + '</span>' +
      '<span class="scope-pill' + (scopeOf(n).indexOf('all') > -1 ? '' : ' narrow') + '">' + esc(scopeLabel(n)) + '</span></div>' +
      '<div class="body">' + highlight(n.body) + '</div>' +
      (n.shotPath ? '<div class="note-shot" data-shot="' + esc(n.shotPath) + '"></div>' : '') +
      (n.context && (n.context.heading || n.context.text)
        ? '<div class="note-ctx">' +
          (n.context.heading ? '<span><b>Under</b> ' + esc(n.context.heading) + '</span>' : '') +
          (n.context.text ? '<span><b>Element said</b> ' + esc(n.context.text) + '</span>' : '') +
          (n.context.before ? '<span><b>Before it</b> ' + esc(n.context.before) + '</span>' : '') +
          (n.context.after ? '<span><b>After it</b> ' + esc(n.context.after) + '</span>' : '') +
          '</div>'
        : '') +
      '<code>' + esc(n.selector) + '</code>' +
      '<div class="top" style="margin-top:10px"><span><b>' + esc(n.author || 'Unknown') + '</b>' +
      (n.team ? ' &middot; ' + esc(n.team) : '') + '</span>' +
      '<span>' + esc(n.createdAt ? new Date(n.createdAt).toLocaleString() : '') + '</span></div>';
    return d;
  }

  function paintNotes() {
    var wrap = $('#viewer-notes');
    if (!wrap || !current) return;
    wrap.innerHTML = '';
    var notes = current.notes;

    if (noteLayout === 'width') {
      wrap.className = 'by-width';
      WIDTH_COLS.forEach(function (col) {
        var inCol = notes.filter(function (n) {
          var a = scopeOf(n);
          return a.indexOf('all') > -1 || a.indexOf(col.id) > -1;
        });
        var c = document.createElement('div');
        c.className = 'width-col';
        c.innerHTML = '<div class="width-head">' + esc(col.label) + ' &middot; ' + inCol.length + '</div>';
        if (!inCol.length) {
          c.innerHTML += '<div class="width-empty">Nobody has looked</div>';
        } else {
          inCol.forEach(function (n) {
            var mini = document.createElement('div');
            mini.className = 'width-note';
            mini.innerHTML = '<div class="width-sel">' + esc(n.selector.slice(0, 40)) + '</div>' +
              '<div class="width-body">' + esc(n.body) + '</div>' +
              '<div class="width-by">' + esc(n.author || 'Unknown') + '</div>';
            c.appendChild(mini);
          });
        }
        wrap.appendChild(c);
      });
      return;
    }

    wrap.className = '';
    notes.forEach(function (n, i) { wrap.appendChild(noteCard(n, i)); });
    loadShots(wrap);
  }

  // Screenshots sit in a private bucket, so the urls are minted per view and expire.
  function loadShots(root) {
    var slots = [].slice.call(root.querySelectorAll('[data-shot]'));
    if (!slots.length || !token) return;
    var paths = slots.map(function (s) { return s.getAttribute('data-shot'); });
    fetch(CFG.supabaseUrl.replace(/\/$/, '') + '/functions/v1/why-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ token: token, action: 'shot_urls', paths: paths })
    }).then(function (r) { return r.json(); }).then(function (res) {
      var urls = (res && res.urls) || {};
      slots.forEach(function (slot) {
        var u = urls[slot.getAttribute('data-shot')];
        if (!u) { slot.remove(); return; }
        var a = document.createElement('a');
        a.href = u; a.target = '_blank'; a.rel = 'noopener';
        a.innerHTML = '<img src="' + esc(u) + '" alt="The element when the note was written">';
        slot.appendChild(a);
      });
    }, function () { slots.forEach(function (s) { s.remove(); }); });
  }

  function showViewerLegacy(title, url, notes, onDelete) {
    var wrap = $('#viewer-notes');
    wrap.innerHTML = '';
    notes.forEach(function (n, i) {
      wrap.appendChild(noteCard(n, i));
    });
  }

  function openLocal(id) {
    var db = localDb(), p = null;
    db.pages.forEach(function (x) { if (pageId(x) === id) p = x; });
    if (!p) return;
    showViewer(p.title || p.path, p.url, p.notes, function () {
      var d = localDb();
      d.pages = d.pages.filter(function (x) { return pageId(x) !== id; });
      saveLocal(d); current = null; go('notes'); renderLibrary(); toast('Page removed.');
    });
  }

  function openCloud(page) {
    var rows = [];
    sb.from('why_notes').select('*').eq('page_id', page.id).is('deleted_at', null)
      .order('created_at', { ascending: true })
      .then(function (res) {
        if (res.error) { toast(res.error.message); return Promise.reject(res.error); }
        rows = res.data || [];
        var ids = rows.map(function (r) { return r.user_id; });
        var teamIds = rows.map(function (r) { return r.team_id; }).filter(Boolean);
        return Promise.all([
          ids.length ? sb.from('why_profiles').select('user_id, display_name').in('user_id', ids) : { data: [] },
          teamIds.length ? sb.from('why_teams').select('id, name').in('id', teamIds) : { data: [] }
        ]);
      })
      .then(function (pair) {
        var names = {}, teams = {};
        ((pair[0] || {}).data || []).forEach(function (p) { names[p.user_id] = p.display_name; });
        ((pair[1] || {}).data || []).forEach(function (t) { teams[t.id] = t.name; });
        var notes = rows.map(function (r) {
          var n = fromRow(r);
          n.author = names[r.user_id] || n.author || 'Unknown';
          n.team = r.team_id ? teams[r.team_id] : null;
          return n;
        });
        showViewer(page.title || page.path, page.url, notes, function () {
          sb.from('why_pages').delete().eq('id', page.id).then(function (r) {
            if (r.error) { toast(r.error.message); return; }
            current = null; go('notes'); renderLibrary(); toast('Page deleted.');
          });
        });
      });
  }

  /* ---------- exports ---------- */



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

  /* ---------- hash import from the annotator ---------- */

  function decodeHash() {
    var m = location.hash.match(/#import=(.+)$/);
    if (!m) { route(); return; }
    var parsed = null;
    try {
      var b = m[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      parsed = JSON.parse(decodeURIComponent(escape(atob(b))));
    } catch (e) { toast('That import link could not be read.'); return; }
    mergeLocal(parsed);
    history.replaceState(null, '', location.pathname + '#/notes');
    route();
  }

  /* ---------- boot ---------- */

  function boot() {
    sb.auth.getUser().then(function (res) {
      user = (res.data && res.data.user) || null;
      if (user) {
        ensureToken()
          .then(loadWorkspace)
          .then(absorbLocal)
          .then(loadInbox)
          .then(loadKeys)
          .then(loadChanges)
          .then(loadRepos)
          .then(function () {
            applyAuthState();
            renderWho(); renderAccount(); renderWorkspace(); renderSetup();
            renderLibrary(); renderInbox(); renderApi(); renderChanges(); renderRepos(); renderBuild();
          });
      } else {
        token = null; profile = null; orgs = []; myRole = null;
        loadProviders().then(function () {
          applyAuthState();
          renderWho(); renderAccount(); renderLibrary();
        });
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('#bookmarklet').addEventListener('click', function (e) {
      e.preventDefault();
      toast('Drag this to your bookmarks bar, or copy the code.');
    });
    var snippetBtn = $('#copy-snippet');
    if (snippetBtn) snippetBtn.addEventListener('click', function () { copy($('#snippet').textContent, 'Script tag'); });

    $('#import-btn').addEventListener('click', function () {
      var raw = $('#import-text').value.trim();
      if (!raw) { toast('Paste an export first.'); return; }
      try { mergeLocal(JSON.parse(raw)); $('#import-text').value = ''; }
      catch (e) { toast('That is not valid WhyTho JSON.'); }
    });

    $('#viewer-close').addEventListener('click', function () { current = null; go('notes'); });

    var repoBtn = $('#repo-add');
    if (repoBtn) repoBtn.addEventListener('click', addRepo);

    var keyBtn = $('#key-create');
    if (keyBtn) keyBtn.addEventListener('click', createKey);

    $('#mark-all-read').addEventListener('click', function () {
      var ids = inbox.filter(function (n) { return !n.read_at; }).map(function (n) { return n.id; });
      if (!ids.length) { toast('Nothing unread.'); return; }
      markRead(ids).then(function () { renderInbox(); toast('Inbox cleared.'); });
    });
    $('#viewer-delete').addEventListener('click', function () { if (current && current.remove) current.remove(); });

    document.querySelectorAll('[data-layout]').forEach(function (b) {
      b.addEventListener('click', function () {
        noteLayout = b.getAttribute('data-layout');
        document.querySelectorAll('[data-layout]').forEach(function (x) {
          x.classList.toggle('on', x === b);
        });
        paintNotes();
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
