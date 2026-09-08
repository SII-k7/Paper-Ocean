import test from "node:test";
import assert from "node:assert/strict";
import { createPaperSearch, arxivSuggestions } from "../electron/paper-search.mjs";
import { titleMatchScore, localPaperSuggestions } from "../electron/paper-search-utils.mjs";

test("title suggestions match partial, reordered and one-letter misspellings", () => {
  assert.ok(titleMatchScore("diffusion pol", "Diffusion Policy: Visuomotor Policy Learning"));
  assert.ok(titleMatchScore("policy difusion", "Diffusion Policy"));
  assert.ok(titleMatchScore("全身 控制", "机器人全身运动控制"));
  assert.equal(titleMatchScore("world model", "Diffusion Policy"), 0);
  assert.equal(localPaperSuggestions("openvl", [{id:"a",title:"OpenVLA",openedAt:1}])[0].paperId,"a");
});
test("online suggestions deduplicate concurrent queries, cache and resolve verified arxiv IDs", async () => {
  let calls = 0;
  const service = createPaperSearch({ minimumDelay:0, arxivDelay:0, fetcher:async url => {
    calls++;
    return new Response(JSON.stringify(url.includes("autocomplete") ? { matches:[{id:"a".repeat(40),title:"OpenVLA",authorsYear:"Kim et al., 2024"},{id:"../../secret",title:"invalid"}] } : {externalIds:{ArXiv:"2406.09246v2"}}));
  }});
  const [first, second] = await Promise.all([service.search("openvl"),service.search("openvl")]);
  assert.deepEqual(first,second);assert.equal(first.items.length,1);assert.equal(calls,1);
  await service.search("openvl");assert.equal(calls,1);
  assert.deepEqual(await service.resolve("a".repeat(40)),{arxivId:"2406.09246v2"});
  await assert.rejects(()=>service.resolve("../../secret"));
});
test("arxiv fallback preserves titles, version and authors without trusting arbitrary links", async () => {
  const xml='<feed><entry><id>http://arxiv.org/abs/2406.09246v2</id><title>OpenVLA &amp; Robots</title><author><name>A Author</name></author><published>2024-06-13T00:00:00Z</published></entry><entry><id>https://evil.example/1234.56789</id><title>Wrong host</title></entry></feed>';
  assert.equal(arxivSuggestions(xml).length,1);assert.equal(arxivSuggestions(xml)[0].title,"OpenVLA & Robots");
  const seen=[];const service=createPaperSearch({minimumDelay:0,arxivDelay:0,fetcher:async url=>{seen.push(url);return url.includes('semanticscholar')?new Response('',{status:429}):new Response(xml);}});
  const result=await service.search('openvla');assert.equal(result.items[0].arxivId,'2406.09246v2');assert.equal(seen.length,2);
  const failed=createPaperSearch({minimumDelay:0,arxivDelay:0,fetcher:async()=>new Response('',{status:503})});
  assert.ok((await failed.search('unavailable')).error);
});

test("resolving a rate-limited suggestion falls back only to the same arxiv title", async () => {
  let wrong = false;
  const service = createPaperSearch({ minimumDelay:0, arxivDelay:0, fetcher:async url => {
    if (url.includes('autocomplete')) return Response.json({matches:[{id:'b'.repeat(40),title:'OpenVLA'}]});
    if (url.includes('semanticscholar')) return new Response('',{status:429});
    return new Response(`<feed><entry><id>https://arxiv.org/abs/2406.09246</id><title>${wrong?'OpenVLA Followup':'OpenVLA'}</title></entry></feed>`);
  }});
  await service.search('openvl');
  wrong = true; await assert.rejects(()=>service.resolve('b'.repeat(40)),/暂不可用/);
  wrong = false; assert.deepEqual(await service.resolve('b'.repeat(40)),{arxivId:'2406.09246'});
});

test("OpenAlex can resolve a limited provider only through exact titles and verified arxiv links", async () => {
  const service = createPaperSearch({minimumDelay:0, arxivDelay:0,fetcher:async url => {
    if (url.includes('autocomplete')) return Response.json({matches:[{id:'c'.repeat(40),title:'OpenVLA'}]});
    if (url.includes('semanticscholar')) return new Response('',{status:429});
    if (url.includes('openalex')) return Response.json({results:[
      {display_name:'Other paper',locations:[{pdf_url:'https://arxiv.org/pdf/1234.56789'}]},
      {display_name:'OpenVLA',locations:[{pdf_url:'https://evil.example/2406.09246'},{landing_page_url:'https://arxiv.org/abs/2406.09246'}]},
    ]});
    throw new Error('arxiv fallback should not be needed');
  }});
  await service.search('openvl');
  assert.deepEqual(await service.resolve('c'.repeat(40)),{arxivId:'2406.09246'});
});
