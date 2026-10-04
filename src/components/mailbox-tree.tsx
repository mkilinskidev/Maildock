"use client";
import { useState } from "react";
import { ChevronDown, ChevronRight, Folder, Inbox, Mail } from "lucide-react";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import type { MailboxView } from "@/modules/mail/application/mailbox-service";
import type { MailboxRoleView } from "@/modules/mail/application/mailbox-role-service";

export function orderedSpecialMailboxes(
  boxes: readonly MailboxView[],
  roles: readonly MailboxRoleView[],
) {
  const active = boxes.filter(
    (b) => b.selectable && b.lifecycleStatus === "active",
  );
  const ids = [
    active.find((b) => b.remotePath.toUpperCase() === "INBOX")?.id,
    ...["sent", "drafts", "archive", "junk", "trash"].map(
      (role) => roles.find((r) => r.role === role && r.available)?.mailboxId,
    ),
  ];
  return [...new Set(ids)].flatMap((id) => active.filter((b) => b.id === id));
}
type Node = {
  path: string;
  name: string;
  mailbox?: MailboxView;
  children: Node[];
};
export function otherMailboxTree(
  boxes: readonly MailboxView[],
  excluded: ReadonlySet<string>,
): Node[] {
  const roots: Node[] = [];
  for (const box of boxes.filter(
    (b) => b.lifecycleStatus === "active" && !excluded.has(b.id),
  )) {
    const parts = box.delimiter
      ? box.remotePath.split(box.delimiter)
      : [box.remotePath];
    let siblings = roots;
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join(box.delimiter ?? "");
      let node = siblings.find((n) => n.path === path);
      if (!node) {
        node = { path, name, children: [] };
        siblings.push(node);
      }
      if (index === parts.length - 1) {
        node.mailbox = box;
        node.name = box.name === box.remotePath ? name : box.name;
      }
      siblings = node.children;
    });
  }
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}
export function MailboxTree({
  accounts,
  boxes,
  roles,
  accountId,
  mailboxId,
  allInboxes,
  showDrafts,
  searchActive,
  unread,
  onSelect,
  onDrafts,
}: {
  accounts: MailAccountView[];
  boxes: Record<string, MailboxView[]>;
  roles: Record<string, MailboxRoleView[]>;
  accountId: string;
  mailboxId: string;
  allInboxes: boolean;
  showDrafts: boolean;
  searchActive: boolean;
  unread: (box: MailboxView) => string | null;
  onSelect: (accountId: string, mailboxId: string, all?: boolean) => void;
  onDrafts: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(accounts.map((a) => [`other:${a.id}`, true])),
  );
  const toggle = (key: string) =>
    setCollapsed((c) => ({ ...c, [key]: !c[key] }));
  const disclosure = (key: string, label: string, active = false) => (
    <button
      className={`tree-disclosure${active ? " contains-selection" : ""}`}
      aria-expanded={!collapsed[key]}
      onClick={() => toggle(key)}
    >
      {collapsed[key] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      <span className="folder-name">{label}</span>
    </button>
  );
  const mailbox = (account: string, box: MailboxView, label = box.name) => {
    const selected =
      !searchActive &&
      !showDrafts &&
      !allInboxes &&
      accountId === account &&
      mailboxId === box.id;
    const count = unread(box);
    return (
      <button
        key={box.id}
        title={box.remotePath}
        className={selected ? "active" : ""}
        aria-current={selected ? "page" : undefined}
        disabled={!box.selectable}
        onClick={() => onSelect(account, box.id)}
      >
        {box.remotePath.toUpperCase() === "INBOX" ? (
          <Inbox size={16} />
        ) : (
          <Folder size={16} />
        )}
        <span className="folder-name">{label}</span>
        {count ? (
          <span className="folder-count unread" title="Unread messages">
            {new Intl.NumberFormat().format(BigInt(count))}
          </span>
        ) : null}
      </button>
    );
  };
  const nodes = (account: string, entries: Node[]) =>
    entries.map((node) => (
      <div className="tree-folder" key={node.path}>
        {node.mailbox ? (
          mailbox(account, node.mailbox, node.name)
        ) : (
          <span className="tree-parent">
            <Folder size={14} />
            {node.name}
          </span>
        )}
        {node.children.length ? (
          <div className="tree-nested">{nodes(account, node.children)}</div>
        ) : null}
      </div>
    ));
  const inboxes = accounts
    .filter((a) => a.enabled)
    .flatMap((a) =>
      (boxes[a.id] ?? []).filter(
        (b) =>
          b.selectable &&
          b.lifecycleStatus === "active" &&
          b.remotePath.toUpperCase() === "INBOX",
      ),
    );
  const inboxUnread =
    inboxes.length && inboxes.every((b) => b.unseenCount !== null)
      ? inboxes.reduce((sum, b) => sum + BigInt(unread(b) ?? "0"), 0n)
      : 0n;
  return (
    <nav className="mail-folders" aria-label="Mailboxes">
      <div className="sidebar-label">Favorites</div>
      <button
        className={!searchActive && !showDrafts && allInboxes ? "active" : ""}
        aria-current={
          !searchActive && !showDrafts && allInboxes ? "page" : undefined
        }
        onClick={() => onSelect(accountId, "", true)}
      >
        <Inbox size={16} />
        <span className="folder-name">All Inboxes</span>
        {inboxUnread > 0n ? (
          <span className="folder-count unread" title="Unread messages">
            {new Intl.NumberFormat().format(inboxUnread)}
          </span>
        ) : null}
      </button>
      <button
        className={!searchActive && showDrafts ? "active" : ""}
        aria-current={!searchActive && showDrafts ? "page" : undefined}
        onClick={onDrafts}
      >
        <Mail size={16} />
        <span className="folder-name">Local drafts</span>
      </button>
      {accounts.map((account) => {
        const folders = boxes[account.id] ?? [];
        const special = orderedSpecialMailboxes(
          folders,
          roles[account.id] ?? [],
        );
        const other = otherMailboxTree(
          folders,
          new Set(special.map((b) => b.id)),
        );
        const key = `account:${account.id}`;
        const otherKey = `other:${account.id}`;
        return (
          <section
            className="tree-account"
            key={account.id}
            aria-label={account.displayName}
          >
            {disclosure(
              key,
              account.displayName,
              !searchActive &&
                !showDrafts &&
                !allInboxes &&
                accountId === account.id,
            )}
            {!collapsed[key] ? (
              <div className="tree-account-folders">
                <div className="tree-account-email" title={account.email}>
                  {account.email}
                  {!account.enabled ? " · Disabled" : ""}
                </div>
                {special.map((box) => mailbox(account.id, box))}
                {other.length ? (
                  <>
                    {disclosure(
                      otherKey,
                      "Other folders",
                      !searchActive &&
                        !showDrafts &&
                        !allInboxes &&
                        accountId === account.id &&
                        folders.some(
                          (b) =>
                            b.id === mailboxId &&
                            !special.some((s) => s.id === b.id),
                        ),
                    )}
                    {!collapsed[otherKey] ? (
                      <div className="tree-other">
                        {nodes(account.id, other)}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}
    </nav>
  );
}
