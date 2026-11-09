/* Plainshot page logic. Everything runs on this device; no network requests. */
(function () {
  'use strict';

  var cleaner = window.PlainshotCleaner;
  var zipper = window.PlainshotZip;

  var input = document.getElementById('file');
  var drop = document.getElementById('drop');
  var results = document.getElementById('results');
  var list = document.getElementById('cards');
  var title = document.getElementById('results-title');
  var allBtn = document.getElementById('download-all');
  var clearBtn = document.getElementById('clear');
  var live = document.getElementById('live');

  var items = [];
  var queue = Promise.resolve();
  var nextId = 1;

  var ICONS = {
    location: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    ai: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    device: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.3-2h6l1.3 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.2"/>',
    time: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    history: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M12 8v4l2.5 1.5"/>',
    author: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
    text: '<path d="M5 6h14M5 10.5h14M5 15h9"/>',
    thumbnail: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 15.5l4.5-4 4 3.5 2.5-2 5 4"/>',
    extra: '<path d="M12 3.5l8 4.5v8l-8 4.5-8-4.5V8z"/><path d="M4 8l8 4.5L20 8M12 12.5V21"/>',
    converted: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>'
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || ICONS.extra) + '</svg>';
  }
  var CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function size(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function outName(name, ext) {
    var base = name.replace(/\.[^.]+$/, '') || 'photo';
    return base + '-clean.' + ext;
  }

  // ---------------------------------------------------------- cleaning

  function readFile(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsArrayBuffer(file);
    });
  }

  // For formats we can't edit in place (HEIC, AVIF, TIFF, GIF...), draw the picture
  // with its rotation applied and save a fresh JPEG, which carries no metadata at all.
  function convert(file) {
    var load = window.createImageBitmap
      ? createImageBitmap(file, { imageOrientation: 'from-image' })
      : Promise.reject(new Error('unsupported'));
    return load.catch(function () {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        var url = URL.createObjectURL(file);
        img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
        img.src = url;
      });
    }).then(function (bmp) {
      var w = bmp.width, h = bmp.height;
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx;
      try { ctx = canvas.getContext('2d', { colorSpace: 'display-p3' }); } catch (e) { ctx = null; }
      ctx = ctx || canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('encode')); }, 'image/jpeg', 0.95);
      });
    }).then(readFile).then(function (buf) {
      var r = cleaner.clean(new Uint8Array(buf));
      r.removed = [{ key: 'converted', label: 'Everything hidden', detail: 'Saved as a fresh JPEG' }];
      return r;
    });
  }

  function process(item) {
    return readFile(item.file).then(function (buf) {
      var r = cleaner.clean(new Uint8Array(buf));
      return r || convert(item.file);
    }).then(function (r) {
      item.result = r;
      item.blob = new Blob([r.bytes], { type: r.type });
      item.url = URL.createObjectURL(item.blob);
      item.outName = outName(item.file.name, r.ext);
      item.status = 'done';
    }).catch(function () {
      item.status = 'error';
      var heic = /\.(heic|heif)$/i.test(item.file.name) || /hei[cf]/i.test(item.file.type);
      item.error = heic
        ? 'This browser can’t open HEIC photos. Open the page in Safari, or export the photo as JPEG.'
        : 'Couldn’t read this file. Try a JPEG or PNG.';
    }).then(function () {
      item.file = null; // let the original go
      render(item);
      update();
    });
  }

  function addFiles(fileList) {
    var files = Array.prototype.filter.call(fileList || [], function (f) {
      return /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|avif|gif|tiff?|bmp)$/i.test(f.name);
    });
    if (!files.length) {
      if (fileList && fileList.length) announce('Those files aren’t photos.');
      return;
    }
    document.body.classList.add('has-results');
    results.hidden = false;
    files.forEach(function (file) {
      var item = { id: nextId++, file: file, name: file.name || 'photo', status: 'working' };
      items.push(item);
      render(item);
      queue = queue.then(function () { return process(item); });
    });
    update();
    if (items.length === files.length) results.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  // ---------------------------------------------------------- rendering

  function render(item) {
    var li = document.getElementById('card-' + item.id);
    if (!li) {
      li = document.createElement('li');
      li.id = 'card-' + item.id;
      list.appendChild(li);
    }
    li.className = 'card' + (item.status === 'error' ? ' error' : '');

    if (item.status === 'working') {
      li.innerHTML = '<div class="card-head"><div class="thumb loading"></div><div class="meta"><div class="name">' + esc(item.name) +
        '</div><div class="status">Cleaning…</div></div></div>';
      return;
    }
    if (item.status === 'error') {
      li.innerHTML = '<div class="card-head"><div class="thumb"></div><div class="meta"><div class="name">' + esc(item.name) +
        '</div><div class="status">' + esc(item.error) + '</div></div></div>';
      return;
    }

    var r = item.result;
    var rows = r.removed.map(function (x) {
      return '<li>' + icon(x.key) + '<div><b>' + esc(x.label) + '</b>' + (x.detail ? ' <span><s>' + esc(x.detail) + '</s></span>' : '') + '</div></li>';
    }).join('');
    var body = r.removed.length
      ? '<ul class="removed" aria-label="Removed from this photo">' + rows + '</ul>'
      : '<p class="nothing">No hidden data found. This photo was already clean.</p>';

    li.innerHTML =
      '<div class="card-head">' +
        '<img class="thumb" alt="" src="' + item.url + '">' +
        '<div class="meta"><div class="name" title="' + esc(item.outName) + '">' + esc(item.name) + '</div>' +
          '<div class="status"><span class="badge">' + CHECK + 'Clean</span>' + size(r.bytes.length) +
          (r.removed.length ? ' · ' + r.removed.length + ' removed' : '') + '</div></div>' +
        '<a class="btn btn-quiet" href="' + item.url + '" download="' + esc(item.outName) + '">' + DOWNLOAD + 'Download</a>' +
      '</div>' + body;
  }

  function update() {
    var done = items.filter(function (i) { return i.status === 'done'; });
    var working = items.some(function (i) { return i.status === 'working'; });
    var n = items.length;
    title.textContent = working
      ? 'Cleaning ' + n + (n === 1 ? ' photo' : ' photos') + '…'
      : done.length + (done.length === 1 ? ' photo' : ' photos') + ' cleaned';
    allBtn.hidden = n < 2;
    allBtn.disabled = working || done.length < 2;
    // A single photo gets the strong button on its own card.
    var single = n === 1 && done.length === 1;
    list.querySelectorAll('.card .btn').forEach(function (b) {
      b.className = 'btn ' + (single ? 'btn-primary' : 'btn-quiet');
    });
    if (!working && n) announce(title.textContent);
  }

  function announce(msg) { live.textContent = msg; }

  function downloadAll() {
    var done = items.filter(function (i) { return i.status === 'done'; });
    var used = {};
    var files = done.map(function (i) {
      var name = i.outName, k = 2;
      while (used[name.toLowerCase()]) name = i.outName.replace(/(\.[^.]+)$/, '-' + (k++) + '$1');
      used[name.toLowerCase()] = true;
      return { name: name, bytes: i.result.bytes };
    });
    var blob = new Blob([zipper.zip(files)], { type: 'application/zip' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'plainshot-photos.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function clearAll() {
    items.forEach(function (i) { if (i.url) URL.revokeObjectURL(i.url); });
    items = [];
    list.innerHTML = '';
    results.hidden = true;
    document.body.classList.remove('has-results');
    input.value = '';
    announce('Cleared.');
    drop.focus();
  }

  // ---------------------------------------------------------- input

  input.addEventListener('change', function () { addFiles(input.files); input.value = ''; });
  drop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  allBtn.addEventListener('click', downloadAll);
  clearBtn.addEventListener('click', clearAll);

  // Drop anywhere on the page.
  var depth = 0;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1; }
  window.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragover', function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
  window.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    addFiles(e.dataTransfer.files);
  });
  // Paste a screenshot or copied photo.
  window.addEventListener('paste', function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) addFiles(files);
  });

  // Works offline after the first visit.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
