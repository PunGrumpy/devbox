"use client";

import { useEffect, useRef, useState } from "react";

import { CheckIcon, CopyIcon } from "@/components/icons";
import { copyText } from "@/lib/clipboard";

const COPIED_MS = 1600;

const useCopied = (text: string) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    []
  );

  const copy = async () => {
    await copyText(text);
    clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => {
      setCopied(false);
    }, COPIED_MS);
  };

  return { copied, copy };
};

interface CopyProps {
  text: string;
}

/** A command in a panel, with the round copy button the Rex docs put on a code block. */
export const CodeBlock = ({ text }: CopyProps) => {
  const { copied, copy } = useCopied(text);

  return (
    <div className="relative mt-4">
      <pre className="edge squircle rounded-panel overflow-x-auto py-[calc(0.625rem-1px)] pr-11 pl-[calc(1rem-1px)]">
        <code className="font-mono text-[0.8125rem]">{text}</code>
      </pre>
      <button
        aria-label={copied ? "Copied" : `Copy ${text}`}
        className="bg-surface text-muted hover:text-ink absolute top-1.5 right-1.5 grid size-7 cursor-pointer place-items-center rounded-full transition-colors duration-100"
        onClick={() => {
          void copy();
        }}
        type="button"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
};

/** A value that copies itself when pressed, drawn as a link in the text. */
export const CopyLink = ({ text }: CopyProps) => {
  const { copied, copy } = useCopied(text);

  return (
    <button
      aria-label={copied ? "Copied" : `Copy ${text}`}
      className="text-ink decoration-rule cursor-copy underline underline-offset-[3px] transition-[text-decoration-color] duration-100 hover:decoration-current"
      onClick={() => {
        void copy();
      }}
      type="button"
    >
      {copied ? "Copied" : text}
    </button>
  );
};
