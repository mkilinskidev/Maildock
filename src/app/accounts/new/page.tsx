import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";

import { AccountForm } from "@/components/account-form";
import { getCurrentSession } from "@/modules/auth/application/session";

export const dynamic = "force-dynamic";

export default async function NewAccountPage() {
  if (!(await getCurrentSession())) redirect("/login");
  return (
    <main className="page-shell">
      <section className="wide">
        <h1>Add mail account</h1>
        <p>
          Configure secure IMAP and SMTP connections. Testing is recommended but
          not required to save.
        </p>
        <AccountForm id={randomUUID()} />
      </section>
    </main>
  );
}
