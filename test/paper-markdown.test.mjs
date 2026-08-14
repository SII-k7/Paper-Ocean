import assert from "node:assert/strict";
import test from "node:test";
import { normalizePaperMarkdown } from "../src/paper-markdown.mjs";

test("normalizes display and inline LaTeX delimiters", () => {
  const source = "## 方法\n\n\\[\na + b = c\n\\]\n\n其中 \\(a\\) 是输入。";
  const normalized = normalizePaperMarkdown(source);

  assert.match(normalized, /## 方法/);
  assert.match(normalized, /\$\$\na \+ b = c\n\$\$/);
  assert.match(normalized, /其中 \$a\$ 是输入/);
  assert.doesNotMatch(normalized, /\\\[|\\\]|\\\(|\\\)/);
});

test("does not rewrite LaTeX delimiters inside fenced code", () => {
  const fenced = "```tex\n\\[x^2\\]\n\\(y\\)\n```";
  assert.equal(normalizePaperMarkdown(fenced), fenced);
});

test("preserves ordinary Markdown and tilde fences", () => {
  const source = "**结论**\n\n~~~text\n\\[raw\\]\n~~~\n\n- 项目";
  const normalized = normalizePaperMarkdown(source);

  assert.match(normalized, /^\*\*结论\*\*/);
  assert.match(normalized, /~~~text\n\\\[raw\\\]\n~~~/);
  assert.match(normalized, /- 项目$/);
});

test("keeps Chinese text after a bold span parseable by CommonMark", () => {
  const normalized = normalizePaperMarkdown("这是**核心创新。**这是后续解释");
  assert.equal(normalized, "这是**核心创新。** 这是后续解释");
});

test("repairs spaces accidentally placed inside bold delimiters", () => {
  const normalized = normalizePaperMarkdown("达到 ** 26/27（96.3%） **；效果明显");
  assert.equal(normalized, "达到 **26/27（96.3%）**；效果明显");
});

test("does not confuse adjacent bold spans with a new delimiter pair", () => {
  const source = "成功率为 **16/27（59.3%）**，SplitAdapter达到 **26/27（96.3%）**；";
  assert.equal(normalizePaperMarkdown(source), source);
});
