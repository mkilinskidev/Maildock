import { pageBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { headers } from "next/headers";
import { auth } from "@/modules/auth/infrastructure/auth";
import { ownerLanding } from "@/modules/auth/application/auth-navigation";
import { isInstanceInitialized } from "@/modules/auth/application/instance-auth";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { MaildockBrand } from "@/components/maildock-brand";
import { ThemeControl } from "@/components/theme-control";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  return pageBoundary(async () => {
    if (!(await isInstanceInitialized(db))) redirect("/setup");
    const landing = await ownerLanding(auth, await headers());
    if (landing !== "/login") redirect(landing);
    return (
      <main className="auth-page">
        <section className="auth-content">
          <div className="auth-brand">
            <MaildockBrand />
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
  });
}
