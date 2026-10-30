import { cn } from "@memdot/ui/lib/utils";
import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  FolderIcon,
  LockIcon,
  type LucideIcon,
} from "lucide-react";

const BY_EXTENSION: Record<string, LucideIcon> = {
  json: FileCodeIcon,
  ts: FileCodeIcon,
  js: FileCodeIcon,
  py: FileCodeIcon,
  csv: FileSpreadsheetIcon,
  xlsx: FileSpreadsheetIcon,
  zip: FileArchiveIcon,
  gz: FileArchiveIcon,
  tar: FileArchiveIcon,
  md: FileTextIcon,
  txt: FileTextIcon,
  pdf: FileTextIcon,
};

function iconFor(mime: string | null | undefined, name: string | null | undefined): LucideIcon {
  if (mime?.startsWith("image/")) return FileImageIcon;
  if (mime?.startsWith("video/")) return FileVideoIcon;
  if (mime?.startsWith("audio/")) return FileAudioIcon;
  if (mime?.startsWith("text/")) return FileTextIcon;
  const extension = name?.split(".").pop()?.toLowerCase();
  return (extension && BY_EXTENSION[extension]) || FileIcon;
}

/** A file's type at a glance; a lock when the name cannot be decrypted here. */
export function FileTypeIcon({
  mime,
  name,
  folder,
  className,
}: {
  mime?: string | null;
  name?: string | null;
  folder?: boolean;
  className?: string;
}) {
  const Icon = folder ? FolderIcon : name === null ? LockIcon : iconFor(mime, name);
  return <Icon className={cn("size-4 shrink-0 text-text-3", className)} aria-hidden="true" />;
}
