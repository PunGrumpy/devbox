export interface Block {
  height: number;
  lightFill: boolean;
  lineHeight: number;
  width: number;
}

const SLANT = 0.358;

const STEPS = 12;
const SMALL_LINES = 10;
const LARGE_LINES = 70;
const BASE_MS = 391;
const DEFAULT_LINE_HEIGHT = 22.5;

const smoothstep = (from: number, to: number, value: number) => {
  const along = Math.min(Math.max((value - from) / (to - from), 0), 1);

  return along * along * (3 - 2 * along);
};

const bell = (offset: number, width: number) =>
  Math.exp(-((offset / width) ** 2));

const gradient = (
  extent: number,
  color: string,
  alpha: (offset: number) => number
) => {
  const stops = Array.from({ length: STEPS * 2 + 1 }, (_, index) => {
    const along = (index - STEPS) / STEPS;
    const offset = Math.sign(along) * along ** 2 * extent;
    const amount = Math.min(Math.max(alpha(offset), 0), 1) * 100;

    return `color-mix(in srgb, ${color} ${amount.toFixed(1)}%, transparent) ${(50 + (offset / extent) * 50).toFixed(2)}%`;
  });

  return `linear-gradient(90deg, ${stops.join(", ")})`;
};

const strip = (
  extent: number,
  travel: { from: number; to: number },
  image: string
) => ({
  image,
  from: travel.from - extent,
  to: travel.to - extent,
  width: extent * 2,
});

const glow = (calm: number, core: number, bloom: number) => (offset: number) =>
  calm * (0.3 * bell(offset, core) + 0.175 * bell(offset, bloom));

const flanks =
  (calm: number, core: number, bloom: number) => (offset: number) =>
    calm * 0.513 * (bell(offset, bloom) - bell(offset, core));

export const sheenOf = ({ height, lightFill, lineHeight, width }: Block) => {
  const span = width + height * SLANT;

  const size = smoothstep(
    SMALL_LINES,
    LARGE_LINES,
    (span + height * 2) / lineHeight
  );

  const unit = Math.max(lineHeight, span * 0.054);
  const core = unit * 1.595;
  const bloom = unit * 5.573;
  const rim = unit * 10.133;
  const calm = 1 - 0.65 * size;
  const reach = Math.max(rim, bloom) * 1.5;
  const travel = { from: -reach, to: span + reach };
  const duration = BASE_MS * (1 + 0.6 * size);

  return {
    duration,
    amplitude: Math.min(
      0.016,
      (lineHeight * 0.1) / Math.max(Math.max(width, height) / 2, 1)
    ),
    band: strip(
      bloom * 2.6,
      travel,
      gradient(
        bloom * 2.6,
        "var(--sheen)",
        lightFill ? flanks(calm, core, bloom) : glow(calm, core, bloom)
      )
    ),
    edge: strip(
      rim * 2.6,
      travel,
      gradient(
        rim * 2.6,
        "black",
        (offset) =>
          1.016 * (0.55 * bell(offset, rim) + 0.45 * calm * bell(offset, bloom))
      )
    ),
    sweep: duration * 0.84,
  };
};

const ID = "sheen";
const SINE = "cubic-bezier(0.37, 0, 0.63, 1)";

export const shine = (overlay: HTMLElement) => {
  const block = overlay.parentElement;
  const band = overlay.querySelector(".sheen-band");
  const edge = overlay.querySelector(".sheen-edge");

  if (
    !block ||
    !(band instanceof HTMLElement) ||
    !(edge instanceof HTMLElement) ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return;
  }

  for (const animation of block.getAnimations({ subtree: true })) {
    if (animation.id === ID) {
      animation.cancel();
    }
  }

  const plan = sheenOf({
    height: block.offsetHeight,
    lightFill: matchMedia("(prefers-color-scheme: light)").matches,
    lineHeight:
      Number(getComputedStyle(overlay).lineHeight.replace("px", "")) ||
      DEFAULT_LINE_HEIGHT,
    width: block.offsetWidth,
  });

  const sweep = { duration: plan.sweep, easing: SINE, id: ID };

  band.style.width = `${plan.band.width}px`;
  band.style.backgroundImage = plan.band.image;
  edge.style.maskImage = plan.edge.image;
  edge.style.maskSize = `${plan.edge.width}px 100%`;

  block.animate(
    [
      { easing: SINE, transform: "scale(1)" },
      {
        easing: SINE,
        offset: 0.42,
        transform: `scale(${1 + plan.amplitude})`,
      },
      { transform: "scale(1)" },
    ],
    { duration: plan.duration, id: ID }
  );
  overlay.animate(
    [
      { easing: "ease-in-out", opacity: 0 },
      { offset: 0.2, opacity: 1 },
      { easing: "ease-in-out", offset: 0.8, opacity: 1 },
      { opacity: 0 },
    ],
    sweep
  );
  band.animate(
    { translate: [`${plan.band.from}px`, `${plan.band.to}px`] },
    sweep
  );
  edge.animate(
    { maskPosition: [`${plan.edge.from}px 0`, `${plan.edge.to}px 0`] },
    sweep
  );
};
