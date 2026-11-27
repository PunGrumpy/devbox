import { groupByOs, STATE_LABEL, t3Sentence } from "@/lib/machines";
import type { Machine } from "@/lib/machines";

export interface Part {
  at: number;
  hit: boolean;
  text: string;
}

const wordsOf = (query: string) =>
  query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== "");

const literal = (word: string) =>
  word.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

export const mark = (text: string, query: string) => {
  const words = wordsOf(query).toSorted((a, b) => b.length - a.length);

  if (words.length === 0) {
    return [{ at: 0, hit: false, text }] satisfies Part[];
  }

  const pattern = new RegExp(`(${words.map(literal).join("|")})`, "giu");
  const parts: Part[] = [];
  let at = 0;

  for (const [position, piece] of text.split(pattern).entries()) {
    if (piece !== "") {
      parts.push({ at, hit: position % 2 === 1, text: piece });
    }

    at += piece.length;
  }

  return parts;
};

export const anchorOf = (name: string) => `machine-${name}`;

const describe = (machine: Machine, now: number) => {
  const sentence = `${t3Sentence(machine, now)}.`;

  return machine.tailscale === null
    ? sentence
    : `${sentence} ${machine.tailscale.dns} at ${machine.tailscale.ip}.`;
};

const holds = (machine: Machine, excerpt: string, words: readonly string[]) => {
  const text = [
    machine.name,
    excerpt,
    machine.kind,
    machine.tailscale?.os ?? "",
    STATE_LABEL[machine.state],
    machine.t3?.label ?? "",
  ]
    .join(" ")
    .toLowerCase();

  return words.every((word) => text.includes(word));
};

export const search = (
  machines: readonly Machine[],
  query: string,
  now: number
) => {
  const words = wordsOf(query);

  if (words.length === 0) {
    return { count: 0, groups: [] };
  }

  const found = machines.filter((machine) =>
    holds(machine, describe(machine, now), words)
  );

  const groups = groupByOs(found);
  const order = groups.flatMap((group) => group.machines);

  return {
    count: order.length,
    groups: groups.map(({ key, label, machines: members }) => ({
      hits: members.map((member) => ({
        excerpt: mark(describe(member, now), query),
        index: order.indexOf(member),
        machine: member,
        title: mark(member.name, query),
      })),
      key,
      label,
    })),
  };
};
