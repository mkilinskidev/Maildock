// Synthetic documentation addresses; these probes never contact external hosts.
export const forwardingHeaders: Record<string, string>[] = [
  {},
  { "X-Forwarded-For": "" },
  { "X-Forwarded-For": "192.0.2.10" },
  { "X-Forwarded-For": "192.0.2.20" },
  { "X-Forwarded-For": "192.0.2.10, 10.0.0.2" },
  { "X-Real-IP": "192.0.2.30" },
  { Forwarded: "for=192.0.2.40;host=other.example.test;proto=https" },
  { "CF-Connecting-IP": "192.0.2.50" },
  { "True-Client-IP": "192.0.2.60" },
  {
    "X-Forwarded-For": "192.0.2.70",
    "X-Real-IP": "192.0.2.80",
    Forwarded: "for=192.0.2.90",
    "CF-Connecting-IP": "192.0.2.100",
    "True-Client-IP": "192.0.2.110",
  },
];
