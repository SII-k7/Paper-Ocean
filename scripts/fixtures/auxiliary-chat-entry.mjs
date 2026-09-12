import {app,ipcMain,BrowserWindow} from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-ocean-auxiliary-ui-'));
await fs.mkdir(root,{recursive:true});
app.disableHardwareAcceleration();app.setPath('userData',root);app.setPath('sessionData',root+'/session');
process.env.PAPER_OCEAN_ARCHIVE_DIR=root+'/archive';
await import('../../electron/main.mjs');
globalThis.setupAuxTest=()=>{
 let next=0;globalThis.requests=[];globalThis.interrupts=[];globalThis.interruptFailuresRemaining=0;
 const emit=(method,params)=>BrowserWindow.getAllWindows().forEach(w=>w.webContents.send('codex:event',{method,params}));globalThis.emitAux=emit;
 const handlers={
 'codex:status':()=>({connected:true,accountType:'chatgpt',planType:'pro'}),
 'codex:models':()=>[{id:'gpt-5.6-luna',supportedEfforts:['max'],serviceTiers:[{id:'priority',name:'Fast'}]}],
 'codex:rate-limits':()=>null,
 'codex:start-thread':()=> 'fixture-thread-'+(++next),
 'codex:resume-thread':(_event,input)=>input.threadId,
 'codex:send-turn':(_event,input)=>{const turnId='fixture-turn-'+(++next);globalThis.requests.push({...input,turnId});return {turnId,serviceTier:input.serviceTier};},
 'codex:interrupt':(_event,input)=>{globalThis.interrupts.push(input);if(globalThis.interruptFailuresRemaining>0){globalThis.interruptFailuresRemaining--;throw new Error('Temporary interruption failure');}emit('turn/completed',{threadId:input.threadId,turn:{id:input.turnId,status:'interrupted'}});},
 };
 for(const [channel,handler] of Object.entries(handlers)){ipcMain.removeHandler(channel);ipcMain.handle(channel,handler);}
};
