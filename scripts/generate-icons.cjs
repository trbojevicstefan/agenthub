'use strict';
// App icons come from the OPAYA logo in build/brand (exported from the opayawebsite brand pack, public/brand/icons/opaya-interlock.png).
// - icon.png: 1024px on the Apple icon grid, for macOS bundles.
// - icon.ico: every size Windows shows (16-256px), each rendered separately so the taskbar and Start menu stay sharp.
// - window.png: 512px with a small margin, the window icon on Linux.
// - tray.png / tray@2x.png: 18px and 36px menu bar and tray icons.
const fs=require('node:fs'),path=require('node:path');
const directory=path.resolve(__dirname,'../build'),brand=path.join(directory,'brand');
const sizes=[16,20,24,32,40,48,64,96,128,256],images=sizes.map(size=>fs.readFileSync(path.join(brand,'ico',`${size}.png`)));
const header=Buffer.alloc(6);header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);
let offset=6+16*images.length;
const entries=images.map((png,i)=>{const e=Buffer.alloc(16),size=sizes[i];e[0]=size>=256?0:size;e[1]=size>=256?0:size;e.writeUInt16LE(1,4);e.writeUInt16LE(32,6);e.writeUInt32LE(png.length,8);e.writeUInt32LE(offset,12);offset+=png.length;return e;});
fs.writeFileSync(path.join(directory,'icon.ico'),Buffer.concat([header,...entries,...images]));
fs.copyFileSync(path.join(brand,'opaya-icon-1024.png'),path.join(directory,'icon.png'));
fs.copyFileSync(path.join(brand,'opaya-window-512.png'),path.join(directory,'window.png'));
fs.copyFileSync(path.join(brand,'tray.png'),path.join(directory,'tray.png'));
fs.copyFileSync(path.join(brand,'tray@2x.png'),path.join(directory,'tray@2x.png'));
