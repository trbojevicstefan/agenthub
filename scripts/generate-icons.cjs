'use strict';
// App icons come from the OPAYA logo in build/brand (exported from the opayawebsite brand pack, public/brand/icons/opaya-interlock.png).
// icon.png (1024px, Apple icon grid) is used for macOS, Linux and the tray; icon.ico embeds the 256px PNG for Windows.
const fs=require('node:fs'),path=require('node:path');
const directory=path.resolve(__dirname,'../build'),large=fs.readFileSync(path.join(directory,'brand/opaya-icon-1024.png')),small=fs.readFileSync(path.join(directory,'brand/opaya-icon-256.png'));
const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(small.length,14);ico.writeUInt32LE(22,18);
fs.writeFileSync(path.join(directory,'icon.png'),large);fs.writeFileSync(path.join(directory,'icon.ico'),Buffer.concat([ico,small]));
