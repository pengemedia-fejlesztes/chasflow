/** Whole HUF input: never silently strip decimal separators or signs. */
export function parseWholeForint(value: string | number): number | null {
  const text = String(value).trim();
  if (!/^(?:\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)$/.test(text)) return null;
  const amount = Number(text.replace(/[ \u00a0\u202f]/g, ''));
  return Number.isSafeInteger(amount) && amount <= 1e12 ? amount : null;
}
