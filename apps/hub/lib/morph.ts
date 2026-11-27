const NAME = "search";

/**
 * Grows one element into another, the way the Rex docs open their search out of the button that
 * asked for it. `swap` is the change that hides the first and shows the second. A browser without
 * view transitions, or a reader who asked for less motion, gets the change with no animation.
 */
export const morph = async (
  from: HTMLElement,
  to: HTMLElement,
  swap: () => void
) => {
  if (
    !("startViewTransition" in document) ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    swap();

    return;
  }

  from.style.viewTransitionName = NAME;

  const transition = document.startViewTransition(() => {
    from.style.viewTransitionName = "";
    to.style.viewTransitionName = NAME;
    swap();
  });

  try {
    await transition.finished;
  } finally {
    to.style.viewTransitionName = "";
  }
};
