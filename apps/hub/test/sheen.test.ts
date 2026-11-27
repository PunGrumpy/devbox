import { describe, expect, test } from "bun:test";

import { sheenOf } from "@/lib/sheen";

const command = { height: 43, lightFill: false, lineHeight: 22.5, width: 576 };

const middleOf = (image: string) => {
  const stop = image
    .split(", color-mix(in srgb, ")
    .find((piece) => piece.endsWith(" 50.00%"));

  return Number(stop?.split(" ")[1]?.replace("%,", ""));
};

describe("sheenOf", () => {
  test("a command block lifts and settles the way the docs' one does", () => {
    const { amplitude, duration, sweep } = sheenOf(command);

    expect(amplitude).toBeCloseTo(0.00781, 4);
    expect(duration).toBeCloseTo(452, 0);
    expect(sweep).toBeCloseTo(380, 0);
  });

  test("a narrow block lifts more, but never past 1.6 percent", () => {
    const phone = sheenOf({ ...command, width: 342 });
    const chip = sheenOf({ ...command, height: 24, width: 60 });

    expect(phone.amplitude).toBeGreaterThan(sheenOf(command).amplitude);
    expect(chip.amplitude).toBeCloseTo(0.016, 6);
  });

  test("a larger block takes longer, up to 1.6 times", () => {
    const small = sheenOf({ ...command, height: 24, width: 60 });
    const page = sheenOf({ ...command, height: 900, width: 1400 });

    expect(small.duration).toBeCloseTo(391, 0);
    expect(page.duration).toBeCloseTo(391 * 1.6, 0);
  });

  test("the middle of the light starts off one side of the block and ends off the other", () => {
    const { band, edge } = sheenOf(command);

    for (const strip of [band, edge]) {
      expect(strip.from + strip.width / 2).toBeLessThan(0);
      expect(strip.to + strip.width / 2).toBeGreaterThan(command.width);
    }
  });

  test("a dark block is brightest in the middle of the band, a light one stays clear there", () => {
    expect(middleOf(sheenOf(command).band.image)).toBeGreaterThan(30);
    expect(middleOf(sheenOf({ ...command, lightFill: true }).band.image)).toBe(
      0
    );
  });
});
