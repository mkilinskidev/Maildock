// Bounded, optional diagnosis using the same built sanitizer, outside acceptance.
import { htmlBoundary } from "./html-boundaries.mjs";
import { sanitizeEmailHtml } from "/app/dist-worker/modules/mail/infrastructure/sanitize-email-html.js";
const fixture = htmlBoundary(process.argv[2] ?? "newsletter");
const start = performance.now(),
  cpu = process.cpuUsage();
const result = sanitizeEmailHtml(fixture.html);
console.log(
  JSON.stringify({
    durationMs: performance.now() - start,
    cpu: process.cpuUsage(cpu),
    memory: process.memoryUsage(),
    correct: result.searchText === fixture.searchText,
  }),
);
