import {
  memo,
  useCallback,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { X } from "lucide-react";
import type { PaperRecord } from "../types";

type Props = {
  papers: PaperRecord[];
  activePaperId?: string;
  onActivate(paperId: string): void;
  onClose(paperId: string): void;
};

type PaperTabItemProps = {
  paperId: string;
  title: string;
  active: boolean;
  registerTab(paperId: string, node: HTMLButtonElement | null): void;
  onActivate(paperId: string): void;
  onClose(paperId: string): void;
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>, paperId: string): void;
};

const TAB_BUTTON_STYLE: CSSProperties = {
  minWidth: 0,
  flex: 1,
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: 0,
  color: "inherit",
  border: 0,
  background: "transparent",
  cursor: "pointer",
};

const CLOSE_BUTTON_STYLE: CSSProperties = {
  padding: 0,
  border: 0,
  background: "transparent",
  cursor: "pointer",
};

const PaperTabItem = memo(function PaperTabItem({
  paperId,
  title,
  active,
  registerTab,
  onActivate,
  onClose,
  onKeyDown,
}: PaperTabItemProps) {
  return (
    <div className={`paper-tab ${active ? "paper-tab--active" : ""}`}>
      <button
        ref={(node) => registerTab(paperId, node)}
        type="button"
        role="tab"
        aria-selected={active}
        aria-label={`阅读论文《${title}》`}
        tabIndex={active ? 0 : -1}
        title={title}
        style={TAB_BUTTON_STYLE}
        onClick={() => onActivate(paperId)}
        onKeyDown={(event) => onKeyDown(event, paperId)}
      >
        <span className="paper-tab__dot" aria-hidden="true" />
        <span className="paper-tab__title">{title}</span>
      </button>
      <button
        type="button"
        className="paper-tab__close"
        aria-label={`关闭论文《${title}》`}
        tabIndex={active ? 0 : -1}
        title={`关闭《${title}》`}
        style={CLOSE_BUTTON_STYLE}
        onClick={() => onClose(paperId)}
      >
        <X size={13} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
  );
});

function PaperTabs({ papers, activePaperId, onActivate, onClose }: Props) {
  const papersRef = useRef(papers);
  const activePaperIdRef = useRef(activePaperId);
  const onActivateRef = useRef(onActivate);
  const onCloseRef = useRef(onClose);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  papersRef.current = papers;
  activePaperIdRef.current = activePaperId;
  onActivateRef.current = onActivate;
  onCloseRef.current = onClose;

  const registerTab = useCallback((paperId: string, node: HTMLButtonElement | null) => {
    if (node) tabRefs.current.set(paperId, node);
    else tabRefs.current.delete(paperId);
  }, []);

  const focusAndActivate = useCallback((paperId: string) => {
    onActivateRef.current(paperId);
    window.requestAnimationFrame(() => tabRefs.current.get(paperId)?.focus());
  }, []);

  const closePaper = useCallback((paperId: string) => {
    const currentPapers = papersRef.current;
    const index = currentPapers.findIndex((paper) => paper.id === paperId);
    const activePaper = currentPapers.find((paper) => paper.id === activePaperIdRef.current);
    const focusTarget = paperId === activePaperIdRef.current
      ? currentPapers[index + 1] ?? currentPapers[index - 1]
      : activePaper;
    onCloseRef.current(paperId);
    if (focusTarget) {
      window.requestAnimationFrame(() => tabRefs.current.get(focusTarget.id)?.focus());
    }
  }, []);

  const handleTabKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, paperId: string) => {
    const currentPapers = papersRef.current;
    const index = currentPapers.findIndex((paper) => paper.id === paperId);
    if (index < 0) return;

    let target: PaperRecord | undefined;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        target = currentPapers[(index + 1) % currentPapers.length];
        break;
      case "ArrowLeft":
      case "ArrowUp":
        target = currentPapers[(index - 1 + currentPapers.length) % currentPapers.length];
        break;
      case "Home":
        target = currentPapers[0];
        break;
      case "End":
        target = currentPapers[currentPapers.length - 1];
        break;
      case "Delete":
        event.preventDefault();
        closePaper(paperId);
        return;
      default:
        return;
    }

    event.preventDefault();
    if (target) focusAndActivate(target.id);
  }, [closePaper, focusAndActivate]);

  if (!papers.length) return null;

  return (
    <div
      className="paper-tabs"
      role="tablist"
      aria-label="已打开的论文"
      aria-orientation="horizontal"
    >
      {papers.map((paper) => (
        <PaperTabItem
          key={paper.id}
          paperId={paper.id}
          title={paper.title}
          active={paper.id === activePaperId}
          registerTab={registerTab}
          onActivate={focusAndActivate}
          onClose={closePaper}
          onKeyDown={handleTabKeyDown}
        />
      ))}
    </div>
  );
}

export default memo(PaperTabs);
