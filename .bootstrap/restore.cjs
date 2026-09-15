'use strict';
// Temporary, integrity-checked transport for source authored in an offline environment.
// The Windows job removes .bootstrap after committing the expanded source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const manifest = require('./manifest.json');
const root = path.resolve(__dirname, '..');
const base64 = manifest.parts.map(name => {
  if (!/^source\.\d{2}\.b64$/.test(name)) throw new Error('Invalid source part');
  return fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/\s/g, '');
}).join('');
const compressed = Buffer.from(base64, 'base64');
if (compressed.length !== manifest.compressedBytes || crypto.createHash('sha256').update(compressed).digest('hex') !== manifest.sha256) throw new Error('Source payload integrity failed; no source files changed.');
const raw = zlib.brotliDecompressSync(compressed, {maxOutputLength: 1024 * 1024});
if (raw.length !== manifest.sourceBytes) throw new Error('Unexpected source size');
const files = JSON.parse(raw.toString('utf8'));
if (Object.keys(files).length !== manifest.files) throw new Error('Unexpected source file count');
for (const [name, text] of Object.entries(files)) {
  if (typeof text !== 'string' || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..') || !/^(desktop\/|ui\/|scripts\/|tests\/|docs\/|build\/entitlements\.mac\.plist$|package\.json$|README\.md$|BUILD_GUIDE\.md$|\.gitignore$)/.test(name)) throw new Error('Disallowed source path: ' + name);
  const target = path.resolve(root, name);
  if (!target.startsWith(root + path.sep)) throw new Error('Source path escaped repository');
}
for (const [name, text] of Object.entries(files)) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, text, 'utf8');
}
console.log(`Restored ${manifest.files} verified source files (${manifest.sha256}).`);
