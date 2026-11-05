import {
  ActivityIcon,
  BarChart3Icon,
  BotIcon,
  BrainIcon,
  ContactRoundIcon,
  FolderIcon,
  GaugeIcon,
  KeyRoundIcon,
  LayoutGridIcon,
  type LucideIcon,
  MessagesSquareIcon,
  MoonStarIcon,
  NetworkIcon,
  RefreshCwIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  UsersIcon,
  WebhookIcon,
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
        title: "Memory",
        href: "/memory",
        icon: BrainIcon,
        keywords: ["remember", "recall", "search", "namespace", "agent"],
      },
      {
        title: "Entities",
        href: "/entities",
        icon: ContactRoundIcon,
        keywords: ["users", "agents", "runs", "people", "profile"],
      },
      {
        title: "Graph",
        href: "/graph",
        icon: NetworkIcon,
        keywords: ["relations", "connections", "entities", "names"],
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
    label: "Tools",
    items: [
      {
        title: "Playground",
        href: "/playground",
        icon: MessagesSquareIcon,
        keywords: ["chat", "try", "test", "stream"],
      },
      {
        title: "Copilot",
        href: "/copilot",
        icon: SparklesIcon,
        keywords: ["assistant", "ask", "ai", "help", "suggest"],
      },
      {
        title: "Dream",
        href: "/dream",
        icon: MoonStarIcon,
        keywords: ["tidy", "merge", "duplicates", "consolidate", "clean"],
      },
    ],
  },
  {
    label: "Developers",
    items: [
      {
        title: "Agents",
        href: "/agents",
        icon: BotIcon,
        keywords: ["connect", "mcp", "claude", "cursor", "cli", "oauth", "revoke"],
      },
      { title: "API keys", href: "/keys", icon: KeyRoundIcon, keywords: ["token", "secret"] },
      {
        title: "Webhooks",
        href: "/webhooks",
        icon: WebhookIcon,
        keywords: ["events", "deliveries", "signing", "integration"],
      },
      {
        title: "Configuration",
        href: "/configuration",
        icon: SlidersHorizontalIcon,
        keywords: ["model", "llm", "embedder", "provider", "gemini", "openai", "anthropic", "key"],
      },
      {
        title: "Activity",
        href: "/activity",
        icon: ActivityIcon,
        keywords: ["requests", "logs", "transactions", "jobs"],
      },
      {
        title: "Analytics",
        href: "/analytics",
        icon: BarChart3Icon,
        keywords: ["charts", "top users", "latency", "errors", "traffic"],
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
