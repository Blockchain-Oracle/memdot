import "@memdot/ui/globals.css";
import { cn } from "@memdot/ui/lib/utils";
import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { Providers } from "@/components/providers";

const sans = Space_Grotesk({ subsets: ["latin"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: { default: "MemDot", template: "%s · MemDot" },
  description:
    "Store files, app data and agent memories on Portaldot: encrypted on your device, verifiable by anyone, kept alive automatically.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf8f4" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0f" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={cn(sans.variable, mono.variable)}>
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
