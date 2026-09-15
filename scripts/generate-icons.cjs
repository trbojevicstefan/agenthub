'use strict';
// Dependency-free, deterministic product icon: a linked H on the workspace background.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const size=256,raw=Buffer.alloc((size*4+1)*size);
const glyph=(x,y)=>(x>=64&&x<86&&y>=64&&y<192)||(x>=170&&x<192&&y>=64&&y<192)||(x>=86&&x<170&&y>=117&&y<139);
for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=y*(size*4+1)+1+x*4,cornerX=Math.max(0,32-x,x-223),cornerY=Math.max(0,32-y,y-223),alpha=cornerX*cornerX+cornerY*cornerY>1024?0:255;const c=glyph(x,y)?[166,243,199]:[18,21,24];raw.set([...c,alpha],i);}
function crc(buffer){let c=0xffffffff;for(const byte of buffer){c^=byte;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(name,data){const type=Buffer.from(name),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([head,type,data,tail]);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;
const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(png.length,14);ico.writeUInt32LE(22,18);
const directory=path.resolve(__dirname,'../build');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'icon.png'),png);fs.writeFileSync(path.join(directory,'icon.ico'),Buffer.concat([ico,png]));
