"use client";

import { useEffect, useId, useRef, useState } from "react";

import { HubLogo } from "@/components/icons";
import { requestLogin } from "@/lib/auth";
import { refresh } from "@/lib/store";

type FormState =
  | { readonly phase: "idle" }
  | { readonly phase: "submitting" }
  | { readonly message: string; readonly phase: "error" };

export const LoginGate = () => {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [form, setForm] = useState<FormState>({ phase: "idle" });

  useEffect(() => {
    input.current?.focus();
  }, []);

  const handleSubmit = async () => {
    const trimmed = value.trim();

    if (trimmed === "") {
      input.current?.focus();

      return;
    }

    setForm({ phase: "submitting" });
    setValue("");

    const outcome = await requestLogin(trimmed);

    if (!outcome.ok) {
      setForm({ message: outcome.message, phase: "error" });
      input.current?.focus();

      return;
    }

    const next = await refresh();

    if (next.status === "signed-out") {
      setForm({
        message:
          "The hub did not keep the session. Check that cookies are enabled.",
        phase: "error",
      });
      input.current?.focus();
    }
  };

  const submitting = form.phase === "submitting";

  return (
    <main className="mx-auto flex min-h-screen max-w-[26rem] flex-col justify-center px-6 py-16">
      <HubLogo className="size-12" />
      <form
        className="mt-6 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <p className="text-nav text-soft">
          Print the token on the hub machine with{" "}
          <code className="text-ink font-mono text-[0.875em] whitespace-nowrap">
            devbox hub token
          </code>
          .
        </p>
        {form.phase === "error" ? (
          <p aria-live="polite" className="text-nav text-ink" role="alert">
            {form.message}
          </p>
        ) : null}
        <label className="sr-only" htmlFor={inputId}>
          Hub token
        </label>
        <input
          autoComplete="off"
          className="edge text-nav text-ink placeholder:text-muted caret-accent rounded-panel w-full px-3 py-2 font-mono [--fill:var(--surface)]"
          id={inputId}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          placeholder="Paste token"
          readOnly={submitting}
          ref={input}
          spellCheck={false}
          type="password"
          value={value}
        />
        <div className="flex justify-end">
          <button
            className="bg-ink text-nav text-paper cursor-pointer rounded-full px-4 py-1.5 transition-opacity duration-100 hover:opacity-80 disabled:cursor-default disabled:opacity-40"
            disabled={submitting || value.trim() === ""}
            type="submit"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </main>
  );
};
