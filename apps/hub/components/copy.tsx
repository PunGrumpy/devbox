"use client";

import { useEffect, useRef, useState } from "react";

import { copyText } from "@/lib/clipboard";

const COPIED_MS = 1500;

export const useCopied = (text: string) => {
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
