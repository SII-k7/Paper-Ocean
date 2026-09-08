import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { PaperRecord, Recommendation, RecommendationResult } from "../types";
import RecommendationThumbnail from "./RecommendationThumbnail";

type Props = {
  paper: PaperRecord | null;
  onOpenArxiv(arxivId: string): void;
};

type RecommendationCardProps = {
  item: Recommendation;
  index: number;
  generation: string;
  onOpenArxiv(arxivId: string): void;
};

const CARD_OPEN_BUTTON_STYLE: CSSProperties = {
  position: "absolute",
  zIndex: 1,
  inset: 0,
  width: "100%",
  height: "100%",
  padding: 0,
  border: 0,
  borderRadius: 0,
  background: "transparent",
};

const CARD_ACTIONS_STYLE: CSSProperties = {
  position: "relative",
  zIndex: 2,
  pointerEvents: "auto",
};

const RecommendationCard = memo(function RecommendationCard({
  item,
  index,
  generation,
  onOpenArxiv,
}: RecommendationCardProps) {
  const accessibleId = useId();
  const titleId = `${accessibleId}-title`;
  const relationId = `${accessibleId}-relation`;

  const openInReader = useCallback(() => {
    if (item.arxivId) onOpenArxiv(item.arxivId);
  }, [item.arxivId, onOpenArxiv]);

  const openPaperPage = useCallback(() => {
    if (item.url) void window.paperOcean.openExternal(item.url);
  }, [item.url]);

  return (
    <article className="recommendation-card" aria-labelledby={titleId}>
      {item.arxivId && (
        <button
          type="button"
          className="recommendation-card--openable"
          aria-label={`在左侧新标签打开《${item.title}》`}
          aria-describedby={relationId}
          title="在左侧新标签页打开"
          style={CARD_OPEN_BUTTON_STYLE}
          onClick={openInReader}
        />
      )}

      <div className="paper-meta" aria-label="论文数据">
        <span className="recommendation-card__rank">{String(index + 1).padStart(2, "0")}</span>
        <span className="paper-year">{item.publishedAt || item.year || "日期未知"}</span>
        {item.citationCount !== undefined && <span>引用 {item.citationCount}</span>}
      </div>
      <div className="recommendation-card__content">
        {item.arxivId && <RecommendationThumbnail
          arxivId={item.arxivId}
          title={item.title}
          generation={generation}
        />}
        <div className="recommendation-card__body">
          <h3 id={titleId}>{item.title}</h3>
          <p className="authors">{item.authors.join(", ") || "作者信息未知"}</p>
          <div id={relationId} className="relation-tag">{item.reason}</div>
          {item.abstract && <p className="recommendation-abstract">{item.abstract}</p>}
          <div className="card-actions" style={CARD_ACTIONS_STYLE}>
            {item.url && (
              <button
                type="button"
                aria-label={`打开《${item.title}》的论文主页`}
                onClick={openPaperPage}
              >
                主页 <ExternalLink size={10} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
            {item.source && <button type="button" disabled={!item.sourceUrl} aria-label={`查看《${item.title}》的 ${item.source} 来源记录`} onClick={() => { if (item.sourceUrl) void window.paperOcean.openExternal(item.sourceUrl); }}>{item.source} ↗</button>}
          </div>
        </div>
      </div>
    </article>
  );
});

function RecommendationPanel({ paper, onOpenArxiv }: Props) {
  const [items, setItems] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [mode, setMode] = useState<"recent" | "foundations">("recent");
  const [snapshot, setSnapshot] = useState<RecommendationResult | null>(null);
  const consumedRefreshRef = useRef(0);
  const displayedRef = useRef("");
  const onOpenArxivRef = useRef(onOpenArxiv);
  const currentYear = new Date().getFullYear();

  onOpenArxivRef.current = onOpenArxiv;

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  const openArxiv = useCallback((arxivId: string) => onOpenArxivRef.current(arxivId), []);

  useEffect(() => {
    if (!paper?.title) {
      setItems([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = `${paper.id}:${mode}`;
    if (displayedRef.current !== key) { setItems([]); setSnapshot(null); displayedRef.current = key; }
    setLoading(true);
    setError(null);
    const refresh = consumedRefreshRef.current !== refreshKey;
    consumedRefreshRef.current = refreshKey;
    const request = (refresh = false) => {
      void window.paperOcean.recommendations({ title: paper.title, abstract: paper.abstract, arxivId: paper.arxivId, mode, refresh }).then((result) => {
        if (cancelled) return;
        setItems(result.items); setSnapshot(result); setError(result.error ?? null);
        if (result.pending) timer = setTimeout(() => request(), 5000);
      }).catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }).finally(() => { if (!cancelled) setLoading(false); });
    };
    request(refresh);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [paper?.id, paper?.title, paper?.abstract, paper?.arxivId, mode, refreshKey]);

  return (
    <section
      className="recommendation-panel"
      aria-labelledby="recommendation-panel-title"
      aria-busy={loading}
    >
      <div className="panel-heading recommendation-heading">
        <div>
          <span className="eyebrow">DISCOVERY</span>
          <h2 id="recommendation-panel-title">{mode === "recent" ? "近期进展" : "基础工作"}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={refresh}
          disabled={!paper || loading}
          title="刷新推荐"
          aria-label="刷新论文推荐"
        >
          <RefreshCw size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      <div className="discovery-tabs" role="group" aria-label="推荐筛选条件">
        <button type="button" aria-pressed={mode === "recent"} onClick={() => setMode("recent")}>近期进展</button>
        <button type="button" aria-pressed={mode === "foundations"} onClick={() => setMode("foundations")}>基础工作</button>
      </div>
      <p className="recommendation-explanation">{mode === "recent" ? `${currentYear - 2}–${currentYear} 的主题相关候选，相关度优先，引用量辅助排序。` : "从数据库收录的参考文献追溯方法来源，不限近三年；引用关系不代表重要性已获验证。"}</p>
      {snapshot && <p className="recommendation-cache" role="status">{snapshot.cache === "fresh" ? "已更新" : snapshot.cache === "stale" ? "使用旧缓存" : "使用缓存"} · {new Date(snapshot.fetchedAt).toLocaleString()}{snapshot.pending ? " · 后台更新中…" : ""}</p>}

      <div className="recommendation-list">
        {!paper && <div className="side-empty">打开论文后，这里会生成你的下一站。</div>}
        {loading && <div className="side-empty" role="status" aria-live="polite">正在检索论文，后台同时处理最多两项任务…</div>}
        {error && (
          <div className="side-error" role="alert">
            <strong>{items.length ? "推荐未能更新，仍可阅读已有结果" : "暂时无法获取推荐"}</strong>
            <span>{error}</span>
            <button type="button" onClick={refresh} aria-label="重试获取论文推荐">重试</button>
          </div>
        )}
        {!loading && !error && paper && !items.length && (
          <div className="side-empty" role="status">{mode === "recent" ? "近三年暂未找到可直接打开的相关候选。" : "数据库暂未返回可用的参考文献，请结合原文参考文献列表查找。"}</div>
        )}
        {items.map((item, index) => (
          <RecommendationCard
            key={item.paperId}
            item={item}
            index={index}
            generation={`${paper?.id ?? "empty"}:${mode}:${refreshKey}`}
            onOpenArxiv={openArxiv}
          />
        ))}
      </div>
    </section>
  );
}

export default memo(RecommendationPanel);
