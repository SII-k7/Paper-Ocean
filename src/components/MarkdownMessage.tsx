import { memo } from "react";
import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { normalizePaperMarkdown } from "../paper-markdown.mjs";

type Props = {
  text: string;
  onOpenEvidence?(paperId: string, page: number): void;
};

function MarkdownMessage({ text, onOpenEvidence }: Props) {
  return (
    <div className="markdown-body">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
        components={{
          a: ({ href, children }) => {
            const evidence = href?.match(/^#paper=([a-f0-9]{24})&page=([1-9]\d{0,3})$/);
            if (evidence && onOpenEvidence) return <button type="button" className="evidence-link" onClick={() => onOpenEvidence(evidence[1], Number(evidence[2]))}>{children} ↗</button>;
            const safeUrl = href && /^https:\/\//i.test(href) ? href : null;
            if (!safeUrl) return <span className="markdown-body__unsafe-link">{children}</span>;

            return (
              <a
                href={safeUrl}
                onClick={(event) => {
                  event.preventDefault();
                  void window.paperOcean.openExternal(safeUrl);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {normalizePaperMarkdown(text)}
      </Markdown>
    </div>
  );
}

export default memo(MarkdownMessage);
