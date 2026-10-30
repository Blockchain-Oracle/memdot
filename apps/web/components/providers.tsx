"use client";

import { Toaster } from "@memdot/ui/components/sonner";
import { TooltipProvider } from "@memdot/ui/components/tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { MemDotProvider } from "@/lib/memdot";
import { makeQueryClient } from "@/lib/query";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <MemDotProvider>
          <TooltipProvider delayDuration={300}>
            {children}
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </MemDotProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
