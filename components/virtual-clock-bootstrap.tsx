"use client";

// components/virtual-clock-bootstrap.tsx
// Installs the manual clock (lib/virtual-clock.ts) as early as the client bundle allows. The
// install happens when this module is evaluated, not in an effect, so by the time any other
// component reads `Date.now()` / `new Date()` the virtual clock is already in place.
// It must stay the first client component in the root layout.

import { installVirtualClock } from "@/lib/virtual-clock";

if (typeof window !== "undefined") {
  installVirtualClock();
}

export function VirtualClockBootstrap() {
  return null;
}
