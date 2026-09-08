import assert from "node:assert/strict";
import test from "node:test";
import { selectContextDocuments } from "../electron/context-selection.mjs";

test("a budget too small for the paper mapping fails explicitly instead of exceeding the limit", () => {
  assert.throws(() => selectContextDocuments(Array.from({ length: 30 }, (_, index) => ({ id: String(index), content: "## 第 1 页\nexample" })), { budgetBytes: 4_000 }), /超过上下文预算/);
});

test("small papers remain lossless including Unicode, formulas and page boundaries", () => {
  const content = "Title\n## 第 1 页\n中文、公式 $QK^T$，αβ\n## 第 2 页\n实验 28.4 BLEU";
  const selected = selectContextDocuments([{id:"a",content}],{question:"公式"});
  assert.equal(selected.complete,true);
  assert.equal(selected.documents[0].content,content);
  assert.deepEqual(selected.documents[0].pages,[1,2]);
});

test("a large multi-paper scope stays within budget and includes remote query evidence from each paper", () => {
  const documents = ["a","b"].map((id) => ({id,content:"Metadata\n"+Array.from({length:80},(_,i)=>`## 第 ${i+1} 页\n${i===57 ? `JPX ablation error rate 0.${id === "a" ? "37" : "52"}. ` : "Background material. "}${"ordinary words ".repeat(75)}\n`).join("")}));
  const result = selectContextDocuments(documents,{question:"Compare JPX ablation error rate",budgetBytes:12_000,currentPaperId:"a",currentPage:3});
  assert.equal(result.complete,false);
  assert.ok(result.textBytes<12_000);
  for(const paper of result.documents) {
    assert.ok(paper.pages.includes(58));
    assert.match(paper.content,/error rate 0\.(37|52)/);
    assert.equal(paper.totalPages,80);
    assert.ok(paper.pages.length<80);
  }
});

test("an oversized page is labelled as an excerpt and does not split a Unicode character", () => {
  const result = selectContextDocuments([{id:"a",content:"## 第 1 页\n"+"无关背景".repeat(9000)+"关键消融准确率0.37"+"尾部".repeat(2000)}],{question:"关键消融",budgetBytes:4_000});
  assert.equal(result.complete,false);
  assert.match(result.documents[0].content,/本页节选/);
  assert.match(result.documents[0].content,/准确率0.37/);
  assert.doesNotMatch(result.documents[0].content,/\uFFFD/);
  assert.ok(result.textBytes<=2_700);
});
