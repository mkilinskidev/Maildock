import { redirect } from "next/navigation";

import { SetupForm } from "@/components/setup-form";
import { isInstanceInitialized } from "@/modules/auth/application/instance-auth";
import { db } from "@/shared/infrastructure/database/runtime-database";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isInstanceInitialized(db)) redirect("/login");
  return (
    <main>
      <section>
        <h1>Set up Maildock</h1>
        <p>Create the only owner account for this instance.</p>
        <SetupForm />
      </section>
    </main>
  );
}
