/* Unlabel page logic. Everything runs on this device; no network requests. */
(function () {
  'use strict';

  var cleaner = window.UnlabelCleaner;
  var zipper = window.UnlabelZip;

  var input = document.getElementById('file');
  var tray = document.getElementById('tray');
  var results = document.getElementById('results');
  var list = document.getElementById('prints');
  var title = document.getElementById('results-title');
  var allBtn = document.getElementById('download-all');
  var clearBtn = document.getElementById('clear');
  var progress = document.getElementById('progress');
  var chase = document.getElementById('chase');
  var progressText = document.getElementById('progress-text');

  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var items = [];
  var queue = Promise.resolve();
  var nextId = 1;
  var slipNo = 1;

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
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || ICONS.extra) + '</svg>';
  }
  var DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>';
  var CLIP = '<svg class="clip" viewBox="0 0 22 46" aria-hidden="true"><rect x="3" y="0" width="7" height="46" rx="2" fill="#c8a97a"/><rect x="12" y="0" width="7" height="46" rx="2" fill="#b8996a"/><rect x="1" y="17" width="20" height="5" rx="2" fill="#8a8f96"/></svg>';

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
    return (name.replace(/\.[^.]+$/, '') || 'photo') + '-unlabeled.' + ext;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function pad(n) { return ('000' + n).slice(-4); }

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

  // Formats we can't edit in place (HEIC, AVIF, GIF...) are drawn with their rotation
  // applied and saved as a fresh JPEG, which carries no metadata at all.
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

  // Cleaning takes milliseconds; the developing time lets people see it happen.
  function developTime() {
    if (reduceMotion) return 0;
    var n = items.length;
    return n <= 3 ? 1100 : n <= 10 ? 650 : 280;
  }

  function process(item) {
    item.status = 'working';
    renderChase();
    var started = Date.now();
    return readFile(item.file).then(function (buf) {
      return cleaner.clean(new Uint8Array(buf)) || convert(item.file);
    }).then(function (r) {
      item.result = r;
      item.blob = new Blob([r.bytes], { type: r.type });
      item.url = URL.createObjectURL(item.blob);
      item.outName = outName(item.file.name, r.ext);
      item.ok = true;
    }).catch(function () {
      var heic = /\.(heic|heif)$/i.test(item.file.name) || /hei[cf]/i.test(item.file.type);
      item.error = heic
        ? 'This browser can’t open HEIC photos. Open the page in Safari, or export the photo as JPEG.'
        : 'Couldn’t read this file. Try a JPEG or PNG.';
    }).then(function () {
      return wait(Math.max(0, developTime() - (Date.now() - started)));
    }).then(function () {
      item.status = item.ok ? 'done' : 'error';
      item.file = null;
      render(item);
      update();
    });
  }

  function addFiles(fileList) {
    var files = Array.prototype.filter.call(fileList || [], function (f) {
      return /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|avif|gif|tiff?|bmp)$/i.test(f.name);
    });
    if (!files.length) {
      if (fileList && fileList.length) progressText.textContent = 'Those files aren’t photos.';
      progress.hidden = false;
      return;
    }
    var first = !items.length;
    results.hidden = false;
    files.forEach(function (file) {
      var item = { id: nextId++, no: slipNo++, file: file, name: file.name || 'photo', status: 'queued' };
      items.push(item);
      render(item);
      queue = queue.then(function () { return process(item); });
    });
    update();
    if (first) {
      setTimeout(function () {
        results.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      }, reduceMotion ? 0 : 350);
    }
  }

  // ---------------------------------------------------------- rendering

  function slipHead(item) {
    return '<div class="slip-head"><b>Lab slip</b><span>No. ' + pad(item.no) + '</span></div>';
  }

  function render(item) {
    var li = document.getElementById('job-' + item.id);
    if (!li) {
      li = document.createElement('li');
      li.id = 'job-' + item.id;
      list.appendChild(li);
    }

    if (item.status === 'queued' || item.status === 'working') {
      li.className = 'job working';
      li.innerHTML =
        '<figure class="print">' + CLIP + '<div class="photo"></div><figcaption>' + esc(item.name) + '</figcaption></figure>' +
        '<div class="slip">' + slipHead(item) +
          '<div class="slip-name">' + esc(item.name) + '</div>' +
          '<p class="developing-note">' + (item.status === 'working' ? 'Developing' : 'Waiting for the tray') + '</p>' +
        '</div>';
      return;
    }

    if (item.status === 'error') {
      li.className = 'job error';
      li.innerHTML =
        '<figure class="print">' + CLIP + '<div class="photo"></div><figcaption>' + esc(item.name) + '</figcaption></figure>' +
        '<div class="slip">' + slipHead(item) +
          '<div class="slip-name">' + esc(item.name) + '</div>' +
          '<p class="nothing">' + esc(item.error) + '</p>' +
          '<div class="slip-foot"><span class="stamp">Not developed</span></div>' +
        '</div>';
      return;
    }

    var r = item.result;
    var rows = r.removed.map(function (x, i) {
      return '<li class="' + (x.key === 'ai' ? 'ai' : '') + '" style="--i:' + i + '">' + icon(x.key) +
        '<div><b>' + esc(x.label) + '</b>' + (x.detail ? '<span><s>' + esc(x.detail) + '</s></span>' : '') + '</div></li>';
    }).join('');
    var hasAi = r.removed.some(function (x) { return x.key === 'ai'; });
    var body = r.removed.length
      ? '<ul class="removed" aria-label="Removed from this photo">' + rows + '</ul>'
      : '<p class="nothing">No AI tags or hidden data found. This photo was already clean.</p>';

    li.className = 'job developed';
    li.innerHTML =
      '<figure class="print">' + CLIP + '<div class="photo"><img alt="Cleaned copy of ' + esc(item.name) + '" src="' + item.url + '"></div>' +
        '<figcaption>' + esc(item.outName) + '</figcaption></figure>' +
      '<div class="slip">' + slipHead(item) +
        '<div class="slip-name">' + esc(item.name) + '</div>' +
        '<div class="slip-meta">' + size(r.bytes.length) + ' · ' + (r.removed.length ? r.removed.length + ' removed' : 'nothing to remove') + '</div>' +
        body +
        '<div class="slip-foot"><span class="stamp">' + (hasAi ? 'AI label tags removed' : 'Clean') + '</span>' +
          '<a class="btn btn-ink" href="' + item.url + '" download="' + esc(item.outName) + '">' + DOWNLOAD + 'Download</a></div>' +
      '</div>';
  }

  function renderChase() {
    progress.hidden = !items.length;
    chase.innerHTML = items.map(function (i) {
      var c = i.status === 'working' ? 'on' : i.status === 'done' ? 'done' : i.status === 'error' ? 'fail' : '';
      return '<i class="' + c + '"></i>';
    }).join('');
    var done = items.filter(function (i) { return i.status === 'done' || i.status === 'error'; }).length;
    var busy = done < items.length;
    tray.classList.toggle('busy', busy);
    var ready = items.filter(function (i) { return i.status === 'done'; }).length;
    progressText.textContent = busy
      ? 'Developing ' + Math.min(done + 1, items.length) + ' of ' + items.length
      : ready + (ready === 1 ? ' print' : ' prints') + ' ready';
    var working = items.filter(function (i) { return i.status === 'working'; })[0];
    if (working) {
      var note = document.querySelector('#job-' + working.id + ' .developing-note');
      if (note) note.textContent = 'Developing';
    }
  }

  function update() {
    renderChase();
    var done = items.filter(function (i) { return i.status === 'done'; });
    var busy = items.some(function (i) { return i.status === 'working' || i.status === 'queued'; });
    title.textContent = busy ? 'Developing…' : (done.length === 1 ? 'Your print' : 'Your prints');
    allBtn.hidden = items.length < 2;
    allBtn.disabled = busy || done.length < 2;
  }

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
    a.download = 'unlabeled-photos.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function clearAll() {
    if (items.some(function (i) { return i.status === 'working' || i.status === 'queued'; })) return;
    items.forEach(function (i) { if (i.url) URL.revokeObjectURL(i.url); });
    items = [];
    slipNo = 1;
    list.innerHTML = '';
    results.hidden = true;
    progress.hidden = true;
    tray.classList.remove('busy');
    input.value = '';
    tray.focus();
  }

  // ---------------------------------------------------------- input

  input.addEventListener('change', function () { addFiles(input.files); input.value = ''; });
  tray.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  allBtn.addEventListener('click', downloadAll);
  clearBtn.addEventListener('click', clearAll);

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
  window.addEventListener('paste', function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) addFiles(files);
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
