import { OwnerRecoveryEnrollment } from "@/components/owner-recovery-enrollment";
import { MaildockBrand } from "@/components/maildock-brand";
import { ThemeControl } from "@/components/theme-control";

export const metadata = { title: "Recover owner authenticator" };
export const dynamic = "force-dynamic";
export default function OwnerRecoveryPage() {
  return (
    <main className="auth-page">
      <section className="auth-content">
        <div className="auth-brand">
          <MaildockBrand />
        </div>
        <h1>Recover owner authenticator</h1>
        <p>Set up a new authenticator to complete owner recovery.</p>
        <OwnerRecoveryEnrollment />
        <div className="auth-theme">
          <ThemeControl />
        </div>
      </section>
    </main>
  );
}
