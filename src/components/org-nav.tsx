"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function OrgNav({ links }: { links: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav className="-mb-px flex gap-6 overflow-x-auto text-sm">
      {links.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`whitespace-nowrap border-b-2 pb-3 ${
              active ? "border-indigo-600 font-medium text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
