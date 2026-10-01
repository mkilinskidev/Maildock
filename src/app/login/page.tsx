import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { getCurrentSession } from "@/modules/auth/application/session";
import { isInstanceInitialized } from "@/modules/auth/application/instance-auth";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { Mail } from "lucide-react";
import { ThemeControl } from "@/components/theme-control";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!(await isInstanceInitialized(db))) redirect("/setup");
  if (await getCurrentSession()) redirect("/");
  return (
    <main className="auth-page">
      <section className="auth-content">
        <div className="auth-brand">
          <span className="brand-mark">
            <Mail size={16} />
          </span>
          Maildock
        </div>
        <h1>Welcome back</h1>
        <p>Sign in to your Maildock instance.</p>
        <LoginForm />
        <div className="auth-theme">
          <ThemeControl />
        </div>
      </section>
    </main>
  );
}
