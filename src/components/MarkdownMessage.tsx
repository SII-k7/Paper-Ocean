import { memo } from "react";
import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { normalizePaperMarkdown } from "../paper-markdown.mjs";

type Props = {
  text: string;
};

function MarkdownMessage({ text }: Props) {
  return (
    <div className="markdown-body">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
        components={{
          a: ({ href, children }) => {
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
