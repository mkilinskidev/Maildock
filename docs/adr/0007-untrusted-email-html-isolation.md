# ADR 0007: Untrusted email HTML isolation

- Status: accepted
- Date: 2026-09-23
- Supersedes: none
- Superseded by: none

## Context

Email HTML is attacker-controlled and can contain active content, tracking resources, dangerous URLs, CSS exfiltration, and parser edge cases. Sanitization alone is not a complete browser isolation boundary.

DOMPurify explicitly supports server-side use with jsdom, recommends keeping jsdom current, and warns against happy-dom for security-sensitive sanitization. Current DOMPurify 3.4.16 and jsdom 30.1.1 support the selected Node.js runtime.

## Decision

Use a defense-in-depth rendering pipeline:

```text
MIME HTML
→ DOMPurify 3.4.16
→ jsdom 30.1.1
→ versioned sanitized representation
→ sandboxed iframe
→ frame-specific strict CSP
```

Phase 1D stores the `email-html-v1` sanitizer policy identifier. DOMPurify uses the HTML-only profile, removes scripts, forms, frames, embeds, SVG, MathML, media, resource-bearing tags, sender `<style>` and `style`, event handlers, and unsafe URLs. A second DOM pass removes all resource URL attributes, IDs and names, and retains only explicit `http:`, `https:`, and `mailto:` links. CID images are unavailable. Only sanitized HTML is stored; raw HTML and RFC822 source are not.

The iframe has an empty sandbox and receives no `allow-scripts`, `allow-forms`, `allow-same-origin`, or `allow-popups` capability. Its CSP uses `default-src 'none'` and explicitly blocks scripts, objects, frames, connections, images, media, fonts, form actions, and base URLs. Frame-local `style-src 'unsafe-inline'` permits Maildock-owned typography CSS only, after sender CSS has been removed. Remote HTTP/HTTPS resources are blocked by default. Phase 1D has no remote-image loading action or proxy.

Do not use happy-dom for this boundary and do not inject sanitized mail HTML directly into the application DOM.

## Alternatives considered

- Sanitization without iframe isolation: rejected because defense in depth is required.
- Client-only sanitization: rejected because unsafe content must not become trusted persisted/rendered state.
- happy-dom: rejected based on DOMPurify's explicit security warning.

## Consequences

- jsdom is part of the trusted computing base and must receive prompt security updates.
- Sanitizer and browser rendering tests must use the exact deployed parser and policy.
- Phase 1D implements the boundary and tests adversarial HTML output.
