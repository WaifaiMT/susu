import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Susu", template: "%s · Susu" },
  description: "Open-source app for running susu savings groups: rotating payouts, a locked schedule, and Mobile Money. Demo project on test keys.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-800 antialiased">{children}</body>
    </html>
  );
}
