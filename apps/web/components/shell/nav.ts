import {
  ActivityIcon,
  FolderIcon,
  GaugeIcon,
  KeyRoundIcon,
  LayoutGridIcon,
  type LucideIcon,
  RefreshCwIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  /** Also active for these path prefixes. */
  match?: string[];
  keywords?: string[];
}

/** The sidebar, ⌘K and breadcrumbs share this list. */
export const NAV: { label: string; items: NavItem[] }[] = [
  {
    label: "Data",
    items: [
      { title: "Overview", href: "/overview", icon: LayoutGridIcon, keywords: ["home", "start"] },
      {
        title: "Files",
        href: "/files",
        icon: FolderIcon,
        match: ["/spaces"],
        keywords: ["storage", "upload", "space"],
      },
      {
        title: "Shared with me",
        href: "/shared",
        icon: UsersIcon,
        keywords: ["grants", "received"],
      },
    ],
  },
  {
    label: "Developers",
    items: [
      { title: "API keys", href: "/keys", icon: KeyRoundIcon, keywords: ["token", "secret"] },
      {
        title: "Activity",
        href: "/activity",
        icon: ActivityIcon,
        keywords: ["requests", "logs", "transactions", "jobs"],
      },
      {
        title: "Renewals",
        href: "/renewals",
        icon: RefreshCwIcon,
        keywords: ["keeper", "expiry", "retention"],
      },
    ],
  },
  {
    label: "Account",
    items: [
      {
        title: "Plans & usage",
        href: "/usage",
        icon: GaugeIcon,
        keywords: ["quota", "limits", "tpot", "spent"],
      },
      {
        title: "Settings",
        href: "/settings",
        icon: SettingsIcon,
        keywords: ["security", "passkey", "recovery", "theme", "profile"],
      },
    ],
  },
];

export const NAV_ITEMS = NAV.flatMap((group) => group.items);

export function isActive(item: NavItem, pathname: string): boolean {
  return [item.href, ...(item.match ?? [])].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
