function normalizeOutsideCodeFences(value) {
  return value
    .replace(/\*\*[ \t]+(?=\S)/g, "**")
    .replace(/\*\*((?=[\p{L}\p{N}])[^*\r\n]*?\S)[ \t]+\*\*/gu, "**$1**")
    .replace(/(\*\*(?=[\p{L}\p{N}])[^*\r\n]+?\*\*)(?=[\p{L}\p{N}])/gu, "$1 ")
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_match, body) => `\n$$\n${body.trim()}\n$$\n`)
    .replace(/\\\(([^\r\n]*?)\\\)/g, (_match, body) => `$${body.trim()}$`);
}

export function normalizePaperMarkdown(source) {
  if (typeof source !== "string" || !source) return "";

  const lines = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [source];
  const output = [];
  let prose = "";
  let fence = null;

  const flushProse = () => {
    if (!prose) return;
    output.push(normalizeOutsideCodeFences(prose));
    prose = "";
  };

  for (const line of lines) {
    if (!line) continue;
    const content = line.replace(/[\r\n]+$/, "");

    if (fence) {
      output.push(line);
      const closePattern = new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`);
      if (closePattern.test(content)) fence = null;
      continue;
    }

    const opening = content.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening) {
      flushProse();
      output.push(line);
      fence = { character: opening[1][0], length: opening[1].length };
      continue;
    }

    prose += line;
  }

  flushProse();
  return output.join("");
}
