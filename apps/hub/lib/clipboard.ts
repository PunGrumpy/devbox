const fallbackCopy = (text: string) => {
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(area);
  area.select();
  // oxlint-disable-next-line typescript/no-deprecated -- the only copy that works on plain http
  document.execCommand("copy");
  area.remove();
};

/**
 * `navigator.clipboard` needs a secure context, and a hub on a Tailscale address is plain http.
 */
export const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    fallbackCopy(text);
  }
};
