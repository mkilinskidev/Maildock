import { Mail } from "lucide-react";

export function MaildockBrand() {
  return (
    <span className="maildock-brand">
      <span className="brand-mark">
        <Mail size={16} aria-hidden="true" />
      </span>
      <span>Maildock</span>
    </span>
  );
}
