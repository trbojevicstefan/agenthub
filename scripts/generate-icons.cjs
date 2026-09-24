'use strict';
// Dependency-free, deterministic Opaya icon: a gradient ring with an orbiting signal on a rounded workspace tile.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const stops=[[181,245,207],[143,220,245],[205,182,255],[181,245,207]];
function ringColor(angle){const t=((angle/(2*Math.PI))%1+1)%1*3,i=Math.floor(t);return mix(stops[i],stops[i+1],t-i);}
function render(size){
  const raw=Buffer.alloc((size*4+1)*size),s=size/1024,samples=4;
  // Apple icon grid: 824px tile inside a 1024px canvas; the same art is used on Windows and Linux.
  const tile=824*s,inset=(size-tile)/2,radius=185*s,c=size/2,ringR=250*s,ringW=78*s,dotA=-Math.PI/4,dotX=c+ringR*Math.cos(dotA),dotY=c+ringR*Math.sin(dotA),dotR=66*s;
  const inTile=(x,y)=>{const dx=Math.max(inset+radius-x,0,x-(size-inset-radius)),dy=Math.max(inset+radius-y,0,y-(size-inset-radius));return x>=inset&&x<=size-inset&&y>=inset&&y<=size-inset&&dx*dx+dy*dy<=radius*radius;};
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    let r=0,g=0,b=0,a=0;
    for(let sy=0;sy<samples;sy++)for(let sx=0;sx<samples;sx++){
      const px=x+(sx+.5)/samples,py=y+(sy+.5)/samples;if(!inTile(px,py))continue;
      const shade=1-.18*((py-inset)/tile);let color=[20*shade+4,24*shade+3,27*shade+3];
      const d=Math.hypot(px-c,py-c),dot=Math.hypot(px-dotX,py-dotY);
      if(dot<=dotR+14*s)color=[20,24,27];
      else if(Math.abs(d-ringR)<=ringW/2)color=ringColor(Math.atan2(py-c,px-c)+Math.PI/2);
      if(dot<=dotR)color=[181,245,207];
      r+=color[0];g+=color[1];b+=color[2];a+=255;
    }
    const n=samples*samples,i=y*(size*4+1)+1+x*4;
    if(a)raw.set([Math.round(r/(a/255)),Math.round(g/(a/255)),Math.round(b/(a/255)),Math.round(a/n)],i);
  }
  return png(size,raw);
}
function crc(buffer){let c=0xffffffff;for(const byte of buffer){c^=byte;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(name,data){const type=Buffer.from(name),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([head,type,data,tail]);}
function png(size,raw){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);}
const large=render(1024),small=render(256);
const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(small.length,14);ico.writeUInt32LE(22,18);
const directory=path.resolve(__dirname,'../build');fs.mkdirSync(directory,{recursive:true});
fs.writeFileSync(path.join(directory,'icon.png'),large);fs.writeFileSync(path.join(directory,'icon.ico'),Buffer.concat([ico,small]));
