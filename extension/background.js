// WhyTho background worker.
// The annotator itself is packaged with the extension rather than fetched, because
// manifest v3 forbids running remote code. It is injected into the page world so it
// can read the DOM and talk to the sync endpoint as the page's own origin would.

async function tokenFor() {
  var stored = await chrome.storage.sync.get('token');
  return stored.token || '';
}

// Injected alongside the annotator. It is the only thing that can carry a screenshot
// request from the page world out to the extension, since the page cannot talk to us.
function relay() {
  if (window.__whyRelay__) return;
  window.__whyRelay__ = true;
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.type !== 'whytho:shot') return;
    chrome.runtime.sendMessage({ type: 'whytho:capture', rect: e.data.rect, dpr: e.data.dpr }, function (res) {
      window.postMessage({
        type: 'whytho:shot:result',
        dataUrl: res && res.dataUrl,
        error: (res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || null
      }, '*');
    });
  });
}

function inject(token) {
  if (window.__why__) { window.__why__.toggle(); return 'toggled'; }
  var s = document.createElement('script');
  s.src = chrome.runtime.getURL('annotator.js');
  if (token) s.setAttribute('data-why-token', token);
  s.setAttribute('data-why-source', 'extension');
  (document.body || document.documentElement).appendChild(s);
  return 'started';
}

async function run(tabId) {
  var token = await tokenFor();
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId }, world: 'ISOLATED', func: relay });
    var out = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'ISOLATED',
      func: inject,
      args: [token]
    });
    return out && out[0] ? out[0].result : null;
  } catch (e) {
    return { error: e.message };
  }
}

// Capture the visible tab, crop to the element with a margin, and mark it.
async function capture(rect, dpr, windowId) {
  var shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  var bitmap = await createImageBitmap(await (await fetch(shot)).blob());

  var pad = 28;
  var sx = Math.max(0, (rect.x - pad) * dpr);
  var sy = Math.max(0, (rect.y - pad) * dpr);
  var sw = Math.min(bitmap.width - sx, (rect.w + pad * 2) * dpr);
  var sh = Math.min(bitmap.height - sy, (rect.h + pad * 2) * dpr);
  if (sw < 4 || sh < 4) throw new Error('The element is not visible on screen.');

  // Keep it readable but small: notes are text, the picture is a reminder.
  var maxW = 900;
  var scale = Math.min(1, maxW / sw);
  var out = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
  var ctx = out.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, out.width, out.height);

  ctx.strokeStyle = '#7c3aed';
  ctx.lineWidth = Math.max(2, 3 * scale * dpr);
  ctx.strokeRect(
    (rect.x * dpr - sx) * scale, (rect.y * dpr - sy) * scale,
    rect.w * dpr * scale, rect.h * dpr * scale
  );

  var blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  var buf = await blob.arrayBuffer();
  var bytes = new Uint8Array(buf);
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:image/jpeg;base64,' + btoa(bin);
}

chrome.commands.onCommand.addListener(function (command, tab) {
  if (command === 'toggle-whytho' && tab && tab.id) run(tab.id);
});

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (msg && msg.type === 'whytho:capture') {
    capture(msg.rect, msg.dpr || 1, sender.tab && sender.tab.windowId)
      .then(function (dataUrl) { reply({ dataUrl: dataUrl }); })
      .catch(function (e) { reply({ error: e.message }); });
    return true;
  }
  if (msg && msg.type === 'whytho:run' && msg.tabId) {
    run(msg.tabId).then(function (r) { reply({ ok: true, result: r }); });
    return true;
  }
  if (msg && msg.type === 'whytho:token') {
    chrome.storage.sync.set({ token: msg.token, account: msg.account || '' })
      .then(function () { reply({ ok: true }); });
    return true;
  }
});
