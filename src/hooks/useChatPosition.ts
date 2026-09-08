import { useCallback, useLayoutEffect, useRef } from "react";
import type { ChatMessage, ChatPosition } from "../types";

const blocks = (message: Element) => [...message.querySelectorAll<HTMLElement>(".markdown-body > *, .message__content")];

export default function useChatPosition(messages: ChatMessage[], initial: ChatPosition | undefined, onChange: (value: ChatPosition) => void) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<ChatPosition>(initial ?? { block: 0, offset: 0, followOutput: true });
  const changeRef = useRef(onChange);
  const restoring = useRef(false);
  const frameRef = useRef(0);
  changeRef.current = onChange;

  const remember = useCallback(() => {
    const node = scrollRef.current;
    if (!node || !node.clientHeight || restoring.current) return;
    const line = node.getBoundingClientRect().top + 8;
    const articles = [...node.querySelectorAll<HTMLElement>("[data-message-id]")];
    const article = articles.find((item) => item.getBoundingClientRect().bottom > line);
    const children = article ? blocks(article) : [];
    const index = Math.max(0, children.findIndex((item) => item.getBoundingClientRect().bottom > line));
    const rect = (children[index] ?? article)?.getBoundingClientRect();
    const next = {
      messageId: article?.dataset.messageId, block: index,
      offset: rect?.height ? Math.max(0, Math.min(1, (line - rect.top) / rect.height)) : 0,
      followOutput: node.scrollHeight - node.scrollTop - node.clientHeight < 84,
    };
    const previous = positionRef.current;
    positionRef.current = next;
    if (previous.messageId !== next.messageId || previous.block !== next.block || previous.followOutput !== next.followOutput || Math.abs(previous.offset - next.offset) > .001) changeRef.current(next);
  }, []);

  const restore = useCallback(() => {
    const node = scrollRef.current;
    if (!node || !node.clientHeight) return;
    restoring.current = true;
    const position = positionRef.current;
    if (position.followOutput) node.scrollTop = node.scrollHeight;
    else {
      const article = [...node.querySelectorAll<HTMLElement>("[data-message-id]")].find((item) => item.dataset.messageId === position.messageId);
      if (article) {
        const children = blocks(article);
        const target = children[Math.min(position.block, children.length - 1)] ?? article;
        const rect = target.getBoundingClientRect();
        node.scrollTop += rect.top - node.getBoundingClientRect().top + rect.height * position.offset - 8;
      }
    }
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => { restoring.current = false; });
  }, []);

  useLayoutEffect(restore, [messages, restore]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(restore);
    if (itemsRef.current) observer.observe(itemsRef.current);
    if (scrollRef.current) observer.observe(scrollRef.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frameRef.current); };
  }, [restore]);

  const goToMessage = (messageId: string) => {
    positionRef.current = { messageId, block: 0, offset: 0, followOutput: false };
    changeRef.current(positionRef.current);
    restore();
  };
  const scrollToLatest = () => {
    positionRef.current = { ...positionRef.current, followOutput: true };
    changeRef.current(positionRef.current);
    restore();
  };
  return { scrollRef, itemsRef, positionRef, remember, goToMessage, scrollToLatest };
}
