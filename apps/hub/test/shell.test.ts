import { expect, test } from "bun:test";

import { shellTokens } from "@/lib/shell";

const kinds = (line: string) =>
  shellTokens(line)
    .filter(({ text }) => text.trim() !== "")
    .map(({ kind, text }) => `${text}=${kind}`);

test("the program is a function, its flags are properties", () => {
  expect(kinds("devbox machines --json")).toEqual([
    "devbox=function",
    "machines=plain",
    "--json=property",
  ]);
});

test("a pipe is an operator and starts a new command", () => {
  expect(kinds("curl -s http://example.com/api | sh -s")).toEqual([
    "curl=function",
    "-s=property",
    "http://example.com/api=plain",
    "|=operator",
    "sh=function",
    "-s=property",
  ]);
});

test("the pieces join back into the line", () => {
  const line = "curl  -s http://example.com/api/machines";

  expect(
    shellTokens(line)
      .map(({ text }) => text)
      .join("")
  ).toBe(line);
  expect(shellTokens(line).map(({ at }) => at)).toEqual([0, 4, 6, 8, 9]);
});
