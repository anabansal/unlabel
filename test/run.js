// Cleans every fixture with the same code the website runs, writes the
// results to test/out, and checks the reports and the ZIP writer.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { clean } = require('../clean.js');
const { zip } = require('../zip.js');

const dir = path.join(__dirname, 'fixtures');
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });

const expected = {
  'phone.jpg': ['location', 'ai', 'device', 'time', 'history', 'author', 'text', 'thumbnail', 'extra'],
  'progressive.jpg': ['location', 'device', 'time', 'author'],
  'ai.png': ['location', 'ai', 'device', 'time', 'history', 'author'],
  'photo.webp': ['location', 'ai', 'device', 'time', 'history', 'author'],
  'clean.jpg': []
};

const files = [];
for (const name of Object.keys(expected)) {
  const input = new Uint8Array(fs.readFileSync(path.join(dir, name)));
  const r = clean(input);
  const keys = r.removed.map((x) => x.key);
  console.log(`${name}: ${input.length} -> ${r.bytes.length} bytes, orientation ${r.orientation}`);
  for (const item of r.removed) console.log(`   - ${item.label}${item.detail ? ': ' + item.detail : ''}`);
  for (const k of expected[name]) assert(keys.includes(k), `${name} should report ${k}`);
  if (!expected[name].length) assert.deepStrictEqual(keys, [], `${name} should report nothing`);

  // Cleaning twice finds nothing left.
  const again = clean(r.bytes);
  assert.deepStrictEqual(again.removed, [], `${name} cleaned output still has: ${JSON.stringify(again.removed)}`);
  assert.deepStrictEqual(Buffer.from(again.bytes), Buffer.from(r.bytes), `${name} cleaning is not stable`);

  fs.writeFileSync(path.join(out, name), r.bytes);
  files.push({ name, bytes: r.bytes });
}

const phone = clean(new Uint8Array(fs.readFileSync(path.join(dir, 'phone.jpg')))).removed;
assert(phone.find((x) => x.key === 'location').detail.includes('37.7749, -122.4194'));
assert(phone.find((x) => x.key === 'device').detail.includes('iPhone 15 Pro'));

fs.writeFileSync(path.join(out, 'all.zip'), zip(files));
console.log('\nAll cleaner checks passed.');
