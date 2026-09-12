import test from "node:test";
import assert from "node:assert/strict";
import { createPaperSearch, arxivSuggestions, openAlexSuggestions } from "../electron/paper-search.mjs";
import { titleMatchScore, localPaperSuggestions } from "../electron/paper-search-utils.mjs";

test("title suggestions match partial, reordered and one-letter misspellings", () => {
  assert.ok(titleMatchScore("diffusion pol", "Diffusion Policy: Visuomotor Policy Learning"));
  assert.ok(titleMatchScore("policy difusion", "Diffusion Policy"));
  assert.ok(titleMatchScore("difufsion pol", "Diffusion Policy"));
  assert.ok(titleMatchScore("difus pol", "Diffusion Policy"));
  assert.ok(titleMatchScore("open vla", "OpenVLA: An Open-Source Vision-Language-Action Model"));
  assert.ok(titleMatchScore("openlva", "OpenVLA"));
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
  const result=await service.search('openvla');assert.equal(result.items[0].arxivId,'2406.09246v2');assert.equal(seen.length,3);
  const failed=createPaperSearch({minimumDelay:0,arxivDelay:0,fetcher:async()=>new Response('',{status:503})});
  assert.ok((await failed.search('unavailable')).error);
});

test("OpenAlex typeahead preserves unfinished titles when Semantic Scholar is unavailable", async () => {
  const service = createPaperSearch({minimumDelay:0, arxivDelay:0,fetcher:async url => {
    if (url.includes('semanticscholar')) return new Response('',{status:429});
    if (url.includes('autocomplete/works')) return Response.json({results:[{id:'https://openalex.org/W123',display_name:'OpenVLA',hint:'Kim et al.'},{id:'https://evil.example/W999',display_name:'OpenVLA forged'}]});
    if (url.includes('/works/W123')) return Response.json({id:'https://openalex.org/W123',display_name:'OpenVLA',locations:[{pdf_url:'https://evil.example/2406.09246'}, {landing_page_url:'https://arxiv.org/abs/2406.09246'}]});
    throw new Error('Unexpected fallback');
  }});
  const result = await service.search('openvl');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].openAlexId, 'W123');
  assert.equal(result.items[0].source, 'openalex');
  assert.deepEqual(await service.resolve('W123'), {arxivId:'2406.09246'});
  await assert.rejects(() => service.resolve('W123/../../secret'), /无效/);
  assert.equal(openAlexSuggestions({results:[{id:'https://openalex.org/W123',display_name:'Paper',external_id:'https://evil.example/2406.09246'}]})[0].arxivId, undefined);
});

test("empty autocomplete falls back to a fuzzy title query and excludes unrelated matches", async () => {
  let expression;
  const service = createPaperSearch({minimumDelay:0, arxivDelay:0,fetcher:async url => {
    if (url.includes('semanticscholar')) return Response.json({matches:[]});
    if (url.includes('/autocomplete/works')) return Response.json({results:[]});
    expression = new URL(url).searchParams.get('filter');
    return Response.json({results:[{id:'https://openalex.org/W100',display_name:'Diffusion Policy',locations:[{pdf_url:'https://arxiv.org/pdf/2303.04137'}]},{id:'https://openalex.org/W200',display_name:'Unrelated research'}]});
  }});
  const result = await service.search('difusion policy');
  assert.equal(expression, 'title.search:difusion~1 AND policy~1');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].arxivId, '2303.04137');
});

test("rapid typing keeps the latest queued query, skips obsolete prefixes, and bounds requests", async () => {
  const gates = new Map(), seen = [];
  const service = createPaperSearch({minimumDelay:0, arxivDelay:0,fetcher:async url => {
    const query = new URL(url).searchParams.get('query'); seen.push(query);
    await new Promise(resolve => gates.set(query, resolve));
    return Response.json({matches:[{id:'d'.repeat(40),title:'Diffusion Policy'}]});
  }});
  const first = service.search('diffu'), second = service.search('diffus');
  await new Promise(resolve => setTimeout(resolve, 10));
  const obsolete = service.search('diffusi'), latest = service.search('diffusion');
  assert.equal(service.search('diffusion'), latest);
  assert.deepEqual(await obsolete, {items:[]});
  assert.deepEqual(seen, ['diffu','diffus']);
  gates.get('diffu')(); await first;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(seen, ['diffu','diffus','diffusion']);
  gates.get('diffus')(); gates.get('diffusion')();
  await second;
  assert.equal((await latest).items[0].title, 'Diffusion Policy');
});

test("a failed lookup can be retried immediately and direct arxiv imports never search", async () => {
  let offline = true, calls = 0;
  const service = createPaperSearch({minimumDelay:0, arxivDelay:0,fetcher:async () => {
    calls++;
    return offline ? new Response('',{status:503}) : Response.json({matches:[{id:'e'.repeat(40),title:'OpenVLA'}]});
  }});
  assert.ok((await service.search('openvl')).error);
  offline = false;
  assert.equal((await service.search('openvl')).items[0].title, 'OpenVLA');
  const before = calls;
  assert.deepEqual(await service.search('2406.09246'), {items:[]});
  assert.deepEqual(await service.search('https://arxiv.org/pdf/2406.09246'), {items:[]});
  assert.equal(calls, before);
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
