import { OwnerRecoveryEnrollment } from "@/components/owner-recovery-enrollment";
import { MaildockBrand } from "@/components/maildock-brand";

export const metadata = { title: "Recover owner authenticator" };
export const dynamic = "force-dynamic";
export default function OwnerRecoveryPage() {
  return (
    <main className="auth-page">
      <section className="auth-content">
        <div className="auth-brand">
          <MaildockBrand />
        </div>
        <h1>Set up a new authenticator</h1>
        <OwnerRecoveryEnrollment />
      </section>
    </main>
  );
}
