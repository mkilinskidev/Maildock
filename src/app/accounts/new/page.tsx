import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";

import { AccountForm } from "@/components/account-form";
import { getCurrentSession } from "@/modules/auth/application/session";
import Link from "next/link";
import { ThemeControl } from "@/components/theme-control";

export const dynamic = "force-dynamic";

export default async function NewAccountPage() {
  if (!(await getCurrentSession())) redirect("/login");
  return (
    <main className="page-shell">
      <section className="page-content">
        <header className="page-header">
          <div>
            <h1>Add mail account</h1>
            <p>Configure secure IMAP and SMTP connections.</p>
          </div>
          <div className="page-header-actions">
            <ThemeControl />
            <Link className="button-link secondary" href="/accounts">
              Accounts
            </Link>
          </div>
        </header>
        <AccountForm id={randomUUID()} />
      </section>
    </main>
  );
}
