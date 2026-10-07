import { ReplacementEnrollment } from "@/components/mfa-management";
import { MaildockBrand } from "@/components/maildock-brand";

export const metadata = { title: "Replace authenticator" };
export const dynamic = "force-dynamic";
export default function ReplacementPage() {
  return (
    <main className="auth-page">
      <section className="auth-content">
        <div className="auth-brand">
          <MaildockBrand />
        </div>
        <h1>Replace authenticator</h1>
        <ReplacementEnrollment />
      </section>
    </main>
  );
}
