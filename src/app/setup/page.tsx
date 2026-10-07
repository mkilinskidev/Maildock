import { redirect } from "next/navigation";

import { SetupForm } from "@/components/setup-form";
import { isInstanceInitialized } from "@/modules/auth/application/instance-auth";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { Mail } from "lucide-react";
import { ThemeControl } from "@/components/theme-control";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isInstanceInitialized(db)) redirect("/login");
  return (
    <main className="auth-page">
      <section className="auth-content">
        <div className="auth-brand">
          <span className="brand-mark">
            <Mail size={16} />
          </span>
          Maildock
        </div>
        <h1>Set up Maildock</h1>
        <p>Create the only owner account for this instance.</p>
        <SetupForm />
        <div className="auth-theme">
          <ThemeControl />
        </div>
      </section>
    </main>
  );
}
