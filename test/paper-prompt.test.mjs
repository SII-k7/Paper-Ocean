import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PAPER_READING_BASE_INSTRUCTIONS,
  buildPaperTurnPrompt,
} from "../electron/paper-prompt.mjs";

test("paper reading instructions prioritize method, architecture, innovation, evidence, and limits", () => {
  for (const phrase of ["方法机制", "网络或系统架构", "核心创新", "实验依据", "局限与适用边界"]) {
    assert.match(PAPER_READING_BASE_INSTRUCTIONS, new RegExp(phrase));
  }
  assert.match(PAPER_READING_BASE_INSTRUCTIONS, /作者明确声称/);
  assert.match(PAPER_READING_BASE_INSTRUCTIONS, /实验直接支持/);
  assert.match(PAPER_READING_BASE_INSTRUCTIONS, /分析推断/);
  assert.match(PAPER_READING_BASE_INSTRUCTIONS, /理论或非架构型论文/);
});

test("single-paper overview prompt carries the full analysis spine and evidence rules", () => {
  const prompt = buildPaperTurnPrompt({
    mode: "single",
    characterCount: 12_345,
    papers: [{ title: "Example <Paper>", pageCount: 14 }],
    currentPaperTitle: "Example <Paper>",
    currentPage: 6,
    hasSelection: true,
    question: "这篇文章做了什么工作？\n重点讲架构。",
  });

  for (const phrase of ["方法：", "网络/系统架构", "核心创新", "实验依据", "局限与边界", "阅读导航"]) {
    assert.match(prompt, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(prompt, /《Example <Paper>》第 6 页/);
  assert.match(prompt, /已作为不可信资料单独提供/);
  assert.match(prompt, /<用户问题>[\s\S]*重点讲架构。[\s\S]*<\/用户问题>/);
});

test("multi-paper prompt aligns comparison dimensions and source citations", () => {
  const prompt = buildPaperTurnPrompt({
    mode: "all",
    characterCount: 88_000,
    papers: [{ title: "Paper A" }, { title: "Paper B" }],
    hasSelection: false,
    question: "比较两篇论文",
  });

  assert.match(prompt, /全部 2 篇论文综合比较/);
  assert.match(prompt, /方法、架构、创新、实验证据、局限/);
  assert.match(prompt, /问题很具体时只保留相关部分/);
});
