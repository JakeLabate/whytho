/* Shared navigation for the pages that are not the app.
   The app renders its own identity block because it already has the profile
   loaded; these pages have no session of their own, so this asks Supabase who
   is signed in and renders the same avatar, so the bar never changes shape
   depending on which page you happen to be standing on. */
(function () {
  'use strict';

  var CFG = window.WHY_CONFIG;
  var slot = document.getElementById('app-who');
  if (!slot || !CFG) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function signedOut() {
    slot.innerHTML = '<a class="who" href="./"><span class="who-text"><b>Sign in</b></span></a>';
  }

  function signedIn(name, avatar, org) {
    var initial = (name || '?').trim().charAt(0).toUpperCase();
    var pic = avatar
      ? '<img class="who-avatar" src="' + esc(avatar) + '" alt="">'
      : '<span class="who-avatar who-initial">' + esc(initial) + '</span>';
    slot.innerHTML = '<a class="who" href="./#/account">' + pic +
      '<span class="who-text"><b>' + esc(name) + '</b><span class="sub">' +
      esc(org || 'Personal') + '</span></span></a>';
  }

  if (!window.supabase) { signedOut(); return; }

  var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.publishableKey);
  signedOut();

  sb.auth.getUser().then(function (res) {
    var user = res.data && res.data.user;
    if (!user) return;
    sb.from('why_profiles').select('display_name, avatar_url, active_org_id')
      .eq('user_id', user.id).maybeSingle()
      .then(function (p) {
        var prof = p.data || {};
        if (!prof.active_org_id) {
          signedIn(prof.display_name || user.email, prof.avatar_url, 'Personal');
          return;
        }
        sb.from('why_orgs').select('name').eq('id', prof.active_org_id).maybeSingle()
          .then(function (o) {
            signedIn(prof.display_name || user.email, prof.avatar_url, (o.data && o.data.name) || 'Personal');
          });
      });
  }, function () { /* leave the signed out state in place */ });
})();
