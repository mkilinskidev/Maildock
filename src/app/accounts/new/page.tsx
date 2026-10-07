import { redirect } from "next/navigation";
import { getCurrentSession } from "@/modules/auth/application/session";

export const dynamic = "force-dynamic";

export default async function NewAccountPage() {
  if (!(await getCurrentSession())) redirect("/login");
  redirect("/accounts?add=1");
}
