# Phase 2A — visual foundation

Maildock uses Tailwind CSS 4 through the PostCSS plugin. Semantic color tokens live in `src/app/styles.css` as CSS custom properties. The same tokens power reusable Tailwind color names through `@theme inline` and the small shared component classes used by forms, buttons, empty states, and the mail shell.

The root layout sets `data-theme` before the page paints, reading `maildock-theme` from local storage. Light and dark preferences are explicit; system follows `prefers-color-scheme`. The appearance control updates the attribute and persists the choice. This avoids a visible incorrect-theme flash while keeping the server-rendered markup stable.

The desktop shell has a compact app bar, account and mailbox sidebar, message list, and reader. At narrower widths, the reader stacks below the list and the mailbox navigation becomes horizontally scrollable. Mailbox counts use the existing mailbox API; message rows use existing list metadata, and the reader retains the existing isolated HTML iframe and content-fetch flow. The message list API does not expose a preview snippet, so no preview is fabricated.

Account connection, mailbox discovery, and synchronization diagnostics remain on the Accounts page under expandable details. Account setup, editing, sign-in, and first-run setup share the tokens and appearance control.
