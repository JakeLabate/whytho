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

  // Show the neighbourhood, not just the element. Padding scales with the element and
  // is floored, so a small link still comes back with enough page around it to place it.
  var vw = bitmap.width / dpr;
  var vh = bitmap.height / dpr;

  var padX = Math.min(420, Math.max(180, rect.w * 0.6));
  var padY = Math.min(340, Math.max(140, rect.h * 1.1));

  var x = rect.x - padX;
  var y = rect.y - padY;
  var w = rect.w + padX * 2;
  var h = rect.h + padY * 2;

  // A floor on the crop itself, so tiny elements do not produce a tiny picture.
  var minW = 760, minH = 460;
  if (w < minW) { x -= (minW - w) / 2; w = minW; }
  if (h < minH) { y -= (minH - h) / 2; h = minH; }

  // Never ask for more than the viewport holds, and keep the crop inside it.
  w = Math.min(w, vw);
  h = Math.min(h, vh);
  x = Math.max(0, Math.min(x, vw - w));
  y = Math.max(0, Math.min(y, vh - h));

  var sx = x * dpr, sy = y * dpr, sw = w * dpr, sh = h * dpr;
  if (sw < 4 || sh < 4) throw new Error('The element is not visible on screen.');

  var maxW = 1200;
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
