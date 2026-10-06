import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/modules/auth/infrastructure/auth";
import { ownerLanding } from "@/modules/auth/application/auth-navigation";
import { isInstanceInitialized } from "@/modules/auth/application/instance-auth";
import { isInstanceReady } from "@/modules/auth/application/instance-readiness";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { InitialMfaForm } from "@/components/initial-mfa-form";
import { MaildockBrand } from "@/components/maildock-brand";
import { ThemeControl } from "@/components/theme-control";

export const metadata = { title: "Set up authenticator" };
export const dynamic = "force-dynamic";

export default async function InitialMfaPage() {
  if (!(await isInstanceInitialized(db))) redirect("/setup");
  // READY blocks this page even without an authenticated session.
  if (await isInstanceReady(db)) redirect("/login");
  const landing = await ownerLanding(auth, await headers());
  if (landing !== "/initial-mfa") redirect(landing);
  return (
    <main className="auth-page">
      <section className="auth-content">
        <div className="auth-brand">
          <MaildockBrand />
        </div>
        <h1>Set up authenticator</h1>
        <p>Protect your Maildock account before opening your inbox.</p>
        <InitialMfaForm />
        <div className="auth-theme">
          <ThemeControl />
        </div>
      </section>
    </main>
  );
}
