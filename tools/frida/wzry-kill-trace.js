'use strict';

/*
 * Kill-path tracer for com.tencent.tmgp.sgame on x86_64 (MuMu / Houdini), E3.
 * Attach-mode only. NO Stalker (Stalker.follow freezes the whole process and
 * trips the anti-debug — see run e3 where the target sat in "tracing stop").
 *
 * Established facts (sessions a-d):
 *  - Death is a SELF-SIGKILL emitted by a Houdini translator worker thread in
 *    the SAME pid:  houdini [tid] [SIGKILL] kill: pid=<self>, tid=<w>, signo=9
 *  - The fatal syscall is a guest ARM `svc #0` translated to a real x86
 *    `syscall` instruction inside JIT code => invisible to Interceptor.
 *  - A separate path also exists: occasional external `am force-stop` from a
 *    transient PID (MuMu acc / shell), which we cannot hook cross-process.
 *
 * E3 capture plan for the JIT self-kill:
 *  1. libc kill/raise/pthread_kill/tgkill/sigqueue/abort/exit/_exit/_Exit and
 *     syscall() filtered for kill/tkill/tgkill/exit/exit_group.
 *  2. Houdini emits its "[SIGKILL] kill: pid=.. tid=.. signo=9" line through a
 *     raw write-family call. We hook EVERY write-family export
 *     (write, writev, pwrite64, sendmsg, send, fputs, fputc, fwrite, puts,
 *      __android_log_write/print/vprint/buf_*) and scan the buffer for the
 *     kill-marker bytes; the backtrace at that moment resolves the libhoudini
 *     dispatcher offset that emits (and immediately precedes) the syscall.
 *  3. pthread_create + clone are hooked so we can see worker-thread spawns and
 *     the thread that later dies (tid in the houdini line == our creator tid).
 */

const SELF_PID = Process.id;
const SELF_TID = Process.getCurrentThreadId();
const MAX_FRAMES = 24;
const BOOT_TIME = Date.now();
const threadSeen = new Map();

const signalNames = {1:'SIGHUP',2:'SIGINT',3:'SIGQUIT',4:'SIGILL',5:'SIGTRAP',
 6:'SIGABRT',7:'SIGBUS',8:'SIGFPE',9:'SIGKILL',10:'SIGUSR1',11:'SIGSEGV',
 12:'SIGUSR2',13:'SIGPIPE',14:'SIGALRM',15:'SIGTERM',17:'SIGCHLD',18:'SIGCONT',
 19:'SIGSTOP',20:'SIGTSTP',23:'SIGURG',24:'SIGXCPU',25:'SIGXFSZ',27:'SIGPROF',
 29:'SIGIO',30:'SIGPWR',31:'SIGSYS'};
function signalName(s){return signalNames[s]||('SIG'+s);}

function describeAddress(a){
  if(a===undefined||a===null)return null;
  const i={address:a.toString()};
  try{const m=Process.findModuleByAddress(a);
    if(m){i.module=m.name;i.moduleBase=m.base.toString();
          i.moduleOffset=a.sub(m.base).toString();i.modulePath=m.path;}}catch(e){}
  try{const s=DebugSymbol.fromAddress(a);
    if(s&&(s.name||s.moduleName)){i.symbol=s.name||null;i.symbolModule=s.moduleName||null;}}catch(e){}
  return i;
}
function captureBacktrace(c){
  const f=[];
  try{const bt=Thread.backtrace(c,Backtracer.ACCURATE);
    for(const x of bt.slice(0,MAX_FRAMES))f.push(describeAddress(x));
  }catch(e){f.push({error:String(e)});}
  return f;
}
function callerInfo(c){
  let ra=null;
  if(c.returnAddress!==undefined&&c.returnAddress!==null)ra=c.returnAddress;
  else if(c.sp){try{ra=c.sp.readPointer();}catch(e){ra=null;}}
  return {returnAddress:ra?ra.toString():null,caller:ra?describeAddress(ra):null,
          pc:c.pc!==undefined?c.pc.toString():null,arch:c.arch||null};
}
function logEvent(type,payload,context){
  const e={timestamp:new Date().toISOString(),uptimeMs:Date.now()-BOOT_TIME,
           type:type,pid:SELF_PID,tid:Process.getCurrentThreadId()};
  if(payload)for(const k of Object.keys(payload))e[k]=payload[k];
  if(context){const c=callerInfo(context);
    e.returnAddress=c.returnAddress;e.caller=c.caller;e.pc=c.pc;e.arch=c.arch;
    e.backtrace=captureBacktrace(context);}
  send(e);
}
function hookExport(name,cb){
  const a=Module.findGlobalExportByName(name);
  if(!a){logEvent('hook-missing',{export:name});return null;}
  Interceptor.attach(a,cb);
  logEvent('hook-attached',{export:name,address:a.toString()});
  return a;
}
function readCStr(p,n){try{if(p.isNull())return null;return p.readCString(n||256);}catch(e){return null;}}

// ---------- libc termination family ----------
hookExport('kill',{onEnter:function(a){const p=a[0].toInt32(),s=a[1].toInt32();
  logEvent('call',{function:'kill',args:{pid:p,sig:s,sigName:signalName(s)},targetsSelf:p===SELF_PID||p===0||p===-1},this.context);},
  onLeave:function(r){logEvent('call-result',{function:'kill',result:r.toInt32()});}});
hookExport('raise',{onEnter:function(a){const s=a[0].toInt32();
  logEvent('call',{function:'raise',args:{sig:s,sigName:signalName(s)},targetsSelf:true},this.context);}});
hookExport('pthread_kill',{onEnter:function(a){const s=a[1].toInt32();
  logEvent('call',{function:'pthread_kill',args:{pthread:a[0].toString(),sig:s,sigName:signalName(s)}},this.context);}});
hookExport('tgkill',{onEnter:function(a){const t=a[0].toInt32(),i=a[1].toInt32(),s=a[2].toInt32();
  logEvent('call',{function:'tgkill',args:{tgid:t,tid:i,sig:s,sigName:signalName(s)},targetsSelf:t===SELF_PID},this.context);}});
hookExport('abort',{onEnter:function(){logEvent('call',{function:'abort',args:{}},this.context);}});
for(const fn of ['exit','_exit','_Exit','quick_exit','__cxa_finalize']){
  hookExport(fn,{onEnter:function(a){logEvent('call',{function:fn,args:{status:a&&a[0]?a[0].toInt32():0}},this.context);}});
}
hookExport('sigqueue',{onEnter:function(a){const p=a[0].toInt32(),s=a[1].toInt32();
  logEvent('call',{function:'sigqueue',args:{pid:p,sig:s,sigName:signalName(s)},targetsSelf:p===SELF_PID},this.context);}});

// ---------- raw syscall() dispatcher ----------
const syscallFn=Module.findGlobalExportByName('syscall');
if(syscallFn){Interceptor.attach(syscallFn,{onEnter:function(a){
  const n=a[0].toInt32();
  if(n===62||n===200||n===234){const p=a[1].toInt32(),q=a[2].toInt32(),r=n===234?a[3].toInt32():null;
    logEvent('syscall',{function:'syscall',syscallNumber:n,syscallName:n===62?'kill':(n===200?'tkill':'tgkill'),
      args:n===234?{tgid:p,tid:q,sig:r,sigName:signalName(r)}:{pid:p,sig:q,sigName:signalName(q)},
      targetsSelf:p===SELF_PID||p===0||p===-1},this.context);}
  else if(n===60||n===231){logEvent('syscall',{function:'syscall',syscallNumber:n,syscallName:n===60?'exit':'exit_group',args:{status:a[1].toInt32()}},this.context);}}});
  logEvent('hook-attached',{export:'syscall(filtered)',address:syscallFn.toString()});}
else{logEvent('hook-missing',{export:'syscall'});}

// ---------- Houdini kill-log capture via the write family ----------
const KILL_BYTES=/(kill: pid|tgkill: pid|signo = 9|\[SIGKILL\]|signo = %d|SIGKILL)/;
const LOG_FMT=/(kill: pid|tgkill: pid|signo = |\[SIGKILL\]|SIGKILL)/;

function scanBuffer(buf,len,fn,extra){
  if(buf.isNull()||len<=0)return;
  const s=readCStr(buf,Math.min(len,256));
  if(s&&KILL_BYTES.test(s)){
    const pl={function:fn,text:s};if(extra)Object.assign(pl,extra);
    logEvent('kill-log-write',pl,this.context);
  }
}
function hookWriteLike(name,bufIdx,lenIdx){
  hookExport(name,{
    onEnter:function(a){this.buf=a[bufIdx];this.len=lenIdx>=0?a[lenIdx].toInt32():0;},
    onLeave:function(){scanBuffer.call(this,this.buf,this.len,name);}
  });
}
hookWriteLike('write',1,2);
hookWriteLike('pwrite64',1,2);
hookWriteLike('send',1,2);
hookWriteLike('fputs',0,-1);   // len unknown -> rely on readCStr
hookWriteLike('fwrite',0,2);
hookWriteLike('puts',0,-1);
hookExport('writev',{onEnter:function(a){this.iov=a[1];this.cnt=a[2].toInt32();},
  onLeave:function(){for(let i=0;i<this.cnt&&i<8;i++){
    try{const b=this.iov.add(i*16).readPointer();const ln=this.iov.add(i*16+8).readU64();
      const L=typeof ln.toNumber==='function'?ln.toNumber():Number(ln);
      const s=readCStr(b,Math.min(L,256));
      if(s&&KILL_BYTES.test(s)){logEvent('kill-log-write',{function:'writev',index:i,text:s},this.context);break;}
    }catch(e){}
  }}});

function hookFmt(name,fmtIdx){
  const a=Module.findGlobalExportByName(name);
  if(!a){logEvent('hook-missing',{export:name});return;}
  Interceptor.attach(a,{onEnter:function(x){
    const f=readCStr(x[fmtIdx]);
    if(f&&LOG_FMT.test(f))logEvent('log-format',{function:name,format:f},this.context);
  }});
  logEvent('hook-attached',{export:name+'(killfmt)',address:a.toString()});
}
for(const [n,i] of [['__android_log_print',2],['__android_log_vprint',2],
  ['__android_log_write',2],['__android_log_buf_write',3],['__android_log_buf_print',3],
  ['printf',0],['fprintf',1],['snprintf',2],['vsnprintf',2],
  ['vsprintf',1],['sprintf',1],['vasprintf',1],['asprintf',1]]){hookFmt(n,i);}

// ---------- thread creation tracking ----------
hookExport('pthread_create',{onEnter:function(a){this.out=a[0];},
  onLeave:function(res){if(res.toInt32()===0&&this.out&&!this.out.isNull()){
    try{const t=this.out.readU32();threadSeen.set(t,Date.now()-BOOT_TIME);
      logEvent('thread-spawn',{tid:t,total:threadSeen.size});}catch(e){}}}});
hookExport('clone',{onEnter:function(){},onLeave:function(res){
  const t=res.toInt32();if(t>0&&t!==SELF_TID){threadSeen.set(t,Date.now()-BOOT_TIME);
    logEvent('thread-spawn',{via:'clone',tid:t,total:threadSeen.size});}}});

// ---------- module map ----------
const snap=[];for(const m of Process.enumerateModules())snap.push({name:m.name,base:m.base.toString(),size:m.size,path:m.path});
logEvent('session-started',{package:'com.tencent.tmgp.sgame',script:'wzry-kill-trace-e3',
  selfPid:SELF_PID,selfTid:SELF_TID,moduleCount:snap.length,stalker:false});
send({type:'module-map',timestamp:new Date().toISOString(),modules:snap});
