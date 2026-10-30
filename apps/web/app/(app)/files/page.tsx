"use client";

import { BrandLoader } from "@memdot/ui/components/brand";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useCurrentSpace } from "@/lib/queries";

/** "Files" opens the space used last on this device (or the first one). */
export default function FilesIndex() {
  const router = useRouter();
  const { space, isPending } = useCurrentSpace();
  useEffect(() => {
    if (space) router.replace(`/spaces/${space.id}`);
    else if (!isPending) router.replace("/overview");
  }, [space, isPending, router]);
  return (
    <div className="flex flex-1 items-center justify-center">
      <BrandLoader />
    </div>
  );
}
