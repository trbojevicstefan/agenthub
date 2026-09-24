'use strict';
// App icons come from the OPAYA logo in build/brand (exported from the opayawebsite brand pack, public/brand/icons/opaya-interlock.png).
// - icon.png: 1024px on the Apple icon grid, for macOS bundles.
// - icon.ico: every size Windows shows (16-256px), each rendered separately so the taskbar and Start menu stay sharp.
// - window.png: 512px with a small margin, the window icon on Linux.
// - tray.png / tray@2x.png: 18px and 36px menu bar and tray icons.
const fs=require('node:fs'),path=require('node:path');
const directory=path.resolve(__dirname,'../build'),brand=path.join(directory,'brand');
// build/brand/opaya.ico holds 16-256px as uncompressed 32-bit BMP entries, each rendered separately. Windows shows
// PNG-compressed entries unreliably in the taskbar, shortcuts and the embedded EXE icon, so the ICO is not rebuilt here.
fs.copyFileSync(path.join(brand,'opaya.ico'),path.join(directory,'icon.ico'));
fs.copyFileSync(path.join(brand,'opaya-icon-1024.png'),path.join(directory,'icon.png'));
fs.copyFileSync(path.join(brand,'opaya-window-512.png'),path.join(directory,'window.png'));
fs.copyFileSync(path.join(brand,'tray.png'),path.join(directory,'tray.png'));
fs.copyFileSync(path.join(brand,'tray@2x.png'),path.join(directory,'tray@2x.png'));
