import type { Metadata } from "next";

import "./styles.css";

export const metadata: Metadata = {
  title: { default: "Maildock", template: "%s · Maildock" },
  description: "A self-hosted unified inbox",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('maildock-theme');document.documentElement.dataset.theme=t==='light'||t==='dark'?t:'system'}catch(e){document.documentElement.dataset.theme='system'}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
