import { Result, Schema } from "effect";
import { createHash } from "node:crypto";

export const SKILLS_LIST_URL =
  "https://raw.githubusercontent.com/PunGrumpy/dotfiles/main/home/run_onchange_after_40-install-agent-skills.sh.tmpl";

const Source = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^(?!.*\.\.)(?:[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*|https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+)$/,
    ),
  ),
);
const SkillName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)),
);

export const SkillSource = Schema.Struct({
  repo: Source,
  skills: Schema.Array(SkillName),
});
export type SkillSource = typeof SkillSource.Type;

export type SkillsList = {
  readonly sources: ReadonlyArray<SkillSource>;
  readonly rejected: ReadonlyArray<string>;
  readonly hash: string;
};

const tokens = (line: string) => {
  const [, repo, ...rest] = line.trim().split(/\s+/);
  const [flag, ...skills] = rest;
  return rest.length === 0
    ? { repo, skills: [] }
    : flag === "--skill"
      ? { repo, skills }
      : undefined;
};

export const parseSkillsList = (text: string): SkillsList => {
  const lines = text
    .split("\n")
    .filter((line) => line.startsWith("skill "))
    .map((line) => line.replace("git@github.com:", "https://github.com/"));
  const sources: Array<SkillSource> = [];
  const rejected: Array<string> = [];
  for (const line of lines) {
    const decoded = Schema.decodeUnknownResult(SkillSource)(tokens(line));
    if (Result.isSuccess(decoded)) sources.push(decoded.success);
    else rejected.push(line);
  }
  return {
    sources,
    rejected,
    hash: createHash("sha256").update(lines.join("\n")).digest("hex"),
  };
};

export const skillsAddArgs = (source: SkillSource): ReadonlyArray<string> => [
  "npx",
  "-y",
  "skills",
  "add",
  source.repo,
  ...(source.skills.length === 0 ? [] : ["--skill", ...source.skills]),
  "--global",
  "--yes",
  "--copy",
  "--agent",
  "claude-code",
  "codex",
];
