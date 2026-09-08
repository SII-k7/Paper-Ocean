const PAPER_ID = /^[a-f0-9]{24}$/;
export const isConversationKey = (value) => typeof value === "string" && (value === "all" || /^paper:[a-f0-9]{24}$/.test(value) || /^conversation:[a-f0-9-]{36}$/.test(value));

export function normalizeConversations(library) {
  const conversations = {};
  for (const [id, item] of Object.entries(library.conversations || {})) {
    if (!isConversationKey(id) || !item || !Array.isArray(item.paperIds)) continue;
    conversations[id] = {
      id, title: typeof item.title === "string" ? item.title.slice(0, 300) : "论文讨论",
      paperIds: [...new Set(item.paperIds.filter((paperId) => typeof paperId === "string" && PAPER_ID.test(paperId)))],
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0,
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
      readOnly: item.readOnly === true,
    };
  }
  for (const paper of library.papers || []) {
    if (!PAPER_ID.test(paper.id)) continue;
    const id = `paper:${paper.id}`;
    if (!conversations[id]) conversations[id] = {
      id, title: paper.title || paper.name || "论文讨论", paperIds: [paper.id],
      createdAt: paper.openedAt || 0, updatedAt: paper.openedAt || 0, readOnly: false,
    };
  }
  // Older builds reused one "all" thread for changing tab sets. There is no
  // reliable way to infer its historic sources; preserve it as an archive.
  const hasLegacyAll = (library.messagesByScope?.all?.length ?? 0) > 0 || library.threadsByScope?.all || library.draftsByScope?.all;
  if (hasLegacyAll && !conversations.all) conversations.all = {
    id: "all", title: "旧多论文讨论（历史记录）", paperIds: [],
    createdAt: 0, updatedAt: 0, readOnly: true,
  };
  return conversations;
}

export function samePaperSet(left, right) {
  const first = [...new Set(left)].sort();
  const second = [...new Set(right)].sort();
  return first.length === second.length && first.every((id, index) => id === second[index]);
}

export function validateConversationPapers(library, scopeKey, paperIds) {
  if (!isConversationKey(scopeKey)) throw new Error("讨论标识无效");
  if (scopeKey.startsWith("paper:")) {
    if (!samePaperSet([scopeKey.slice(6)], paperIds)) throw new Error("论文与讨论不匹配");
    return;
  }
  const conversation = normalizeConversations(library)[scopeKey];
  if (scopeKey === "all" || conversation?.readOnly) throw new Error("旧多论文历史未记录完整论文集合，请新建讨论继续");
  if (!conversation) throw new Error("讨论尚未保存，请重试保存后继续");
  if (!samePaperSet(conversation.paperIds, paperIds)) throw new Error("这次讨论绑定的论文集合不匹配，请新建讨论");
}
