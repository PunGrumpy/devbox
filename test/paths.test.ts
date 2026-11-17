import { describe, expect, test } from "bun:test";
import { absolutePath, isUnderRoot, slugOf } from "../src/migrate/paths.ts";

describe("isUnderRoot", () => {
  const root = absolutePath("/work/alpha");
  test("the root itself and paths beneath it", () => {
    expect(isUnderRoot("/work/alpha", root)).toBe(true);
    expect(isUnderRoot("/work/alpha/", root)).toBe(true);
    expect(isUnderRoot("/work/alpha/sub/deep", root)).toBe(true);
  });
  test("a sibling that shares the root's text is another path", () => {
    expect(isUnderRoot("/work/alphabet", root)).toBe(false);
    expect(isUnderRoot("/work/alpha-cli/x", root)).toBe(false);
  });
  test("case matters", () => {
    expect(isUnderRoot("/work/Alpha", root)).toBe(false);
    expect(isUnderRoot("/WORK/alpha/sub", root)).toBe(false);
  });
  test("a parent is not under its child", () => {
    expect(isUnderRoot("/work", root)).toBe(false);
  });
  test("everything absolute is under /", () => {
    expect(isUnderRoot("/work/alpha", absolutePath("/"))).toBe(true);
  });
});

describe("absolutePath", () => {
  test("resolves against a base and drops trailing slashes", () => {
    expect(absolutePath("x/../y/", "/base")).toBe(absolutePath("/base/y"));
    expect(absolutePath("/a/b/")).toBe(absolutePath("/a/b"));
  });
});

describe("slugOf", () => {
  test("turns every character that is not a letter or digit into '-'", () => {
    expect(slugOf(absolutePath("/Users/me/.dot files/a_b"))).toBe("-Users-me--dot-files-a-b");
  });
});
