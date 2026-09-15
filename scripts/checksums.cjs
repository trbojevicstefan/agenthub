'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.join(__dirname,'../release');
const files=fs.readdirSync(root).filter(n=>/\.(exe|dmg|zip|AppImage)$/.test(n)).sort();
if(!files.length)throw new Error('No installers were built; refusing to create an empty checksum manifest.');
const rows=files.map(name=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')+'  '+name);
fs.writeFileSync(path.join(root,`${process.platform}-${process.arch}-SHA256SUMS.txt`),rows.join('\n')+'\n');
console.log(`Checksummed ${files.length} installer assets.`);
