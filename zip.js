/*!
 * Plainshot ZIP writer: a minimal "stored" (no compression) ZIP builder.
 * Photos are already compressed, so storing them is fast and loses nothing.
 * MIT License.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./clean.js'));
  else root.PlainshotZip = factory(root.PlainshotCleaner);
})(typeof self !== 'undefined' ? self : this, function (cleaner) {
  'use strict';

  function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
  function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

  function dosTime(d) {
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time, date: date };
  }

  // files: [{ name: string, bytes: Uint8Array }] -> Uint8Array
  function zip(files) {
    var enc = new TextEncoder();
    var parts = [], central = [], offset = 0;
    var t = dosTime(new Date());
    files.forEach(function (f) {
      var name = enc.encode(f.name);
      var crc = (cleaner.crc32(f.bytes) ^ 0xffffffff) >>> 0;
      var size = f.bytes.length;
      var local = new Uint8Array([].concat(
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(t.time), u16(t.date),
        u32(crc), u32(size), u32(size), u16(name.length), u16(0)
      ));
      parts.push(local, name, f.bytes);
      central.push(new Uint8Array([].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(t.time), u16(t.date),
        u32(crc), u32(size), u32(size), u16(name.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset)
      )), name);
      offset += local.length + name.length + size;
    });
    var cdSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = new Uint8Array([].concat(
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(cdSize), u32(offset), u16(0)
    ));
    var all = parts.concat(central, [end]);
    var total = all.reduce(function (s, c) { return s + c.length; }, 0);
    var out = new Uint8Array(total), p = 0;
    all.forEach(function (c) { out.set(c, p); p += c.length; });
    return out;
  }

  return { zip: zip };
});
