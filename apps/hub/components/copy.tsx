"use client";

import { useEffect, useRef, useState } from "react";

import { CopyIcon } from "@/components/icons";
import { copyText } from "@/lib/clipboard";
import { shellTokens } from "@/lib/shell";
import type { TokenKind } from "@/lib/shell";

const COPIED_MS = 1500;

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

const TOKEN_CLASS = {
  function: "text-code-function",
  operator: "text-code-operator",
  plain: "",
  property: "text-code-property",
} satisfies Record<TokenKind, string>;

interface CopyProps {
  text: string;
}

/**
 * A shell command as the Rex docs set a code block: a panel, the program and its flags in
 * colour, and a round button that turns into a tick for a moment once the command is copied.
 */
export const CodeBlock = ({ text }: CopyProps) => {
  const { copied, copy } = useCopied(text);

  return (
    <div className="relative mt-4">
      <pre className="edge squircle rounded-panel overflow-x-auto px-[calc(1rem-1px)] py-[calc(0.625rem-1px)]">
        <code className="font-mono text-[0.875em]">
          {shellTokens(text).map(({ at, kind, text: piece }) => (
            <span className={TOKEN_CLASS[kind]} key={at}>
              {piece}
            </span>
          ))}
        </code>
      </pre>
      <button
        aria-label={copied ? "Copied" : "Copy code"}
        className="bg-surface text-muted hover:text-ink focus-visible:text-ink absolute top-1.5 right-1.5 grid size-7 cursor-pointer place-items-center rounded-full transition-colors duration-100"
        onClick={() => {
          void copy();
        }}
        type="button"
      >
        <CopyIcon className="size-4" copied={copied} />
      </button>
    </div>
  );
};

/** A value that copies itself when pressed, drawn as the docs draw a link in the text. */
export const CopyLink = ({ text }: CopyProps) => {
  const { copied, copy } = useCopied(text);

  return (
    <button
      aria-label={copied ? "Copied" : `Copy ${text}`}
      className="text-ink decoration-muted cursor-copy underline underline-offset-[0.2em] transition-[text-decoration-color] duration-100 hover:decoration-current"
      onClick={() => {
        void copy();
      }}
      type="button"
    >
      {copied ? "Copied" : text}
    </button>
  );
};
