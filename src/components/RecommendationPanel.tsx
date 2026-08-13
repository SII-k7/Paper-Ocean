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
import type { PaperRecord, Recommendation } from "../types";
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

const DISCOVERY_LABEL_STYLE: CSSProperties = {
  flex: 1,
  display: "grid",
  placeItems: "center",
  color: "#5f6977",
  borderBottom: "2px solid transparent",
  fontSize: 10,
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
        {item.year && <span className="paper-year">{item.year}</span>}
        {item.citationCount !== undefined && <span>引用 {item.citationCount}</span>}
        {item.score !== undefined && <span>综合 {Math.round(item.score * 100)}</span>}
      </div>
      <div className="recommendation-card__content">
        <RecommendationThumbnail
          arxivId={item.arxivId}
          title={item.title}
          generation={generation}
        />
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
    setItems([]);
    setLoading(true);
    setError(null);
    window.paperOcean.recommendations({
      title: paper.title,
      abstract: paper.abstract,
      arxivId: paper.arxivId,
    }).then((nextItems) => {
      if (!cancelled) setItems(nextItems);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [paper?.id, paper?.title, paper?.abstract, paper?.arxivId, refreshKey]);

  return (
    <section
      className="recommendation-panel"
      aria-labelledby="recommendation-panel-title"
      aria-busy={loading}
    >
      <div className="panel-heading recommendation-heading">
        <div>
          <span className="eyebrow">DISCOVERY</span>
          <h2 id="recommendation-panel-title">近三年精选</h2>
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
        <span
          aria-current="true"
          style={{ ...DISCOVERY_LABEL_STYLE, color: "#77e6b6", borderColor: "#77e6b6" }}
        >
          {currentYear - 2}–{currentYear}
        </span>
        <span aria-disabled="true" style={DISCOVERY_LABEL_STYLE}>领域地图</span>
        <span aria-disabled="true" style={DISCOVERY_LABEL_STYLE}>宁缺毋滥</span>
      </div>

      <div className="recommendation-list">
        {!paper && <div className="side-empty">打开论文后，这里会生成你的下一站。</div>}
        {loading && <div className="side-empty" role="status" aria-live="polite">正在综合关联度与近年影响力筛选论文…</div>}
        {error && (
          <div className="side-error" role="alert">
            <strong>暂时无法获取推荐</strong>
            <span>{error}</span>
            <button type="button" onClick={refresh} aria-label="重试获取论文推荐">重试</button>
          </div>
        )}
        {!loading && !error && paper && !items.length && (
          <div className="side-empty" role="status">近三年内暂时没有达到质量门槛、且可直接打开的论文。</div>
        )}
        {items.map((item, index) => (
          <RecommendationCard
            key={item.paperId}
            item={item}
            index={index}
            generation={`${paper?.id ?? "empty"}:${refreshKey}`}
            onOpenArxiv={openArxiv}
          />
        ))}
      </div>
    </section>
  );
}

export default memo(RecommendationPanel);
