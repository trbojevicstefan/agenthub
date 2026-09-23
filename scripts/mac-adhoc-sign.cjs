'use strict';
// electron-builder afterPack hook. Without an Apple Developer ID the macOS build is left unsigned, and Apple Silicon
// refuses to launch unsigned downloaded code. An ad-hoc signature lets the app run after the user approves it once
// (right-click > Open, or System Settings > Privacy & Security). A real CSC_LINK/Developer ID replaces this.
const {execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
exports.default=async function adhocSign(context){
  if(context.electronPlatformName!=='darwin'||process.env.CSC_LINK||process.env.CSC_NAME)return;
  const app=path.join(context.appOutDir,`${context.packager.appInfo.productFilename}.app`);
  const unpacked=path.join(app,'Contents','Resources','app.asar.unpacked');
  const walk=dir=>fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]):[];
  for(const file of walk(unpacked).filter(f=>/\.(node|dylib)$/.test(f)||path.basename(f)==='spawn-helper')){
    if(path.basename(file)==='spawn-helper')fs.chmodSync(file,0o755);
    execFileSync('codesign',['--force','--sign','-',file],{stdio:'inherit'});
  }
  execFileSync('codesign',['--force','--deep','--sign','-',app],{stdio:'inherit'});
  execFileSync('codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
  console.log(`  • ad-hoc signed ${path.basename(app)} (${context.arch===3?'arm64':context.arch===1?'x64':context.arch})`);
};
