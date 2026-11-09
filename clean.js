/*!
 * Plainshot cleaner
 * Removes hidden metadata from JPEG, PNG and WebP files without re-encoding.
 * The picture data is copied byte for byte, so quality and colors never change.
 * MIT License.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlainshotCleaner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- report

  var LABELS = {
    location: 'Location',
    device: 'Camera & phone',
    time: 'Date & time',
    ai: 'AI & source tags',
    history: 'Edit history',
    author: 'Name & copyright',
    text: 'Captions & comments',
    thumbnail: 'Hidden preview image',
    extra: 'Extra embedded data'
  };
  var ORDER = ['location', 'ai', 'device', 'time', 'history', 'author', 'text', 'thumbnail', 'extra'];

  function Report() { this.items = {}; }
  Report.prototype.add = function (key, detail) {
    var item = this.items[key] || (this.items[key] = { key: key, label: LABELS[key], details: [] });
    if (detail) {
      detail = String(detail).replace(/\s+/g, ' ').trim();
      if (detail.length > 60) detail = detail.slice(0, 57) + '...';
      if (detail && item.details.indexOf(detail) === -1) item.details.push(detail);
    }
  };
  Report.prototype.list = function () {
    var items = this.items;
    return ORDER.filter(function (k) { return items[k]; }).map(function (k) {
      var it = items[k];
      return { key: k, label: it.label, detail: it.details.slice(0, 2).join(' · ') };
    });
  };

  // ---------------------------------------------------------------- helpers

  function ascii(bytes, start, len) {
    var s = '';
    var end = Math.min(bytes.length, start + len);
    for (var i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  function startsWith(bytes, offset, str) {
    if (offset + str.length > bytes.length) return false;
    for (var i = 0; i < str.length; i++) if (bytes[offset + i] !== str.charCodeAt(i)) return false;
    return true;
  }
  function utf8(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); } catch (e) { return ascii(bytes, 0, bytes.length); }
  }
  function concat(chunks) {
    var total = 0, i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total), p = 0;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], p); p += chunks[i].length; }
    return out;
  }
  function cleanStr(s) {
    return String(s || '').replace(/\0+$/, '').replace(/[\x00-\x1f]/g, ' ').trim();
  }

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes, crc) {
    crc = crc === undefined ? 0xffffffff : crc;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return crc;
  }

  // Patterns that mark a picture as made or edited with AI.
  var AI_RE = /trainedAlgorithmicMedia|algorithmicMedia|c2pa|contentcredentials|Made with (Google )?AI|AI[- ]generated|AI[- ]edited|generative|Firefly|DALL[·.\- ]?E|Midjourney|Stable ?Diffusion|ComfyUI|Imagen|SynthID|negative prompt|sampler|cfg scale|Galaxy AI|Magic Editor|Magic Eraser|Generative ?Fill|OpenAI|Gemini/i;

  function aiDetail(text) {
    if (/compositeWithTrainedAlgorithmicMedia|AI[- ]edited|Generative ?Fill|Magic Editor|Magic Eraser|Generative ?edit/i.test(text)) return 'Marked as edited with AI';
    if (/trainedAlgorithmicMedia|AI[- ]generated|Made with (Google )?AI/i.test(text)) return 'Marked as AI-generated';
    var m = text.match(/Firefly|DALL[·.\- ]?E|Midjourney|Stable ?Diffusion|ComfyUI|Imagen|OpenAI|Gemini|Galaxy AI/i);
    if (m) return m[0];
    return '';
  }

  function formatExifDate(s) {
    var m = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2})/.exec(s || '');
    if (!m) return cleanStr(s).slice(0, 25);
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var mi = parseInt(m[2], 10) - 1;
    if (mi < 0 || mi > 11) return cleanStr(s).slice(0, 25);
    return parseInt(m[3], 10) + ' ' + months[mi] + ' ' + m[1] + ', ' + m[4] + ':' + m[5];
  }

  function deviceName(make, model) {
    make = cleanStr(make); model = cleanStr(model);
    if (!model) return make;
    if (!make) return model;
    var firstWord = make.split(' ')[0].toLowerCase();
    if (model.toLowerCase().indexOf(firstWord) === 0) return model;
    return make + ' ' + model;
  }

  // ---------------------------------------------------------------- EXIF (TIFF)

  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  // Reads an EXIF/TIFF block and returns what it reveals plus the orientation.
  function readTiff(t) {
    var res = { orientation: 1 };
    if (t.length < 8) return res;
    var le = t[0] === 0x49 && t[1] === 0x49;
    if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return res;
    var dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    function u16(o) { return dv.getUint16(o, le); }
    function u32(o) { return dv.getUint32(o, le); }
    if (u16(2) !== 42) return res;

    function readIfd(off) {
      var tags = {};
      if (!off || off + 2 > t.length) return { tags: tags, next: 0 };
      var n = u16(off);
      if (n > 1000) return { tags: tags, next: 0 };
      for (var i = 0; i < n; i++) {
        var e = off + 2 + i * 12;
        if (e + 12 > t.length) break;
        var tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        var size = (TYPE_SIZE[type] || 1) * count;
        var vo = size <= 4 ? e + 8 : u32(e + 8);
        tags[tag] = { type: type, count: count, off: vo, raw: u32(e + 8) };
      }
      var nextPos = off + 2 + n * 12;
      return { tags: tags, next: nextPos + 4 <= t.length ? u32(nextPos) : 0 };
    }
    function str(tag) {
      if (!tag || tag.off + tag.count > t.length) return '';
      return cleanStr(ascii(t, tag.off, Math.min(tag.count, 200)));
    }
    function short(tag) { return tag && tag.off + 2 <= t.length ? u16(tag.off) : 0; }
    function rationals(tag) {
      var out = [];
      if (!tag || tag.type !== 5) return out;
      for (var i = 0; i < tag.count && i < 3; i++) {
        var o = tag.off + i * 8;
        if (o + 8 > t.length) break;
        var d = u32(o + 4);
        out.push(d ? u32(o) / d : 0);
      }
      return out;
    }

    var ifd0 = readIfd(u32(4));
    var g = ifd0.tags;
    if (g[0x0112]) res.orientation = short(g[0x0112]) || 1;
    res.onlyOrientation = !ifd0.next && Object.keys(g).every(function (k) { return +k === 0x0112; });
    res.make = str(g[0x010f]);
    res.model = str(g[0x0110]);
    res.software = str(g[0x0131]);
    res.date = str(g[0x0132]);
    res.artist = str(g[0x013b]);
    res.copyright = str(g[0x8298]);
    res.description = str(g[0x010e]);
    if (ifd0.next) {
      var ifd1 = readIfd(ifd0.next);
      if (ifd1.tags[0x0201] || ifd1.tags[0x0111]) res.thumbnail = true;
    }
    if (g[0x8769]) {
      var ex = readIfd(g[0x8769].raw).tags;
      res.dateOriginal = str(ex[0x9003]);
      res.lens = str(ex[0xa434]);
      res.serial = !!(ex[0xa431] || ex[0xa435]);
      res.makerNote = !!ex[0x927c];
      res.userComment = !!ex[0x9286];
      res.uniqueId = !!ex[0xa420];
      res.owner = str(ex[0xa430]);
    }
    if (g[0x8825]) {
      var gps = readIfd(g[0x8825].raw).tags;
      res.gps = true;
      var lat = rationals(gps[2]), lon = rationals(gps[4]);
      if (lat.length === 3 && lon.length === 3) {
        var la = lat[0] + lat[1] / 60 + lat[2] / 3600;
        var lo = lon[0] + lon[1] / 60 + lon[2] / 3600;
        if (str(gps[1]).toUpperCase() === 'S') la = -la;
        if (str(gps[3]).toUpperCase() === 'W') lo = -lo;
        if (la || lo) res.coords = la.toFixed(4) + ', ' + lo.toFixed(4);
      }
    }
    return res;
  }

  function reportTiff(t, report) {
    var r;
    try { r = readTiff(t); } catch (e) { report.add('device', 'Camera info (EXIF)'); return 1; }
    var orientation = r.orientation >= 1 && r.orientation <= 8 ? r.orientation : 1;
    if (r.onlyOrientation) return orientation; // nothing private in here
    if (r.gps) report.add('location', r.coords || 'GPS coordinates');
    var dev = deviceName(r.make, r.model);
    if (dev) report.add('device', dev);
    if (r.lens && !dev) report.add('device', r.lens);
    if (r.serial) report.add('device', 'serial number');
    if (r.software) {
      if (/[a-z]{3,}/i.test(r.software)) report.add('history', 'Software: ' + r.software);
      else report.add('device', 'software ' + r.software);
    }
    if (r.dateOriginal || r.date) report.add('time', formatExifDate(r.dateOriginal || r.date));
    if (r.artist || r.copyright || r.owner) report.add('author', r.artist || r.owner || r.copyright);
    if (r.description) report.add('text', r.description);
    if (r.userComment) report.add('text');
    if (r.thumbnail) report.add('thumbnail', 'Can show the photo before cropping');
    if (r.makerNote) report.add('device', 'maker notes');
    if (!r.gps && !dev && !r.dateOriginal && !r.date && !r.software && !r.thumbnail) report.add('device', 'Camera info (EXIF)');
    if (AI_RE.test(r.software + ' ' + r.description + ' ' + r.artist)) report.add('ai', aiDetail(r.software + ' ' + r.description) || 'AI source tag');
    return orientation;
  }

  // A tiny EXIF block holding nothing but the rotation, so photos don't turn sideways.
  function orientationTiff(orientation) {
    return new Uint8Array([
      0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, IFD0 at 8
      0x00, 0x01, // one entry
      0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, orientation >> 8, orientation & 0xff, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00 // no next IFD
    ]);
  }

  // ---------------------------------------------------------------- XMP / IPTC / text

  function reportXmp(text, report) {
    var found = false;
    if (AI_RE.test(text)) { report.add('ai', aiDetail(text) || 'AI source tags'); found = true; }
    var tool = /CreatorTool(?:="|>)([^"<]{1,80})/.exec(text);
    if (/xmpMM:History|stEvt:|xmpMM:DerivedFrom|xmpMM:Ingredients|crs:|photoshop:History|lr:hierarchicalSubject|xmpMM:Pantry/.test(text)) {
      report.add('history', tool ? tool[1] : 'Editing steps');
      found = true;
    } else if (tool) {
      report.add('history', 'Software: ' + tool[1]);
      found = true;
    }
    if (/GPSLatitude|GPSLongitude|photoshop:City|photoshop:Country|Iptc4xmpCore:Location|Iptc4xmpExt:LocationShown/.test(text)) { report.add('location'); found = true; }
    var date = /(?:DateTimeOriginal|CreateDate|DateCreated)(?:="|>)([^"<]{4,40})/.exec(text);
    if (date) { report.add('time', formatExifDate(date[1].replace('T', ' '))); found = true; }
    var model = /tiff:Model(?:="|>)([^"<]{1,60})/.exec(text);
    var make = /tiff:Make(?:="|>)([^"<]{1,60})/.exec(text);
    if (model || /aux:Lens|aux:SerialNumber|exifEX:LensModel/.test(text)) {
      report.add('device', deviceName(make && make[1], model && model[1]) || 'Lens info');
      found = true;
    }
    if (/dc:creator|dc:rights|xmpRights:|photoshop:AuthorsPosition|Iptc4xmpCore:CreatorContactInfo/.test(text)) { report.add('author'); found = true; }
    if (/dc:description|dc:subject|dc:title/.test(text)) { report.add('text'); found = true; }
    if (/GCamera:|hdrgm:|GDepth:|GImage:|Camera:MotionPhoto/.test(text)) { report.add('extra', 'Depth, HDR or motion data'); found = true; }
    if (!found) report.add('extra', 'Photo info (XMP)');
  }

  // Photoshop "8BIM" resource block, which carries IPTC captions and credits.
  function reportPhotoshop(b, report) {
    var text = ascii(b, 0, b.length);
    if (AI_RE.test(text)) report.add('ai', aiDetail(text) || 'AI source tags');
    var p = 0, found = false;
    while (p + 12 <= b.length) {
      if (!startsWith(b, p, '8BIM')) break;
      var id = (b[p + 4] << 8) | b[p + 5];
      var nameLen = b[p + 6];
      var q = p + 6 + 1 + nameLen;
      if (q % 2) q++;
      if (q + 4 > b.length) break;
      var size = ((b[q] << 24) | (b[q + 1] << 16) | (b[q + 2] << 8) | b[q + 3]) >>> 0;
      var data = b.subarray(q + 4, Math.min(b.length, q + 4 + size));
      if (id === 0x0404) { found = reportIptc(data, report) || found; }
      else if (id === 0x0409 || id === 0x040c) { report.add('thumbnail'); found = true; }
      p = q + 4 + size + (size % 2);
    }
    if (!found) report.add('extra', 'Photoshop data');
  }

  function reportIptc(d, report) {
    var p = 0, found = false;
    while (p + 5 <= d.length && d[p] === 0x1c) {
      var rec = d[p + 1], ds = d[p + 2];
      var len = (d[p + 3] << 8) | d[p + 4];
      if (len & 0x8000) break;
      var val = cleanStr(utf8(d.subarray(p + 5, p + 5 + len)));
      if (rec === 2) {
        if (ds === 80 || ds === 116 || ds === 110 || ds === 115) { report.add('author', ds === 80 ? val : ''); found = true; }
        else if (ds === 55 || ds === 60) { report.add('time'); found = true; }
        else if (ds === 90 || ds === 92 || ds === 95 || ds === 100 || ds === 101) { report.add('location', val); found = true; }
        else if (ds === 120 || ds === 25 || ds === 5 || ds === 105) { report.add('text'); found = true; }
        else if (ds === 65 || ds === 70) { report.add('history', val ? 'Software: ' + val : ''); found = true; }
      }
      p += 5 + len;
    }
    return found;
  }

  function reportText(keyword, text, report) {
    var k = (keyword || '').toLowerCase();
    var all = keyword + ' ' + text;
    if (k === 'xml:com.adobe.xmp') { reportXmp(text, report); return; }
    if (/^(parameters|prompt|workflow|dream|sd-metadata|invokeai_metadata|generation_data|negative_prompt)$/.test(k) || AI_RE.test(all)) {
      report.add('ai', aiDetail(all) || 'AI prompt and settings');
      return;
    }
    if (k === 'software') { report.add('history', text ? 'Software: ' + text : ''); return; }
    if (k === 'creation time' || k === 'date:create' || k === 'date:modify' || k === 'date:timestamp') { report.add('time', text); return; }
    if (k === 'author' || k === 'copyright' || k === 'source' || k === 'disclaimer') { report.add('author', k === 'author' ? text : ''); return; }
    if (k === 'raw profile type exif' || k === 'raw profile type app1') { report.add('device', 'Camera info (EXIF)'); return; }
    if (k.indexOf('raw profile type') === 0) { report.add('extra'); return; }
    report.add('text');
  }

  // ---------------------------------------------------------------- JPEG

  function jpegSegment(marker, payload) {
    var len = payload.length + 2;
    if (len > 0xffff) throw new Error('Segment too large');
    var seg = new Uint8Array(payload.length + 4);
    seg[0] = 0xff; seg[1] = marker; seg[2] = len >> 8; seg[3] = len & 0xff;
    seg.set(payload, 4);
    return seg;
  }

  function cleanJpeg(b) {
    var report = new Report();
    var out = [b.subarray(0, 2)];
    var orientation = 1;
    var exifSlot = -1; // where to put the rotation-only EXIF block
    var sawFrame = false, ended = false;
    var p = 2;

    while (p + 1 < b.length) {
      if (b[p] !== 0xff) throw new Error('This JPEG looks damaged.');
      while (b[p + 1] === 0xff && p + 2 < b.length) p++; // fill bytes
      var m = b[p + 1];

      if (m === 0xd9) { out.push(b.subarray(p, p + 2)); p += 2; ended = true; break; }
      if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { out.push(b.subarray(p, p + 2)); p += 2; continue; }
      if (p + 4 > b.length) throw new Error('This JPEG looks damaged.');

      var len = (b[p + 2] << 8) | b[p + 3];
      var end = p + 2 + len;
      if (len < 2 || end > b.length) throw new Error('This JPEG looks damaged.');
      var payload = b.subarray(p + 4, end);

      if (m === 0xda) {
        // Start of scan: copy the compressed picture data untouched up to the next marker.
        var q = end;
        while (q < b.length) {
          if (b[q] === 0xff && q + 1 < b.length) {
            var n = b[q + 1];
            if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { q += 2; continue; }
            if (n === 0xff) { q++; continue; }
            break;
          }
          q++;
        }
        out.push(b.subarray(p, q));
        p = q;
        continue;
      }

      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) sawFrame = true;

      if (m === 0xe0) {
        if (startsWith(payload, 0, 'JFIF\0') && payload.length >= 14) {
          // Keep the JFIF header but drop any thumbnail inside it.
          var j = new Uint8Array(payload.subarray(0, 14));
          if (j[12] || j[13]) report.add('thumbnail');
          j[12] = 0; j[13] = 0;
          out.push(jpegSegment(0xe0, j));
          if (exifSlot < 0) exifSlot = out.length;
        } else if (startsWith(payload, 0, 'JFXX\0')) {
          report.add('thumbnail');
        } else {
          report.add('extra');
        }
      } else if (m === 0xe1) {
        if (startsWith(payload, 0, 'Exif\0')) {
          var o = reportTiff(payload.subarray(6), report);
          if (o !== 1 && orientation === 1) orientation = o;
        } else if (startsWith(payload, 0, 'http://ns.adobe.com/xap/1.0/')) {
          reportXmp(utf8(payload.subarray(29)), report);
        } else if (startsWith(payload, 0, 'http://ns.adobe.com/xmp/extension/')) {
          reportXmp(utf8(payload.subarray(75)), report);
        } else {
          report.add('extra');
        }
      } else if (m === 0xe2) {
        if (startsWith(payload, 0, 'ICC_PROFILE\0')) out.push(b.subarray(p, end)); // colors: keep
        else if (startsWith(payload, 0, 'MPF\0')) report.add('extra', 'Extra images (HDR or depth)');
        else report.add('extra');
      } else if (m === 0xeb) {
        var t11 = ascii(payload, 0, Math.min(payload.length, 4096));
        if (/c2pa|jumb|jumd/i.test(t11)) report.add('ai', 'Content Credentials (C2PA)');
        else report.add('extra');
      } else if (m === 0xed) {
        if (startsWith(payload, 0, 'Photoshop 3.0\0')) reportPhotoshop(payload.subarray(14), report);
        else report.add('extra');
      } else if (m === 0xee) {
        out.push(b.subarray(p, end)); // Adobe color transform: needed to show colors right
      } else if (m >= 0xe3 && m <= 0xef) {
        var tx = ascii(payload, 0, Math.min(payload.length, 4096));
        if (AI_RE.test(tx)) report.add('ai', aiDetail(tx) || 'AI source tags');
        else report.add('extra');
      } else if (m === 0xfe) {
        var c = cleanStr(utf8(payload));
        if (AI_RE.test(c)) report.add('ai', aiDetail(c) || 'AI source tags');
        else report.add('text', c);
      } else {
        out.push(b.subarray(p, end)); // tables, frame header, restart interval: picture data
      }
      p = end;
    }

    if (!sawFrame) throw new Error('This JPEG looks damaged.');
    if (!ended) out.push(new Uint8Array([0xff, 0xd9]));

    if (p < b.length) {
      var rest = b.subarray(p);
      var tail = ascii(rest, 0, Math.min(rest.length, 1 << 20));
      if (/PhotoEditor_Re_Edit_Data|Original_Path_Hash|Re_Edit/i.test(tail)) report.add('history', 'Undo data from the gallery editor');
      if (AI_RE.test(tail)) report.add('ai', aiDetail(tail) || 'AI source tags');
      if (/\xff\xd8\xff/.test(tail)) report.add('extra', 'Extra images (HDR or depth)');
      else if (/[^\0\s]/.test(tail.slice(0, 4096))) report.add('extra', 'Data hidden after the image');
    }

    if (orientation !== 1) {
      var exif = concat([new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]), orientationTiff(orientation)]);
      out.splice(exifSlot < 0 ? 1 : exifSlot, 0, jpegSegment(0xe1, exif));
    }

    return { bytes: concat(out), type: 'image/jpeg', ext: 'jpg', removed: report.list(), orientation: orientation };
  }

  // ---------------------------------------------------------------- PNG

  var PNG_KEEP = {
    IHDR: 1, PLTE: 1, IDAT: 1, IEND: 1, tRNS: 1, gAMA: 1, cHRM: 1, sRGB: 1, iCCP: 1, sBIT: 1,
    cICP: 1, mDCV: 1, cLLI: 1, pHYs: 1, bKGD: 1, hIST: 1, sPLT: 1, acTL: 1, fcTL: 1, fdAT: 1
  };

  function pngChunk(type, data) {
    var c = new Uint8Array(12 + data.length);
    var len = data.length;
    c[0] = len >>> 24; c[1] = (len >>> 16) & 0xff; c[2] = (len >>> 8) & 0xff; c[3] = len & 0xff;
    for (var i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(data, 8);
    var crc = crc32(c.subarray(4, 8 + len)) ^ 0xffffffff;
    crc >>>= 0;
    c[8 + len] = crc >>> 24; c[9 + len] = (crc >>> 16) & 0xff; c[10 + len] = (crc >>> 8) & 0xff; c[11 + len] = crc & 0xff;
    return c;
  }

  function cleanPng(b) {
    var report = new Report();
    var out = [b.subarray(0, 8)];
    var orientation = 1, ihdrAt = -1;
    var p = 8, ended = false;
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    while (p + 12 <= b.length) {
      var len = dv.getUint32(p);
      var type = ascii(b, p + 4, 4);
      var end = p + 12 + len;
      if (end > b.length) throw new Error('This PNG looks damaged.');
      var data = b.subarray(p + 8, p + 8 + len);
      if (PNG_KEEP[type]) {
        out.push(b.subarray(p, end));
        if (type === 'IHDR') ihdrAt = out.length;
      } else if (type === 'tEXt') {
        var z = data.indexOf(0);
        reportText(ascii(data, 0, z < 0 ? data.length : z), z < 0 ? '' : utf8(data.subarray(z + 1)), report);
      } else if (type === 'zTXt') {
        var z2 = data.indexOf(0);
        reportText(ascii(data, 0, z2 < 0 ? data.length : z2), '', report);
      } else if (type === 'iTXt') {
        var z3 = data.indexOf(0);
        var kw = ascii(data, 0, z3 < 0 ? data.length : z3);
        var text = '';
        if (z3 >= 0 && data[z3 + 1] === 0) {
          var q = z3 + 3;
          var l1 = data.indexOf(0, q); if (l1 < 0) l1 = data.length;
          var l2 = data.indexOf(0, l1 + 1); if (l2 < 0) l2 = data.length;
          text = utf8(data.subarray(l2 + 1));
        }
        reportText(kw, text, report);
      } else if (type === 'eXIf') {
        var o = reportTiff(data, report);
        if (o !== 1) orientation = o;
      } else if (type === 'tIME') {
        report.add('time', 'Last edited time');
      } else if (type === 'caBX') {
        report.add('ai', 'Content Credentials (C2PA)');
      } else {
        report.add('extra');
      }
      p = end;
      if (type === 'IEND') { ended = true; break; }
    }
    if (!ended || ihdrAt < 0) throw new Error('This PNG looks damaged.');
    if (p < b.length) report.add('extra', 'Data hidden after the image');
    if (orientation !== 1) out.splice(ihdrAt, 0, pngChunk('eXIf', orientationTiff(orientation)));
    return { bytes: concat(out), type: 'image/png', ext: 'png', removed: report.list(), orientation: orientation };
  }

  // ---------------------------------------------------------------- WebP

  function cleanWebp(b) {
    var report = new Report();
    var chunks = [];
    var orientation = 1, vp8x = -1;
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    var riffEnd = Math.min(b.length, 8 + dv.getUint32(4, true));
    var p = 12;
    while (p + 8 <= riffEnd) {
      var id = ascii(b, p, 4);
      var size = dv.getUint32(p + 4, true);
      var end = p + 8 + size + (size % 2);
      if (p + 8 + size > b.length) throw new Error('This WebP looks damaged.');
      var data = b.subarray(p + 8, p + 8 + size);
      if (id === 'VP8X') { vp8x = chunks.length; chunks.push(new Uint8Array(b.subarray(p, Math.min(end, b.length)))); }
      else if (id === 'VP8 ' || id === 'VP8L' || id === 'ALPH' || id === 'ANIM' || id === 'ANMF' || id === 'ICCP') chunks.push(b.subarray(p, Math.min(end, b.length)));
      else if (id === 'EXIF') {
        var t = data;
        if (startsWith(t, 0, 'Exif\0')) t = t.subarray(6);
        var o = reportTiff(t, report);
        if (o !== 1) orientation = o;
      } else if (id === 'XMP ') reportXmp(utf8(data), report);
      else if (id === 'C2PA') report.add('ai', 'Content Credentials (C2PA)');
      else report.add('extra');
      p = end;
    }
    if (!chunks.length) throw new Error('This WebP looks damaged.');
    if (vp8x >= 0) {
      var flags = chunks[vp8x][8] & ~0x0c; // clear EXIF + XMP flags
      if (orientation !== 1) {
        var tiff = orientationTiff(orientation);
        var ex = new Uint8Array(8 + tiff.length);
        ex.set([0x45, 0x58, 0x49, 0x46, tiff.length, 0, 0, 0]);
        ex.set(tiff, 8);
        chunks.push(ex);
        flags |= 0x08;
      }
      chunks[vp8x][8] = flags;
    }
    var body = concat(chunks);
    var head = new Uint8Array(12);
    head.set(b.subarray(0, 12));
    var size2 = body.length + 4;
    head[4] = size2 & 0xff; head[5] = (size2 >>> 8) & 0xff; head[6] = (size2 >>> 16) & 0xff; head[7] = size2 >>> 24;
    return { bytes: concat([head, body]), type: 'image/webp', ext: 'webp', removed: report.list(), orientation: orientation };
  }

  // ---------------------------------------------------------------- entry point

  function detect(b) {
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b.length > 8 && b[0] === 0x89 && startsWith(b, 1, 'PNG')) return 'png';
    if (b.length > 12 && startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP')) return 'webp';
    return null;
  }

  function clean(input) {
    var b = input instanceof Uint8Array ? input : new Uint8Array(input);
    var kind = detect(b);
    if (kind === 'jpeg') return cleanJpeg(b);
    if (kind === 'png') return cleanPng(b);
    if (kind === 'webp') return cleanWebp(b);
    return null; // not a format we can clean losslessly
  }

  // Re-check a cleaned file: lists anything that would still be reported.
  function inspect(input) {
    var r = clean(input);
    return r ? r.removed : null;
  }

  return { clean: clean, inspect: inspect, detect: detect, crc32: crc32, LABELS: LABELS };
});
