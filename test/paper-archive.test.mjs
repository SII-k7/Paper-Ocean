import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createPaperArchive, discussedPaperIds, archiveFilename } from "../electron/paper-archive.mjs";
import { classifyPaper } from "../electron/paper-classification.mjs";

test("embodied categories use specific evidence and retain uncertain papers",()=>{
  for(const [title,category] of [['OpenVLA: Vision-Language-Action Models','VLA'],['Learning World Models for Control','世界模型'],['Diffusion Policy: Visuomotor Policy Learning','动作生成'],['Robust Quadruped Locomotion','运动控制'],['Attention Is All You Need','待分类']])assert.equal(classifyPaper({title}).category,category);
  assert.equal(classifyPaper({title:'A Study',abstract:'We compare world models and diffusion policy.'}).category,'待分类');
  assert.equal(classifyPaper({title:'SplitAdapter: Load-Aware Humanoid Loco-Manipulation via Factorized Adaptation',abstract:'We use a world-model baseline.'}).category,'运动控制');
});
test("archive only includes discussed scopes, fixed multi-paper sets and explicit legacy sources",()=>{
  const a='a'.repeat(24),b='b'.repeat(24),c='c'.repeat(24),scope='conversation:12345678-1234-1234-1234-123456789abc';
  const state={papers:[{id:a},{id:b},{id:c}],conversations:{[scope]:{paperIds:[a,b]}},messagesByScope:{[scope]:[{role:'user',text:'compare'}],all:[{role:'user',text:'legacy',paperId:c}]}};
  assert.deepEqual([...discussedPaperIds(state)].sort(),[a,b,c]);
  assert.equal(discussedPaperIds({papers:state.papers,messagesByScope:{[`paper:${a}`]:[]},draftsByScope:{[`paper:${a}`]:'draft'}}).size,0);
});
test("archive copies exact PDFs, survives restarts, moves verified copies and repairs missing copies",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-archive-'));
  try{
    const bytes=Buffer.from('%PDF-1.4\narchive fixture\n%%EOF'),id=createHash('sha256').update(bytes).digest('hex').slice(0,24);
    const source=path.join(root,'source.pdf');await fs.writeFile(source,bytes);
    const paper={id,title:'OpenVLA / \\ : * ? < > | ',path:source};
    const library={papers:[paper],messagesByScope:{[`paper:${id}`]:[{role:'user',text:'Explain'}]}};
    const options={directory:path.join(root,'archive'),metadataFile:path.join(root,'archive.json'),sourceForPaper:async()=>source};
    let service=createPaperArchive(options);await service.schedule(library);
    let status=await service.status();assert.equal(status.failures.length,0);assert.equal(status.entries[0].category,'VLA');
    const original=status.entries[0].path;assert.deepEqual(await fs.readFile(original),bytes);assert.ok(!archiveFilename(paper).includes('/'));
    service=createPaperArchive(options);await service.schedule(library);assert.equal((await service.status()).entries[0].path,original);
    status=await service.setCategory(id,'世界模型');const moved=status.entries[0].path;
    assert.deepEqual(await fs.readFile(moved),bytes);await assert.rejects(()=>fs.access(original));assert.deepEqual(await fs.readFile(source),bytes);
    await fs.unlink(moved);await service.schedule(library,true);assert.deepEqual(await fs.readFile(moved),bytes);
    await fs.writeFile(moved,'user edited file');await service.schedule(library,true);assert.equal((await service.status()).failures.length,1);assert.equal(await fs.readFile(moved,'utf8'),'user edited file');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test("missing or mismatched originals fail explicitly without overwriting files",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-archive-missing-'));
  try{
    const id='a'.repeat(24),source=path.join(root,'missing.pdf');
    const service=createPaperArchive({directory:path.join(root,'out'),metadataFile:path.join(root,'manifest.json'),sourceForPaper:async()=>source});
    const state={papers:[{id,title:'Locomotion',path:source}],messagesByScope:{[`paper:${id}`]:[{role:'user',text:'Question'}]}};
    await service.schedule(state);assert.equal((await service.status()).failures.length,1);
    await fs.writeFile(source,'%PDF-1.4\nwrong paper');await service.schedule(state,true);assert.equal((await service.status()).entries.length,0);
    await assert.rejects(()=>service.setCategory(id,'../../elsewhere'));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
