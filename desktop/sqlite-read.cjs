'use strict';
// A small read-only SQLite reader: the rows of one table of a database file, as objects. Enough for the cookie database
// of Chrome and Edge (cookie-import.cjs) without depending on a native or experimental SQLite in Electron.
// Format: https://www.sqlite.org/fileformat2.html (b-tree pages, varints, records, overflow pages).
const fs=require('node:fs');
function varint(buf,at){let v=0n;for(let i=0;i<8;i++){const b=buf[at+i];v=(v<<7n)|BigInt(b&0x7f);if(!(b&0x80))return [v,i+1];}return [(v<<8n)|BigInt(buf[at+8]),9];}
class Db{
  constructor(file){
    this.buf=fs.readFileSync(file);const b=this.buf;
    if(b.length<100||b.toString('latin1',0,16)!=='SQLite format 3\0')throw new Error('Not an SQLite database.');
    const ps=b.readUInt16BE(16);this.pageSize=ps===1?65536:ps;this.usable=this.pageSize-b[20];
    if(b.readUInt32BE(56)>1)throw new Error('Only UTF-8 databases are supported.');
  }
  page(n){const start=(n-1)*this.pageSize;if(n<1||start>=this.buf.length)throw new Error('The database is damaged.');return start;}
  // Every row of the table b-tree starting at `root`: [rowid, payload Buffer].
  *rows(root,depth=0){
    if(depth>40)throw new Error('The database is damaged.');
    const b=this.buf,base=this.page(root),h=base+(root===1?100:0),type=b[h],cells=b.readUInt16BE(h+3);
    if(type===0x05){
      const ptrs=h+12;for(let i=0;i<cells;i++){const cell=base+b.readUInt16BE(ptrs+i*2);yield* this.rows(b.readUInt32BE(cell),depth+1);}
      yield* this.rows(b.readUInt32BE(h+8),depth+1);
    }else if(type===0x0d){
      const ptrs=h+8;
      for(let i=0;i<cells;i++){
        let at=base+b.readUInt16BE(ptrs+i*2);const [size,n1]=varint(b,at);at+=n1;const [rowid,n2]=varint(b,at);at+=n2;
        yield [rowid,this.payload(at,Number(size))];
      }
    }else throw new Error('The database is damaged.');
  }
  payload(at,size){
    const U=this.usable,X=U-35;if(size<=X)return this.buf.subarray(at,at+size);
    const M=Math.floor((U-12)*32/255)-23,K=M+((size-M)%(U-4)),local=K<=X?K:M;
    const parts=[this.buf.subarray(at,at+local)];let left=size-local,next=this.buf.readUInt32BE(at+local),guard=0;
    while(left>0&&next&&guard++<100000){const p=this.page(next),take=Math.min(left,U-4);parts.push(this.buf.subarray(p+4,p+4+take));left-=take;next=this.buf.readUInt32BE(p);}
    return Buffer.concat(parts);
  }
  record(p){
    const [hsize,n]=varint(p,0);let at=n;const types=[];while(at<Number(hsize)){const [t,m]=varint(p,at);types.push(Number(t));at+=m;}
    let pos=Number(hsize);const out=[];
    for(const t of types){
      if(t===0){out.push(null);continue;}
      if(t>=1&&t<=6){const len=[0,1,2,3,4,6,8][t];let v=0n;for(let i=0;i<len;i++)v=(v<<8n)|BigInt(p[pos+i]);if(p[pos]&0x80)v-=1n<<BigInt(len*8);pos+=len;out.push(Number(v));continue;}
      if(t===7){out.push(p.readDoubleBE(pos));pos+=8;continue;}
      if(t===8||t===9){out.push(t-8);continue;}
      if(t>=12){const len=t%2?(t-13)/2:(t-12)/2,v=p.subarray(pos,pos+len);pos+=len;out.push(t%2?v.toString('utf8'):Buffer.from(v));continue;}
      out.push(null);
    }
    return out;
  }
  // The table's columns from its CREATE TABLE statement.
  columns(sql){
    const body=sql.slice(sql.indexOf('(')+1,sql.lastIndexOf(')'));const cols=[];let depth=0,cur='';
    for(const ch of body){if(ch==='(')depth++;if(ch===')')depth--;if(ch===','&&!depth){cols.push(cur);cur='';}else cur+=ch;}cols.push(cur);
    return cols.map(c=>c.trim()).filter(c=>c&&!/^(primary|unique|constraint|check|foreign)\b/i.test(c)).map(c=>{const m=/^["`[]?([^"`\]\s]+)["`\]]?\s*(.*)$/s.exec(c);return {name:m[1],alias:/^integer\s+primary\s+key/i.test(m[2])};});
  }
  table(name){
    for(const [,p] of this.rows(1)){const r=this.record(p);if(r[0]==='table'&&String(r[1]).toLowerCase()===name.toLowerCase())return {root:r[3],columns:this.columns(String(r[4]))};}
    return null;
  }
  *select(name){
    const t=this.table(name);if(!t)throw new Error(`The database has no ${name} table.`);
    for(const [rowid,p] of this.rows(t.root)){const r=this.record(p),o={};t.columns.forEach((c,i)=>{o[c.name]=c.alias&&r[i]==null?Number(rowid):r[i]??null;});yield o;}
  }
}
module.exports={Db};
