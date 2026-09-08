export const PAPER_CATEGORIES = ["运动控制", "动作生成", "VLA", "世界模型", "待分类"];
const rules = [
  ["VLA", /\b(?:vla|openvla|rt-2|rt-1|octo|pi0|pi-0|pi-0\.5)\b|vision[\s-]+language[\s-]+action|视觉[语言与\s、-]*动作|视觉语言动作|π\s*[0０.]/gi],
  ["世界模型", /world[\s-]+model|world[\s-]+simulator|learned[\s-]+simulator|latent[\s-]+dynamics|video[\s-]+prediction|\b(?:dreamer|genie)\b|世界模型|视频预测|动力学模型/gi],
  ["动作生成", /motion[\s-]+(?:generation|synthesis|diffusion)|action[\s-]+(?:generation|chunking)|text[\s-]+to[\s-]+motion|diffusion[\s-]+policy|动作生成|运动生成|动作合成|轨迹生成/gi],
  ["运动控制", /locomotion|loco[\s-]?manipulation|whole[\s-]+body[\s-]+control|motor[\s-]+control|motion[\s-]+control|model[\s-]+predictive[\s-]+control|policy[\s-]+adaptation|sim[\s-]+to[\s-]+real|sim2real|legged|quadruped|bipedal|humanoid[\s-]+control|运动控制|步态|行走|全身控制|四足|平衡控制/gi],
];
export function classifyPaper(paper, excerpt = "") {
  const title = String(paper.title || "").normalize("NFKC"), context = `${paper.abstract || ""}\n${excerpt}`.normalize("NFKC").slice(0, 12000);
  const ranked = rules.map(([category, regex]) => {
    const inTitle = [...title.matchAll(regex)].map(match => match[0]);
    const inContext = [...context.matchAll(regex)].map(match => match[0]);
    return { category, score: (inTitle.length ? 12 : 0) + Math.min(4, inContext.length), matches: [...new Set([...inTitle, ...inContext])].slice(0, 3) };
  }).sort((a, b) => b.score - a.score);
  const first = ranked[0], next = ranked[1];
  if (!first.score || (first.score < 12 && first.score === next.score)) return { category: "待分类", reason: "线索不足或主题交叉，可手动选择分类" };
  return { category: first.category, reason: `根据标题与原文线索：${first.matches.join("、")}` };
}
