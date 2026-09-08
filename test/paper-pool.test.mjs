import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { poolFromLibrary, mergePools } from "../electron/paper-pool.mjs";
import { createPoolSync, exchangePool, poolEndpoint } from "../electron/pool-sync.mjs";

const a = "a".repeat(24), b = "b".repeat(24);
const library = (id, asked = false) => ({ papers: [{id,title:`Paper ${id[0]}`,path:"D:/private/paper.pdf",paperDir:"private",openedAt:100,sourceUrl:"https://arxiv.org/abs/2401.00001",dataBase64:"private"}], messagesByScope: {[`paper:${id}`]: asked ? [{role:"user",createdAt:200,text:"private question"}] : []} });
test("pool contains portable seen/asked metadata and no PDF, paths, prompts or thread ids", () => {
  const result = poolFromLibrary(library(a,true));
  assert.equal(result.papers[0].askedAt,200);
  assert.equal(result.papers[0].seenAt,100);
  assert.ok(!JSON.stringify(result).includes("private"));
  const multi = library(b); multi.conversations = {"conversation:test":{paperIds:[b]}}; multi.messagesByScope = {"conversation:test":[{role:"user",createdAt:300}]};
  assert.equal(poolFromLibrary(multi).papers[0].askedAt,300);
});
test("pool merge is idempotent, order independent and preserves offline seen/asked facts", () => {
  const first = poolFromLibrary(library(a)), second = poolFromLibrary(library(b,true)), third = poolFromLibrary(library(a,true));
  third.papers[0].title = "renamed";
  assert.deepEqual(mergePools(first,second,third),mergePools(third,second,first));
  assert.deepEqual(mergePools(mergePools(first,second),third),mergePools(first,mergePools(second,third)));
  assert.deepEqual(mergePools(first,first),first);
  assert.equal(mergePools(first,third).papers[0].askedAt,200);
});
test("two isolated devices sync bidirectionally across HTTP with ETag races, offline recovery and restarts", async () => {
  let value, revision = 0, offline = false, conflicts = 0;
  const server = createServer(async (req,res) => {
    if(offline) {res.writeHead(503).end(); return;}
    if(req.headers.authorization !== 'Basic '+Buffer.from('user:secret').toString('base64')) {res.writeHead(401).end();return;}
    if(req.method === "GET") {
      res.writeHead(value ? 200 : 404,value ? {ETag:`"${revision}"`,"Content-Type":"application/json"} : {}); res.end(value || "");return;
    }
    let body=""; for await(const chunk of req) body += chunk;
    if ((value && req.headers['if-match'] !== `"${revision}"`) || (!value && req.headers['if-none-match'] !== '*')) {conflicts++;res.writeHead(412).end();return;}
    value=body;revision++;res.writeHead(201).end();
  });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"pool-devices-"));
  const config={url:`http://127.0.0.1:${server.address().port}/pool/`,username:"user",password:"secret"};
  let leftLibrary=library(a,true),rightLibrary=library(b);
  const options=(name,load)=>({directory:path.join(dir,name),loadLibrary:load,encodeSecret:()=>"encrypted-test-secret",decodeSecret:()=>"secret",allowHttp:true});
  let left=createPoolSync(options("windows",async()=>leftLibrary)),right=createPoolSync(options("ubuntu",async()=>rightLibrary));
  try {
    await Promise.all([left.configure(config),right.configure(config)]);
    await left.run(); await right.run();
    assert.equal((await left.status()).papers.length,2); assert.equal((await right.status()).papers.length,2);
    assert.ok(conflicts>=1,"concurrent first creation must exercise 412 retry");
    assert.ok(!value.includes("private"));
    const saved=await fs.readFile(path.join(dir,"windows","paper-pool-config.json"),"utf8"); assert.ok(!saved.includes('"password"'));
    offline=true;rightLibrary=library(b,true);assert.ok((await right.run()).error);
    await right.stop();right=createPoolSync(options("ubuntu",async()=>({papers:[],messagesByScope:{}})));
    assert.equal((await right.status()).papers.find(p=>p.id===b).askedAt,200);
    offline=false;await right.run();const synced=await left.run(); assert.equal(synced.papers.find(p=>p.id===b).askedAt,200);
    await right.configure(null);assert.equal((await right.status()).configured,false);assert.equal((await right.status()).papers.length,2);
  } finally { await left.stop();await right.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true}); }
});
test("sync refuses insecure URLs, incompatible versions, missing ETags and redirects without sending a PUT", async () => {
  assert.throws(()=>poolEndpoint("http://example.com")); assert.throws(()=>poolEndpoint("https://user:secret@example.com"));
  const config={url:"https://example.com/pool",username:"user",password:"secret"};let writes=0;
  for(const response of [new Response('{"version":2,"papers":[]}',{headers:{etag:'"1"'}}),new Response('{"version":1,"papers":[]}')]) {
    await assert.rejects(exchangePool(config,poolFromLibrary(library(a)),async(_url,options)=>{assert.equal(options.redirect,"error"); if(options.method === 'PUT')writes++;return response;}));
  }
  assert.equal(writes,0);
});
