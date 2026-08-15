"use client";

import { useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { createTextDisplayBuffer } from "@/lib/agent-stream";

const markdownComponents: Components = {
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mb-3 mt-5 text-xl font-semibold tracking-tight text-slate-900 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-5 text-lg font-semibold tracking-tight text-slate-900 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold text-slate-900 first:mt-0">{children}</h3>,
  ul: ({ children }) => <ul className="mb-3 ml-5 list-disc space-y-1 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 ml-5 list-decimal space-y-1 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => <blockquote className="mb-3 border-l-2 border-[#a9bbef] pl-4 text-slate-500 last:mb-0">{children}</blockquote>,
  strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
  em: ({ children }) => <em className="text-slate-600">{children}</em>,
  a: ({ children, href }) => {
    const external = Boolean(href && /^(?:https?:)?\/\//i.test(href));
    return <a href={href} className="font-medium text-[#416fd8] underline decoration-[#aabdf4] underline-offset-2 hover:text-[#2f58be]" target={external ? "_blank" : undefined} rel={external ? "noreferrer noopener" : undefined}>{children}</a>;
  },
  code: ({ children, className }) => <code className={`${className ?? ""} rounded-md bg-slate-900/[.07] px-1.5 py-0.5 font-mono text-[.86em] text-slate-700`}>{children}</code>,
  pre: ({ children }) => <pre className="mb-3 max-w-full overflow-x-auto rounded-2xl bg-slate-900/[.06] p-4 font-mono text-[12px] leading-5 text-slate-700 last:mb-0">{children}</pre>,
  hr: () => <hr className="my-5 border-0 border-t border-slate-200/80" />,
  table: ({ children }) => <table className="min-w-full border-collapse text-left text-[13px]">{children}</table>,
  thead: ({ children }) => <thead className="border-b border-slate-200/80">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-slate-200/70">{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => <th className="px-3 py-2 font-semibold text-slate-800">{children}</th>,
  td: ({ children }) => <td className="px-3 py-2 align-top text-slate-600">{children}</td>,
};

export function AssistantMarkdown({ content, flush = false }: Readonly<{ content: string; flush?: boolean }>) {
  const [visibleContent, setVisibleContent] = useState(content);
  const bufferRef = useRef<ReturnType<typeof createTextDisplayBuffer> | null>(null);

  useEffect(() => {
    const buffer = bufferRef.current ?? createTextDisplayBuffer(setVisibleContent);
    bufferRef.current = buffer;
    buffer.push(content);
    if (flush) buffer.flush();
  }, [content, flush]);

  useEffect(() => () => {
    bufferRef.current?.cancel();
  }, []);

  const renderedContent = flush ? content : visibleContent;
  return <div className="assistant-markdown max-w-full overflow-x-auto leading-7 [&>table]:my-3"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>{renderedContent}</Markdown></div>;
}
