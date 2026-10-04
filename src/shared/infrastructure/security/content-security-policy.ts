/** srcdoc inherits the embedding page's CSP. Its own policy can only restrict
 * that inherited policy, so the reader page needs an HTTP(S) image ceiling.
 * The isolated email's CSP and pre-render resource filtering still deny remote
 * images by default. The ceiling must be consistent across application pages:
 * Next client navigation from login/settings retains the original document CSP.
 */
export function createContentSecurityPolicy(nonce: string): string {
  const developmentScriptPolicy =
    process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${developmentScriptPolicy}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: http:",
    "connect-src 'self'",
  ].join("; ");
}
