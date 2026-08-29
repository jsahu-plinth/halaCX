import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HalaCX | Multilingual AI contact center",
  description: "Multilingual AI voice agents that answer, resolve and act on every customer call.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><a className="skip-link" href="#content">Skip to content</a>{children}</body></html>;
}
