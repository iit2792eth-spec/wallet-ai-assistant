"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Gauge, MessageSquare, Settings, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Chat", icon: MessageSquare },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/limits", label: "Limits", icon: Gauge },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppSidebar() {
  const pathname = usePathname();
  return (
    <aside className="flex w-48 shrink-0 flex-col border-r bg-sidebar">
      <div className="flex h-12 items-center border-b px-4 text-sm font-medium">Access Layer</div>
      <nav className="flex flex-col gap-0.5 p-2">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={pathname === href ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
              pathname === href && "bg-sidebar-accent text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
