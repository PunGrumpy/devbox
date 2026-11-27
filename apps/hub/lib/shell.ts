export type TokenKind = "function" | "operator" | "plain" | "property";

export interface Token {
  at: number;
  kind: TokenKind;
  text: string;
}

const OPERATORS = new Set(["|", "||", "&&", ";", ">", ">>", "<"]);

const isSpace = (text: string) => text.trim() === "";

const kindOf = (text: string, previous: string | undefined) => {
  if (isSpace(text)) {
    return "plain" satisfies TokenKind;
  }

  if (OPERATORS.has(text)) {
    return "operator" satisfies TokenKind;
  }

  if (previous === undefined || OPERATORS.has(previous)) {
    return "function" satisfies TokenKind;
  }

  return (text.startsWith("-") ? "property" : "plain") satisfies TokenKind;
};

export const shellTokens = (line: string) => {
  const pieces = [...line.matchAll(/\s+|\S+/gu)];

  return pieces.map(
    ({ 0: text, index }, position) =>
      ({
        at: index,
        kind: kindOf(
          text,
          pieces
            .slice(0, position)
            .findLast(({ 0: before }) => !isSpace(before))?.[0]
        ),
        text,
      }) satisfies Token
  );
};
