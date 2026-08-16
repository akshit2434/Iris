"use client";

import { useEffect, useRef, useState } from "react";
import { Streamdown, type Components } from "streamdown";
import { createTextRevealScheduler, type TextRevealScheduler } from "@/lib/text-reveal";

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

function useReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reducedMotion;
}

export function AssistantMarkdown({ content, live, terminal, onRevealComplete }: Readonly<{
  content: string;
  live: boolean;
  terminal: boolean;
  onRevealComplete?: () => void;
}>) {
  const reducedMotion = useReducedMotion();
  const startedRef = useRef(live);
  const onCompleteRef = useRef(onRevealComplete);
  const [visibleContent, setVisibleContent] = useState(() => live ? "" : content);
  const [presenting, setPresenting] = useState(live);
  const schedulerRef = useRef<TextRevealScheduler | null>(null);

  useEffect(() => {
    onCompleteRef.current = onRevealComplete;
  }, [onRevealComplete]);

  useEffect(() => {
    const scheduler = createTextRevealScheduler({
      onReveal: (text) => setVisibleContent(text),
      onComplete: () => {
        setPresenting(false);
        onCompleteRef.current?.();
      },
    });
    schedulerRef.current = scheduler;
    return () => scheduler.cancel();
  }, []);

  useEffect(() => {
    schedulerRef.current?.setImmediate(reducedMotion);
  }, [reducedMotion]);

  useEffect(() => {
    const scheduler = schedulerRef.current;
    if (!scheduler) return;
    if (live) {
      startedRef.current = true;
      setPresenting(true);
      scheduler.push(content);
      if (terminal) scheduler.end();
      return;
    }
    if (startedRef.current) {
      scheduler.push(content);
      scheduler.end();
      return;
    }
    setVisibleContent(content);
    setPresenting(false);
    onCompleteRef.current?.();
  }, [content, live, terminal]);

  return <div className={`assistant-markdown max-w-full overflow-x-auto leading-7 [&>table]:my-3 ${presenting && !reducedMotion ? "assistant-markdown--revealing" : ""}`}>
    <Streamdown
      mode={presenting && !reducedMotion ? "streaming" : "static"}
      isAnimating={presenting && !reducedMotion}
      animated={reducedMotion ? false : { animation: "blurIn", duration: 180, sep: "word", stagger: 0 }}
      parseIncompleteMarkdown
      skipHtml
      controls={false}
      lineNumbers={false}
      components={markdownComponents}
    >
      {visibleContent}
    </Streamdown>
  </div>;
}
