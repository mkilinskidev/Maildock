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

The initial sanitizer policy identifier will be versioned (starting with `email-html-v1`) so stored sanitized output can be invalidated and regenerated. The exact allowlist is finalized with message rendering, but it must remove scripts, forms, frames, active embeds, event handlers, unsafe SVG, dangerous URL schemes, and CSS that can load remote resources or escape the presentation boundary.

The iframe receives no `allow-scripts`, `allow-forms`, `allow-same-origin`, or `allow-popups` capability. Its CSP starts from `default-src 'none'`; only explicitly authorized local/CID and safe data resources may be added. Remote HTTP/HTTPS resources are blocked by default and require an explicit owner action through a privacy-preserving path.

Do not use happy-dom for this boundary and do not inject sanitized mail HTML directly into the application DOM.

## Alternatives considered

- Sanitization without iframe isolation: rejected because defense in depth is required.
- Client-only sanitization: rejected because unsafe content must not become trusted persisted/rendered state.
- happy-dom: rejected based on DOMPurify's explicit security warning.

## Consequences

- jsdom is part of the trusted computing base and must receive prompt security updates.
- Sanitizer and browser rendering tests must use the exact deployed parser and policy.
- Phase 0 records the boundary but does not implement message rendering.
