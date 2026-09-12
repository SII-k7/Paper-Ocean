import {app,ipcMain} from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {readPdfFile,manageOriginal} from '../../electron/paper-services.mjs';
import {titleMatchScore} from '../../electron/paper-search-utils.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-ocean-search-ui-'));
app.disableHardwareAcceleration();app.setPath('userData',root);app.setPath('sessionData',root+'/session');
process.env.PAPER_OCEAN_ARCHIVE_DIR=root+'/archive';
await import('../../electron/main.mjs');
globalThis.setupSearchTest=()=>{
 const fixtures=[
  {key:'oa:W1',openAlexId:'W1',title:'OpenVLA: An Open-Source Vision-Language-Action Model',subtitle:'Kim et al.',source:'openalex'},
  {key:'arxiv:2303.04137',arxivId:'2303.04137',title:'Diffusion Policy: Visuomotor Policy Learning',subtitle:'Chi et al.',source:'arxiv'},
  {key:'arxiv:2401.00002',arxivId:'2401.00002',title:'机器人全身运动控制',subtitle:'中文交互测试',source:'arxiv'},
  {key:'arxiv:2401.00003',arxivId:'2401.00003',title:'Retry Robot',subtitle:'重试测试',source:'arxiv'},
 ];
 globalThis.searchCalls=[];globalThis.openCalls=[];globalThis.resolveCalls=[];
 let retry=0;
 const handlers={
  'codex:status':()=>({connected:true,accountType:'chatgpt',planType:'pro'}),
  'codex:models':()=>[{id:'gpt-5.6-luna',supportedEfforts:['max'],serviceTiers:[{id:'priority',name:'Fast'}]}],
  'codex:rate-limits':()=>null,
  'papers:search':async(_event,query)=>{globalThis.searchCalls.push(query);await new Promise(resolve=>setTimeout(resolve,query==='diffu'?1100:100));return query==='retry'&&retry++===0?{items:[],error:'模拟服务暂不可用'}:{items:fixtures.filter(item=>titleMatchScore(query,item.title))};},
  'papers:resolve-suggestion':(_event,id)=>{globalThis.resolveCalls.push(id);return {arxivId:'2406.09246'};},
  'paper:open-url':async(_event,id)=>{globalThis.openCalls.push(id);const source=await fs.readFile(process.env.PAPER_OCEAN_SEARCH_FIXTURE);const file=path.join(root,id.replaceAll('/','_')+'.pdf');await fs.writeFile(file,Buffer.concat([source,Buffer.from('\n% '+id)]));return {...await manageOriginal(root,await readPdfFile(file)),arxivId:id,title:fixtures.find(f=>f.arxivId===id||id==='2406.09246'&&f.openAlexId)?.title||'Fixture'};},
  'recommendations:fetch':()=>({items:[]}),
 };
 for(const[channel,handler]of Object.entries(handlers)){ipcMain.removeHandler(channel);ipcMain.handle(channel,handler);}
};
