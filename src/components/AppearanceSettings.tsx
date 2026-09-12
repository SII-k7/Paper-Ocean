import { useEffect, useRef, useState } from "react";
import { Blend } from "lucide-react";

function saved(key: string, fallback: boolean) {
  try { const value = localStorage.getItem(key); return value === null ? fallback : value === "true"; } catch { return fallback; }
}

export default function AppearanceSettings() {
  const [glass, setGlass] = useState(() => saved("paper-ocean-glass", true));
  const [reduceMotion, setReduceMotion] = useState(() => saved("paper-ocean-reduce-motion", false));
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const systemMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const systemTransparency = matchMedia("(prefers-reduced-transparency: reduce)");
    const apply = () => {
      document.documentElement.dataset.material = glass && !systemTransparency.matches ? "glass" : "solid";
      document.documentElement.dataset.motion = reduceMotion || systemMotion.matches ? "reduced" : "full";
    };
    apply();
    systemMotion.addEventListener("change", apply);
    systemTransparency.addEventListener("change", apply);
    try {
      localStorage.setItem("paper-ocean-glass", String(glass));
      localStorage.setItem("paper-ocean-reduce-motion", String(reduceMotion));
    } catch { /* The controls still work for this session. */ }
    return () => { systemMotion.removeEventListener("change", apply); systemTransparency.removeEventListener("change", apply); };
  }, [glass, reduceMotion]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false; };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.current?.open) { menu.current.open = false; menu.current.querySelector("summary")?.focus(); event.stopPropagation(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);
  return <details className="appearance-settings" ref={menu}>
    <summary className="settings-button" aria-label="界面效果" title="界面效果"><Blend size={17} aria-hidden="true" /></summary>
    <div className="appearance-settings__panel" role="group" aria-label="界面效果设置">
      <strong>界面效果</strong>
      <label><span>玻璃质感<small>工具栏和浮窗透出背景</small></span><input type="checkbox" role="switch" aria-label="玻璃质感" checked={glass} onChange={event => setGlass(event.target.checked)} /></label>
      <label><span>减少动态效果<small>保留状态反馈，简化过渡</small></span><input type="checkbox" role="switch" aria-label="减少动态效果" checked={reduceMotion} onChange={event => setReduceMotion(event.target.checked)} /></label>
      <p>也会遵循系统的减少动态效果与透明度设置。</p>
    </div>
  </details>;
}
