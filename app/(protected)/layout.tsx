import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { hasAppAccess } from "@/server/auth/gate";

export default async function ProtectedLayout({ children }: Readonly<{ children: ReactNode }>) {
  if (!(await hasAppAccess())) {
    redirect("/gate");
  }

  return <AppShell>{children}</AppShell>;
}
