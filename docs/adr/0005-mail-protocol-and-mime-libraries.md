# ADR 0005: Mail protocol and MIME libraries

- Status: accepted
- Date: 2026-09-23
- Supersedes: none
- Superseded by: none

## Context

V1 needs maintained Node.js libraries for IMAP, SMTP, and MIME processing that are compatible with Node.js 24, while keeping protocol details outside application and domain code.

## Decision

Select ImapFlow 2.0.6 for IMAP, Nodemailer 10.0.10 for SMTP, and mailparser 3.9.28 for MIME parsing. Their current package metadata supports Node.js 20 or newer.

All three libraries remain behind Maildock's `MailProvider` and MIME-processing boundaries. Application code must use provider-neutral types and may not pass ImapFlow connections, IMAP sequence numbers, Nodemailer transports, or mailparser objects through the domain.

Parsing and protocol calls must later receive explicit bounds, timeouts, error sanitization, and cancellation/lifecycle handling.

## Alternatives considered

- Direct protocol use throughout application modules: rejected because it couples use cases to one provider implementation.
- Provider-specific HTTP APIs in V1: rejected by the architecture baseline.
- Building IMAP, SMTP, or MIME parsers in-house: rejected because these protocols are complex and security-sensitive.

## Consequences

- Phase 0 pins and verifies the libraries but implements no mail behavior.
- Future protocol adapters can change without changing mail-domain semantics.
