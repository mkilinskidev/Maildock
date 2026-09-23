import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { getCurrentSession } from "@/modules/auth/application/session";
import { isInstanceInitialized } from "@/modules/auth/application/instance-auth";
import { db } from "@/shared/infrastructure/database/runtime-database";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!(await isInstanceInitialized(db))) redirect("/setup");
  if (await getCurrentSession()) redirect("/");
  return (
    <main>
      <section>
        <h1>Maildock</h1>
        <p>Sign in to this instance.</p>
        <LoginForm />
      </section>
    </main>
  );
}
