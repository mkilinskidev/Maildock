export const scenarios = [
  "search-small",
  "search-large",
  "search-sparse",
  "search-out-of-range",
  "search-multi-response",
  "search-line-cap",
  "fetch-complete",
  "fetch-break",
  "fetch-paused",
  "fetch-incomplete",
  "hang-search",
  "hang-fetch",
  "slow-fetch",
  "mid-fetch",
  "disconnect-fetch",
  "trickle-search",
  "trickle-absolute-10s",
  "inactivity-fetch",
  "reselect-hang",
  "event-loop-starvation",
  "idle-delayed-done",
  "idle-hang-done",
  "idle-disconnect",
  "done-disconnect",
  "late-network",
  "late-callback",
  "buffered-after-close",
  "header-default",
  "header-literal-cap",
  "multi-literal-cap",
  "mime-depth",
  "mime-normal",
  "mime-byte-cap",
  "metadata-aggregate",
  "partial-base64",
  "partial-256k",
  "partial-qp",
  "partial-interrupted",
  "partial-oversized",
  "partial-wrong-offset",
  "lock-multiple",
  "lock-cancel",
  "lock-error",
] as const;
export type Scenario = (typeof scenarios)[number];
export function experiment(id: string) {
  if (id.startsWith("search-")) return "E1";
  if (id.startsWith("fetch-")) return "E2";
  if (/^(late-|buffered-)/.test(id)) return "E4";
  if (/^(header-|multi-literal|mime-|metadata-)/.test(id)) return "E5";
  if (id.startsWith("partial-")) return "E6";
  if (id.startsWith("lock-")) return "E7";
  return "E3";
}
