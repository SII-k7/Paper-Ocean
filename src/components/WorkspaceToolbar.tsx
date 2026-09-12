import { useEffect, useRef, type ReactNode } from "react";
import { BookOpen, Columns2, Compass, Library, Moon, NotebookPen, Plus, Settings2, Sun } from "lucide-react";
import AboutPanel from "./AboutPanel";
import AppearanceSettings from "./AppearanceSettings";
import paperOceanMark from "../assets/paper-ocean-mark.png";
import { READING_FONT_SIZES, type WorkspaceMode } from "../workspace-state.mjs";

type Props = {
  search: ReactNode; mode: WorkspaceMode; fontSize: number; theme: "dark" | "light";
  ready: boolean; opening: boolean; busy: boolean; libraryOpen: boolean; notesOpen: boolean;
  onMode(mode: WorkspaceMode): void; onFontSize(size: number): void; onTheme(): void;
  onLibrary(): void; onNotes(): void; onOpen(): void; onLocateCodex(): void;
};
const layouts = [{ id: "read", title: "专注阅读", icon: BookOpen }, { id: "discuss", title: "并排讨论", icon: Columns2 }, { id: "explore", title: "论文探索", icon: Compass }] as const;

export default function WorkspaceToolbar(props: Props) {
  const toolbar = useRef<HTMLElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      toolbar.current?.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(menu => {
        if (!menu.contains(event.target as Node)) menu.open = false;
      });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
      const menu = Array.from(toolbar.current?.querySelectorAll<HTMLDetailsElement>("details[open]") ?? []).at(-1);
      if (menu) { event.preventDefault(); menu.open = false; menu.querySelector("summary")?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);
  return <header className="app-header workspace-toolbar" ref={toolbar}>
    <div className="brand"><img className="brand-mark" src={paperOceanMark} alt="" aria-hidden="true" /><strong>Paper Ocean</strong></div>
    {props.search}
    <div className="header-actions">
      <button type="button" className="settings-button" aria-label={props.libraryOpen ? "关闭资料库" : "打开资料库"} aria-expanded={props.libraryOpen} onClick={props.onLibrary} disabled={!props.ready} title="资料库"><Library size={18} /></button>
      <button type="button" className="settings-button" aria-label="研究笔记" aria-pressed={props.notesOpen} onClick={props.onNotes} disabled={!props.ready} title="研究笔记"><NotebookPen size={18} /></button>
      <details className="workspace-menu workspace-layout-menu">
        <summary className="settings-button" aria-label="阅读布局" title="阅读布局"><Columns2 size={18} /></summary>
        <div className="workspace-menu__panel" role="group" aria-label="阅读布局设置">
          <span className="workspace-menu__eyebrow">工作台</span>
          {layouts.map(({id, title, icon: Icon}) => <button type="button" key={id} aria-pressed={props.mode === id} onClick={event => { props.onMode(id); const menu = event.currentTarget.closest("details")!; menu.open = false; menu.querySelector("summary")?.focus(); }}><Icon size={17} /><span>{title}</span><span className="workspace-menu__check">{props.mode === id ? "✓" : ""}</span></button>)}
          <label className="workspace-menu__font">对话文字<select aria-label="对话文字大小" value={props.fontSize} onChange={event => props.onFontSize(Number(event.target.value))}>{READING_FONT_SIZES.map(size => <option value={size} key={size}>{size} px</option>)}</select></label>
        </div>
      </details>
      <button type="button" className="settings-button theme-toggle" onClick={props.onTheme} aria-label={props.theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} title="切换主题">{props.theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}</button>
      <details className="workspace-menu workspace-settings-menu">
        <summary className="settings-button" aria-label="应用设置" title="应用设置"><Settings2 size={18} /></summary>
        <div className="workspace-menu__panel" role="group" aria-label="应用设置选项">
          <span className="workspace-menu__eyebrow">偏好与更新</span>
          <div className="workspace-settings-row"><span>界面效果</span><AppearanceSettings /></div>
          <div className="workspace-settings-row"><span>关于与更新</span><AboutPanel /></div>
          {window.paperOcean.runtime !== "web" && <button type="button" onClick={props.onLocateCodex} disabled={props.busy} aria-label="定位 Codex CLI">重新连接 Codex</button>}
        </div>
      </details>
      <span className="workspace-toolbar__divider" />
      <button type="button" className="open-button" onClick={props.onOpen} disabled={props.opening || !props.ready}><Plus size={17} /><span>{props.opening ? "正在打开…" : "本地 PDF"}</span></button>
    </div>
  </header>;
}
