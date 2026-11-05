"use client";

import Markdown from "react-markdown";

/** What a model wrote. react-markdown builds elements and never runs raw HTML from the text. */
export function Reply({ children }: { children: string }) {
  return (
    <div className="flex flex-col gap-2 text-ui break-words [&_code]:rounded-sm [&_code]:bg-surface-2 [&_code]:px-1 [&_code]:font-mono [&_code]:text-ui-sm [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium [&_li]:ml-4 [&_ol]:flex [&_ol]:list-decimal [&_ol]:flex-col [&_ol]:gap-1 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface-2 [&_pre]:p-2 [&_strong]:font-medium [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-1">
      <Markdown
        components={{
          // Model text can hold any link, so none of them act like part of the page.
          a: ({ children: label, href }) => (
            <a href={href} rel="noreferrer noopener" target="_blank" className="underline">
              {label}
            </a>
          ),
          // Loading an image would tell its host someone read this, so it stays a link.
          img: ({ alt, src }) => (
            <a
              href={typeof src === "string" ? src : undefined}
              rel="noreferrer noopener"
              target="_blank"
              className="underline"
            >
              {alt || "Image"}
            </a>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
