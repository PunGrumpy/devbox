const NAME = "search";

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
