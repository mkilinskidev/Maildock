import { redirect } from "next/navigation";

import { getCurrentSession } from "@/modules/auth/application/session";
import { isInstanceInitialized } from "@/modules/auth/application/instance-auth";
import { LogoutButton } from "@/components/logout-button";
import { db } from "@/shared/infrastructure/database/runtime-database";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (!(await isInstanceInitialized(db))) redirect("/setup");
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  return (
    <main>
      <section className="card">
        <h1>Maildock</h1>
        <p>Your unified inbox will appear here.</p>
        <LogoutButton />
      </section>
    </main>
  );
}
