import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { CodexEffort, CodexModel, CodexSelection } from "../types";

const MODEL_ORDER: CodexModel["id"][] = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

const MODEL_LABELS: Record<CodexModel["id"], string> = {
  "gpt-5.6-sol": "Sol",
  "gpt-5.6-terra": "Terra",
  "gpt-5.6-luna": "Luna",
};

const EFFORT_LABELS: Record<string, string> = {
  none: "即时",
  low: "轻量",
  medium: "均衡",
  high: "深入",
  xhigh: "很深",
  max: "极深",
  ultra: "极限",
};

export type ModelReasoningPickerProps = {
  models: CodexModel[];
  selection?: CodexSelection | null;
  busy?: boolean;
  className?: string;
  onChange(selection: CodexSelection): void;
};

function effortLabel(effort: CodexEffort) {
  return EFFORT_LABELS[effort] ?? effort;
}

function supportedEfforts(model: CodexModel | undefined) {
  return model ? [...new Set(model.supportedEfforts)] : [];
}

function defaultEffort(model: CodexModel, current?: CodexEffort) {
  const efforts = supportedEfforts(model);
  if (current && efforts.includes(current)) return current;
  if (efforts.includes(model.defaultEffort)) return model.defaultEffort;
  return efforts[0];
}

function handleRadioKeys(
  event: KeyboardEvent<HTMLButtonElement>,
  selector: string,
) {
  const direction = {
    ArrowLeft: -1,
    ArrowUp: -1,
    ArrowRight: 1,
    ArrowDown: 1,
  }[event.key];
  const isHome = event.key === "Home";
  const isEnd = event.key === "End";
  if (direction === undefined && !isHome && !isEnd) return;

  const group = event.currentTarget.closest<HTMLElement>("[role='radiogroup']");
  const options = group
    ? Array.from(group.querySelectorAll<HTMLButtonElement>(`${selector}:not(:disabled)`))
    : [];
  if (!options.length) return;

  event.preventDefault();
  const currentIndex = Math.max(options.indexOf(event.currentTarget), 0);
  const nextIndex = isHome
    ? 0
    : isEnd
      ? options.length - 1
      : (currentIndex + direction! + options.length) % options.length;
  options[nextIndex].focus();
  options[nextIndex].click();
}

export default function ModelReasoningPicker({
  models,
  selection,
  busy = false,
  className = "",
  onChange,
}: ModelReasoningPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const baseId = useId();

  const catalog = useMemo(() => {
    const byId = new Map(models.map((model) => [model.id, model]));
    return MODEL_ORDER.flatMap((id) => {
      const model = byId.get(id);
      return model ? [model] : [];
    });
  }, [models]);

  const selectableCatalog = catalog.filter((model) => supportedEfforts(model).length > 0);
  const activeModel = selectableCatalog.find((model) => model.id === selection?.model)
    ?? selectableCatalog.find((model) => model.isDefault)
    ?? selectableCatalog[0];
  const efforts = supportedEfforts(activeModel);
  const activeEffort = activeModel
    ? defaultEffort(activeModel, selection?.model === activeModel.id ? selection.effort : undefined)
    : undefined;
  const unavailable = selectableCatalog.length === 0;

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const selected = panelRef.current?.querySelector<HTMLButtonElement>(
        "[data-model-option][aria-checked='true']:not(:disabled)",
      );
      const first = panelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
      (selected ?? first)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [close, open]);

  useEffect(() => {
    if (open && (busy || unavailable)) setOpen(false);
  }, [busy, open, unavailable]);

  const chooseModel = (model: CodexModel) => {
    if (busy) return;
    const effort = defaultEffort(model, selection?.effort);
    if (!effort) return;
    if (selection?.model === model.id && selection.effort === effort) return;
    onChange({ model: model.id, effort });
  };

  const chooseEffort = (effort: CodexEffort) => {
    if (busy || !activeModel || !efforts.includes(effort)) return;
    if (selection?.model === activeModel.id && selection.effort === effort) return;
    onChange({ model: activeModel.id, effort });
  };

  const compactModel = activeModel ? MODEL_LABELS[activeModel.id] : "模型";
  const compactEffort = activeEffort ? effortLabel(activeEffort) : "不可用";
  const triggerDescription = busy
    ? "回答生成期间暂时不能更改模型设置"
    : unavailable
      ? "当前账户没有可用的 GPT-5.6 模型"
      : `当前使用 ${compactModel}，思考强度${compactEffort}`;

  return (
    <div
      ref={rootRef}
      className={`model-reasoning-picker${className ? ` ${className}` : ""}`}
      aria-busy={busy || undefined}
    >
      <button
        ref={triggerRef}
        type="button"
        className="model-picker__trigger"
        aria-label={`${triggerDescription}。打开模型与思考强度设置`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${baseId}-panel`}
        disabled={busy || unavailable}
        title={triggerDescription}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="model-picker__trigger-model">{compactModel}</span>
        <span className="model-picker__trigger-effort">{compactEffort}</span>
      </button>

      {open && activeModel && (
        <div
          ref={panelRef}
          id={`${baseId}-panel`}
          className="model-picker__popover"
          role="dialog"
          aria-labelledby={`${baseId}-title`}
        >
          <div className="model-picker__header">
            <div>
              <span className="model-picker__eyebrow">AI 设置</span>
              <h3 id={`${baseId}-title`}>模型与思考强度</h3>
            </div>
            <button
              type="button"
              className="model-picker__done"
              onClick={() => close(true)}
            >
              完成
            </button>
          </div>

          <section className="model-picker__section" aria-labelledby={`${baseId}-models-title`}>
            <h4 id={`${baseId}-models-title`}>模型</h4>
            <div className="model-picker__model-list" role="radiogroup" aria-labelledby={`${baseId}-models-title`}>
              {catalog.map((model) => {
                const selected = model.id === activeModel.id;
                const hasEfforts = model.supportedEfforts.length > 0;
                const descriptionId = `${baseId}-${model.id}-description`;
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="radio"
                    data-model-option
                    className={`model-picker__model${selected ? " model-picker__model--selected" : ""}`}
                    aria-checked={selected}
                    aria-describedby={model.description ? descriptionId : undefined}
                    disabled={busy || !hasEfforts}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => chooseModel(model)}
                    onKeyDown={(event) => handleRadioKeys(event, "[data-model-option]")}
                  >
                    <span className="model-picker__model-name">{model.displayName}</span>
                    {model.description && (
                      <span id={descriptionId} className="model-picker__model-description">
                        {model.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="model-picker__section" aria-labelledby={`${baseId}-efforts-title`}>
            <div className="model-picker__section-heading">
              <h4 id={`${baseId}-efforts-title`}>思考强度</h4>
              <span>{MODEL_LABELS[activeModel.id]}</span>
            </div>
            <div className="model-picker__effort-list" role="radiogroup" aria-labelledby={`${baseId}-efforts-title`}>
              {efforts.map((effort) => {
                const selected = effort === activeEffort;
                return (
                  <button
                    key={effort}
                    type="button"
                    role="radio"
                    data-effort-option
                    className={`model-picker__effort${selected ? " model-picker__effort--selected" : ""}`}
                    aria-checked={selected}
                    disabled={busy}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => chooseEffort(effort)}
                    onKeyDown={(event) => handleRadioKeys(event, "[data-effort-option]")}
                  >
                    <span>{effortLabel(effort)}</span>
                    <small>{effort}</small>
                  </button>
                );
              })}
            </div>
          </section>

          <p className="model-picker__hint">更改将在下一次提问时使用。</p>
        </div>
      )}
    </div>
  );
}
