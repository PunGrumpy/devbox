"use client";

import { useEffect, useRef, useState } from "react";

import { CopyLink, useCopied } from "@/components/copy";
import { CloseIcon } from "@/components/icons";
import { HUB_ACTIONS, requestAction, trustCommand } from "@/lib/actions";
import type { MachineAction, MachineActionState } from "@/lib/actions";
import { markSignedOut } from "@/lib/store";

/**
 * Holds the active action state for one machine card: ask, maybe confirm, send, and report.
 * Any timed result (such as a pairing link) is cleared on dismiss, unmount, or when its TTL ends.
 */
export const useMachineAction = (name: string) => {
  const [state, setState] = useState<MachineActionState | null>(null);
  const active = useRef(true);
  const requestId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    active.current = true;

    return () => {
      active.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const send = async (action: MachineAction) => {
    clearTimeout(timer.current);
    requestId.current += 1;
    const turn = requestId.current;
    setState({ action, phase: "sending" });

    const outcome = await requestAction(action, name);

    if (!active.current || turn !== requestId.current) {
      return;
    }

    if (outcome.signedOut) {
      setState(null);
      markSignedOut();

      return;
    }

    setState({
      action,
      message: outcome.message,
      ok: outcome.ok,
      phase: "done",
      url: outcome.url,
    });

    const { ttlMs } = HUB_ACTIONS[action];

    if (outcome.ok && ttlMs !== null) {
      timer.current = setTimeout(() => {
        setState(null);
      }, ttlMs);
    }
  };

  const handleTrigger = (action: MachineAction) => {
    clearTimeout(timer.current);

    if (HUB_ACTIONS[action].confirm === null) {
      void send(action);

      return;
    }

    setState({ action, phase: "confirming" });
  };

  const handleCancel = () => {
    clearTimeout(timer.current);
    requestId.current += 1;
    setState(null);
  };

  const handleConfirm = () => {
    if (state?.phase === "confirming") {
      void send(state.action);
    }
  };

  return {
    handleCancel,
    handleConfirm,
    handleTrigger,
    state,
  };
};

interface ActionButtonProps {
  action: MachineAction;
  onTrigger: (action: MachineAction) => void;
  state: MachineActionState | null;
}

/** One quiet pill button for any machine action. */
export const ActionButton = ({
  action,
  onTrigger,
  state,
}: ActionButtonProps) => {
  const spec = HUB_ACTIONS[action];
  const confirming = state?.phase === "confirming" && state.action === action;
  const sending = state?.phase === "sending" && state.action === action;
  const disabled = confirming || state?.phase === "sending";

  return (
    <button
      aria-expanded={spec.confirm === null ? undefined : confirming}
      className="edge text-nav text-soft hover:text-ink shrink-0 cursor-pointer rounded-full px-3.5 py-1.5 transition-colors duration-100 [--fill:var(--paper)] disabled:cursor-default disabled:opacity-50"
      disabled={disabled}
      onClick={() => {
        onTrigger(action);
      }}
      type="button"
    >
      {sending ? spec.busyLabel : spec.label}
    </button>
  );
};

interface ActionConfirmProps {
  confirmLabel: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/** The shared in-card confirmation row used by every action that asks before running. */
export const ActionConfirm = ({
  confirmLabel,
  message,
  onCancel,
  onConfirm,
}: ActionConfirmProps) => (
  <div className="border-rule mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
    <p className="text-nav text-soft min-w-0 flex-[1_1_14rem]">{message}</p>
    <div className="flex shrink-0 items-center gap-2">
      <button
        className="edge text-nav text-soft hover:text-ink cursor-pointer rounded-full px-3.5 py-1 transition-colors duration-100 [--fill:var(--paper)]"
        onClick={onCancel}
        type="button"
      >
        Cancel
      </button>
      <button
        className="bg-ink text-nav text-paper cursor-pointer rounded-full px-3.5 py-1 transition-opacity duration-100 hover:opacity-80"
        onClick={onConfirm}
        type="button"
      >
        {confirmLabel}
      </button>
    </div>
  </div>
);

interface LinkResultBarProps {
  message: string;
  onDismiss: () => void;
  url: string;
}

const LinkResultBar = ({ message, onDismiss, url }: LinkResultBarProps) => {
  const { copied, copy } = useCopied(url);

  return (
    <div
      aria-live="polite"
      className="border-rule mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-3"
    >
      <p className="text-nav text-soft min-w-0 flex-[1_1_12rem]">{message}</p>
      <div className="flex shrink-0 items-center gap-2">
        <a
          className="bg-ink text-nav text-paper rounded-full px-3.5 py-1 transition-opacity duration-100 hover:opacity-80"
          href={url}
          rel="noreferrer"
          target="_blank"
        >
          Open
        </a>
        <button
          aria-label={copied ? "Copied" : "Copy pairing link"}
          className="edge text-nav text-soft hover:text-ink cursor-pointer rounded-full px-3.5 py-1 transition-colors duration-100 [--fill:var(--paper)]"
          onClick={() => {
            void copy();
          }}
          type="button"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          aria-label="Close pairing link"
          className="text-muted hover:text-ink grid size-7 cursor-pointer place-items-center rounded-full transition-colors duration-100"
          onClick={onDismiss}
          type="button"
        >
          <CloseIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
};

interface ActionResultProps {
  name: string;
  onDismiss: () => void;
  state: Exclude<MachineActionState, { readonly phase: "confirming" }>;
}

/** The shared in-card status and result line for sending, done, and error outcomes. */
export const ActionResult = ({ name, onDismiss, state }: ActionResultProps) => {
  if (state.phase === "sending") {
    return (
      <p
        aria-live="polite"
        className="border-rule text-nav text-muted mt-4 border-t pt-3"
      >
        {HUB_ACTIONS[state.action].sending(name)}
      </p>
    );
  }

  if (state.ok && state.url !== null) {
    return (
      <LinkResultBar
        key={state.url}
        message={state.message}
        onDismiss={onDismiss}
        url={state.url}
      />
    );
  }

  return (
    <p
      aria-live="polite"
      className={`border-rule text-nav mt-4 border-t pt-3 ${state.ok ? "text-soft" : "text-ink"}`}
    >
      {state.message}
    </p>
  );
};

interface ActionNoticeProps {
  eligible: readonly MachineAction[];
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
  state: MachineActionState | null;
  zone: string | null;
}

/** Renders the active confirmation row or result line inside a machine card. */
export const ActionNotice = ({
  eligible,
  name,
  onCancel,
  onConfirm,
  state,
  zone,
}: ActionNoticeProps) => {
  if (state === null || !eligible.includes(state.action)) {
    return null;
  }

  if (state.phase === "confirming") {
    const spec = HUB_ACTIONS[state.action];

    if (spec.confirm === null) {
      return null;
    }

    return (
      <ActionConfirm
        confirmLabel={spec.label}
        message={spec.confirm(name, zone)}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    );
  }

  return <ActionResult name={name} onDismiss={onCancel} state={state} />;
};

interface UntrustedNoteProps {
  hubKey: string | null;
  name: string;
  show: boolean;
}

/** Sentence with the copyable trust command for an outdated machine whose spoke does not trust the hub. */
export const UntrustedNote = ({ hubKey, name, show }: UntrustedNoteProps) => {
  if (!show || hubKey === null || hubKey === "") {
    return null;
  }

  return (
    <>
      {" "}
      Run{" "}
      <span className="[&_button]:inline [&_button]:text-left [&_button]:break-all">
        <CopyLink text={trustCommand(hubKey)} />
      </span>{" "}
      on {name} to update it from here.
    </>
  );
};
