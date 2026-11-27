/**
 * The gradient panel from superlogical.com. It is a window onto a ramp twice its height, and the
 * ramp slides up as the page scrolls, so the color tells how far down the page is.
 */
export const Field = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none fixed top-3 right-3 bottom-3 left-[calc(50vw+18rem+4rem)] z-20 hidden overflow-hidden rounded-[14px] xl:block"
  >
    <div className="field-ramp absolute inset-x-0 top-0 h-[200%]" />
    <div className="grain absolute inset-0 opacity-70" />
    <div className="field-thumb absolute right-[7px] h-1/5 w-2.5 rounded-full bg-white/45" />
    <div className="absolute inset-0 rounded-[14px] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.035),inset_0_1px_4px_rgb(0_0_0/0.02)]" />
  </div>
);
