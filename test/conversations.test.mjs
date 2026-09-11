import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConversations, samePaperSet, validateConversationPapers } from "../electron/conversations.mjs";

const a = "a".repeat(24);
const b = "b".repeat(24);
const c = "c".repeat(24);
const id = "conversation:12345678-1234-1234-1234-123456789abc";

test("auxiliary conversations retain a separate identity bound to exactly one paper", () => {
  const scope = `auxiliary:${a}`;
  const library = { papers: [{id:a,title:"A"},{id:b,title:"B"}], conversations: {
    [scope]: {id:scope,title:"辅助对话",paperIds:[a],createdAt:1,updatedAt:2},
  }, threadsByScope: {[`paper:${a}`]:"main-thread",[scope]:"auxiliary-thread"} };
  const restored = normalizeConversations(JSON.parse(JSON.stringify(library)));
  assert.deepEqual(restored[scope].paperIds,[a]);
  assert.deepEqual(restored[`paper:${a}`].paperIds,[a]);
  assert.notEqual(library.threadsByScope[scope],library.threadsByScope[`paper:${a}`]);
  assert.doesNotThrow(() => validateConversationPapers(library,scope,[a]));
  assert.throws(() => validateConversationPapers(library,scope,[b]),/不匹配/);
  assert.throws(() => validateConversationPapers(library,scope,[a,b]),/不匹配/);
});

test("conversation migration preserves single-paper identity and does not invent the sources of legacy mixed history", () => {
  const history = [{ id: "old-message", text: "A historic comparison" }];
  const library = { papers: [{ id: a, title: "Paper A" }], openPaperIds: [a], messagesByScope: { all: history }, threadsByScope: { all: "old-thread" } };
  const result = normalizeConversations(library);
  assert.deepEqual(result[`paper:${a}`].paperIds, [a]);
  assert.deepEqual(result.all.paperIds, []);
  assert.equal(result.all.readOnly, true);
  assert.equal(library.messagesByScope.all, history);
  assert.equal(library.threadsByScope.all, "old-thread");
});

test("changing open tabs never changes the paper versions bound to an existing conversation", () => {
  const conversation = { id, title: "A and B", paperIds: [a,b], createdAt:1, updatedAt:2 };
  const library = { papers:[{id:a},{id:b},{id:c}], conversations:{[id]:conversation}, openPaperIds:[a,c] };
  assert.deepEqual(normalizeConversations(library)[id].paperIds, [a,b]);
  assert.equal(samePaperSet([a,b], [b,a]), true);
  assert.equal(samePaperSet([a,b], [a,c]), false);
  // A temporarily missing paper must remain part of the contract, not vanish.
  assert.deepEqual(normalizeConversations({...library,papers:[{id:a}]})[id].paperIds,[a,b]);
  assert.doesNotThrow(()=>validateConversationPapers(library,id,[b,a]));
  assert.throws(()=>validateConversationPapers(library,id,[a,c]),/集合不匹配/);
  assert.throws(()=>validateConversationPapers(library,"all",[a,b]),/新建讨论/);
});
