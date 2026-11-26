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

const SWAP =
  "transition-[opacity,filter] duration-200 data-[shown=false]:opacity-0 data-[shown=false]:blur-[2px]";

interface CopyProps {
  text: string;
}

/** The round button beside a command. Its icon turns into a check for a moment. */
export const CopyButton = ({ text }: CopyProps) => {
  const { copied, copy } = useCopied(text);

  return (
    <button
      aria-label={copied ? "Copied" : `Copy ${text}`}
      className="text-soft hover:text-ink ease-press relative grid size-7 shrink-0 cursor-pointer place-items-center rounded-full transition-[color,transform] duration-150 active:scale-[0.94]"
      onClick={() => {
        void copy();
      }}
      type="button"
    >
      <CopyIcon className={SWAP} data-shown={!copied} />
      <CheckIcon
        className={`text-accent absolute ${SWAP}`}
        data-shown={copied}
      />
    </button>
  );
};

/** A value that copies itself when pressed, such as a machine's address. */
export const CopyText = ({ text }: CopyProps) => {
  const { copied, copy } = useCopied(text);

  return (
    <button
      aria-label={copied ? "Copied" : `Copy ${text}`}
      className="text-detail hover:bg-wash ease-press relative -mx-1.5 block max-w-[calc(100%+0.75rem)] cursor-copy rounded-md px-1.5 py-0.5 text-left font-mono transition-[background-color,transform] duration-150 active:scale-[0.98]"
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
        className={`text-accent absolute inset-y-0 left-1.5 flex items-center font-sans ${SWAP}`}
        data-shown={copied}
      >
        Copied
      </span>
    </button>
  );
};
