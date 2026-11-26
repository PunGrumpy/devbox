"use client";

import { useEffect, useRef, useState } from "react";

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

const SWAP =
  "transition-[opacity,filter] duration-200 data-[shown=false]:opacity-0 data-[shown=false]:blur-[2px]";

interface CopyProps {
  text: string;
}

/** A command in a pill. Pressing it copies the command, and the action says so for a moment. */
export const CommandPill = ({ text }: CopyProps) => {
  const { copied, copy } = useCopied(text);

  return (
    <button
      aria-label={copied ? "Copied" : `Copy ${text}`}
      className="border-rule/60 hover:border-rule ease-press flex w-full cursor-copy items-center gap-4 rounded-[28px] border py-3 pr-6 pl-5 text-left transition-[border-color,background-color,transform] duration-150 hover:bg-white/25 active:scale-[0.99] dark:hover:bg-white/5"
      onClick={() => {
        void copy();
      }}
      type="button"
    >
      <code className="text-caption min-w-0 flex-1 truncate font-mono">
        <span aria-hidden="true" className="text-muted select-none">
          ${" "}
        </span>
        {text}
      </code>
      <span className="text-caption relative shrink-0">
        <span className={`gradient-text block ${SWAP}`} data-shown={!copied}>
          Copy
        </span>
        <span
          aria-hidden="true"
          className={`gradient-text absolute inset-y-0 right-0 ${SWAP}`}
          data-shown={copied}
        >
          Copied
        </span>
      </span>
    </button>
  );
};

/** A value that copies itself when pressed, such as a machine's address. */
export const CopyText = ({ text }: CopyProps) => {
  const { copied, copy } = useCopied(text);

  return (
    <button
      aria-label={copied ? "Copied" : `Copy ${text}`}
      className="decoration-rule hover:decoration-muted ease-press relative max-w-full cursor-copy text-left underline underline-offset-4 transition-[text-decoration-color,transform] duration-150 active:scale-[0.98]"
      onClick={() => {
        void copy();
      }}
      type="button"
    >
      <span className={`block truncate ${SWAP}`} data-shown={!copied}>
        {text}
      </span>
      <span
        aria-hidden="true"
        className={`gradient-text absolute inset-y-0 left-0 font-sans ${SWAP}`}
        data-shown={copied}
      >
        Copied
      </span>
    </button>
  );
};
