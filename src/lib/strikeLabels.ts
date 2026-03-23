/** Stored recipe values stay ATM±N for the API; UI uses ITM/OTM wording. */

export const STRIKE_REFS = [
  "ATM-5",
  "ATM-4",
  "ATM-3",
  "ATM-2",
  "ATM-1",
  "ATM+0",
  "ATM+1",
  "ATM+2",
  "ATM+3",
  "ATM+4",
  "ATM+5",
] as const;

export type StrikeRef = (typeof STRIKE_REFS)[number];

/** Human label: negative offset from ladder = ITM, positive = OTM (matches CE/PE resolution in feed). */
export function formatStrikeRef(ref: string): string {
  if (ref === "ATM+0") return "ATM";
  if (ref.startsWith("ATM+")) {
    const n = ref.slice(4);
    return n === "0" ? "ATM" : `OTM ${n}`;
  }
  if (ref.startsWith("ATM-")) {
    return `ITM ${ref.slice(4)}`;
  }
  return ref;
}
