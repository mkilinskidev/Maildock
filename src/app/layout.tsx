import type { Metadata } from "next";

import "./styles.css";

export const metadata: Metadata = {
  title: "Maildock",
  description: "A self-hosted unified inbox",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
