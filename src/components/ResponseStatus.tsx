import { useEffect, useState } from "react";
import type { ChatMessage } from "../types";

export default function ResponseStatus({ message }: { message: ChatMessage }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!message.pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [message.pending]);
  if (!message.responsePhase) return null;
  const seconds = (end: number, start: number) => `${Math.max(0, (end - start) / 1000).toFixed(1)} 秒`;
  return <small className="context-coverage response-status" role="status">
    {message.serviceTier ? "Fast · " : ""}
    {message.pending ? `${message.responsePhase} · ${seconds(now, message.createdAt)}`
      : message.firstTextAt ? `首字 ${seconds(message.firstTextAt, message.createdAt)}${message.finishedAt ? ` · 总耗时 ${seconds(message.finishedAt, message.createdAt)}` : ""}`
      : message.interrupted ? "已停止" : message.error ? "未完成" : "已完成"}
  </small>;
}
