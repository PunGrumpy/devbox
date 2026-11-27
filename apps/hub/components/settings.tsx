"use client";

import { useId, useRef, useState } from "react";

import { ActionConfirm } from "@/components/actions";
import { CommandTabs } from "@/components/command";
import {
  connectedSentence,
  HUB_ACTIONS,
  requestAction,
  requestConnect,
  spokeCommand,
  withoutSpoke,
} from "@/lib/actions";
import type { ActionOutcome, ConnectRequest, Named } from "@/lib/actions";
import type { Cloudflare, Machine } from "@/lib/machines";
import { markSignedOut, refresh } from "@/lib/store";

interface Notice {
  readonly message: string;
  readonly ok: boolean;
}

const QUIET_BUTTON =
  "edge text-nav text-soft hover:text-ink shrink-0 cursor-pointer rounded-full px-3.5 py-1.5 transition-colors duration-100 [--fill:var(--paper)] disabled:cursor-default disabled:opacity-50";

const FIELD =
  "edge text-nav text-ink rounded-panel w-full px-3 py-2 [--fill:var(--surface)]";

const settle = async (
  outcome: ActionOutcome,
  onNotice: (notice: Notice | null) => void,
  sayDone: boolean
) => {
  if (outcome.signedOut) {
    markSignedOut();

    return;
  }

  if (!outcome.ok || sayDone) {
    onNotice({ message: outcome.message, ok: outcome.ok });
  }

  if (outcome.ok) {
    await refresh();
  }
};

interface PickProps {
  label: string;
  onChange: (value: string) => void;
  options: readonly Named[];
  value: string;
  optionValue: (option: Named) => string;
}

const Pick = ({ label, onChange, options, value, optionValue }: PickProps) => {
  const id = useId();

  return (
    <div className="flex flex-col gap-2">
      <label className="text-nav text-soft" htmlFor={id}>
        {label}
      </label>
      <select
        className={`${FIELD} cursor-pointer`}
        id={id}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        value={value}
      >
        {options.map((option) => (
          <option key={option.id} value={optionValue(option)}>
            {option.name}
          </option>
        ))}
      </select>
    </div>
  );
};

const idOf = (option: Named) => option.id;
const nameOf = (option: Named) => option.name;

interface ConnectFormProps {
  onNotice: (notice: Notice | null) => void;
}

const ConnectForm = ({ onNotice }: ConnectFormProps) => {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [phase, setPhase] = useState<"idle" | "sending">("idle");
  const [accounts, setAccounts] = useState<readonly Named[] | null>(null);
  const [account, setAccount] = useState("");
  const [zones, setZones] = useState<readonly Named[] | null>(null);
  const [zone, setZone] = useState("");

  const handleSubmit = async () => {
    const token = value.trim();

    if (token === "") {
      input.current?.focus();

      return;
    }

    const connect: ConnectRequest = { token };

    if (accounts !== null) {
      connect.account = account;
    }

    if (zones !== null) {
      connect.zone = zone;
    }

    setValue("");
    setPhase("sending");
    onNotice(null);

    const outcome = await requestConnect(connect);

    setPhase("idle");

    if (outcome.choices?.what === "account") {
      setAccounts(outcome.choices.options);
      setAccount(outcome.choices.options[0]?.id ?? "");
      setZones(null);
    } else if (outcome.choices?.what === "zone") {
      setZones(outcome.choices.options);
      setZone(outcome.choices.options[0]?.name ?? "");
    }

    if (!outcome.ok) {
      input.current?.focus();
    }

    await settle(outcome, onNotice, false);
  };

  const sending = phase === "sending";

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <p className="text-nav text-soft">
        The hub publishes a machine on the internet through a Cloudflare Tunnel.
        Make an API token with Cloudflare Tunnel Edit, DNS Edit and Zone WAF
        Edit, for one zone.
      </p>
      {accounts === null ? null : (
        <Pick
          label="Account"
          onChange={setAccount}
          options={accounts}
          value={account}
          optionValue={idOf}
        />
      )}
      {zones === null ? null : (
        <Pick
          label="Zone"
          onChange={setZone}
          options={zones}
          value={zone}
          optionValue={nameOf}
        />
      )}
      <label className="sr-only" htmlFor={inputId}>
        Cloudflare API token
      </label>
      <input
        autoComplete="off"
        className={`${FIELD} placeholder:text-muted caret-accent font-mono`}
        id={inputId}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        placeholder="Paste API token"
        readOnly={sending}
        ref={input}
        spellCheck={false}
        type="password"
        value={value}
      />
      <div className="flex items-center justify-end gap-3">
        {sending ? (
          <p aria-live="polite" className="text-nav text-muted mr-auto">
            {HUB_ACTIONS.connect.sending()}
          </p>
        ) : null}
        <button
          className="bg-ink text-nav text-paper cursor-pointer rounded-full px-4 py-1.5 transition-opacity duration-100 hover:opacity-80 disabled:cursor-default disabled:opacity-40"
          disabled={sending || value.trim() === ""}
          type="submit"
        >
          {sending ? HUB_ACTIONS.connect.busyLabel : HUB_ACTIONS.connect.label}
        </button>
      </div>
    </form>
  );
};

interface ConnectedProps {
  cloudflare: Cloudflare;
  onNotice: (notice: Notice | null) => void;
}

type DisconnectPhase = "confirming" | "idle" | "sending";

const Connected = ({ cloudflare, onNotice }: ConnectedProps) => {
  const [phase, setPhase] = useState<DisconnectPhase>("idle");
  const spec = HUB_ACTIONS.disconnect;

  const handleConfirm = async () => {
    setPhase("sending");
    onNotice(null);

    const outcome = await requestAction("disconnect", "");

    setPhase("idle");
    await settle(outcome, onNotice, true);
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-nav text-soft min-w-0 flex-[1_1_14rem]">
          {connectedSentence(cloudflare)}
        </p>
        <button
          aria-expanded={phase === "confirming"}
          className={QUIET_BUTTON}
          disabled={phase !== "idle"}
          onClick={() => {
            onNotice(null);
            setPhase("confirming");
          }}
          type="button"
        >
          {phase === "sending" ? spec.busyLabel : spec.label}
        </button>
      </div>
      {phase === "confirming" ? (
        <ActionConfirm
          confirmLabel={spec.label}
          message={spec.confirm()}
          onCancel={() => {
            setPhase("idle");
          }}
          onConfirm={() => {
            void handleConfirm();
          }}
        />
      ) : null}
      {phase === "sending" ? (
        <p
          aria-live="polite"
          className="border-rule text-nav text-muted mt-4 border-t pt-3"
        >
          {spec.sending()}
        </p>
      ) : null}
    </>
  );
};

const CloudflareSettings = ({
  cloudflare,
}: {
  cloudflare: Cloudflare | null;
}) => {
  const [notice, setNotice] = useState<Notice | null>(null);

  return (
    <>
      <h3 className="pt-10" id="cloudflare">
        Cloudflare
      </h3>
      <div className="edge squircle rounded-card mt-4 p-4">
        {cloudflare === null ? (
          <ConnectForm onNotice={setNotice} />
        ) : (
          <Connected cloudflare={cloudflare} onNotice={setNotice} />
        )}
        {notice === null ? null : (
          <p
            aria-live="polite"
            className={`border-rule text-nav mt-4 border-t pt-3 ${notice.ok ? "text-soft" : "text-ink"}`}
            role={notice.ok ? undefined : "alert"}
          >
            {notice.message}
          </p>
        )}
      </div>
    </>
  );
};

interface AddMachineProps {
  hubKey: string | null;
  machines: readonly Machine[];
}

const AddMachine = ({ hubKey, machines }: AddMachineProps) => {
  const waiting = withoutSpoke(machines);

  return (
    <>
      <h3 className="pt-10" id="add-a-machine">
        Add a machine
      </h3>
      {waiting.length === 0 ? (
        <p className="text-soft mt-4">
          Every machine online on the tailnet has a devbox spoke.
        </p>
      ) : null}
      {waiting.length > 0 && (hubKey === null || hubKey === "") ? (
        <p className="text-soft mt-4">
          This hub does not say its key. Update devbox on the hub machine to see
          the command that adds a machine.
        </p>
      ) : null}
      {waiting.length === 0 || hubKey === null || hubKey === "" ? null : (
        <>
          <p className="text-soft mt-4">
            A machine without a devbox spoke shows no vitals, and the hub cannot
            update, pair or publish it.
          </p>
          <CommandTabs
            items={waiting.map(({ ip, name }) => ({
              label: name,
              lead: `Run this on ${name}, with the flags you set it up with.`,
              text: spokeCommand(ip, hubKey),
            }))}
          />
        </>
      )}
    </>
  );
};

interface SettingsProps {
  cloudflare: Cloudflare | null;
  hubKey: string | null;
  machines: readonly Machine[];
}

/** The last section of the page: the hub's Cloudflare login, and how to add a machine. */
export const Settings = ({ cloudflare, hubKey, machines }: SettingsProps) => (
  <section>
    <h2 className="text-heading pt-16" id="settings">
      Settings
    </h2>
    <CloudflareSettings cloudflare={cloudflare} />
    <AddMachine hubKey={hubKey} machines={machines} />
  </section>
);
