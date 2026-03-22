"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

const NAV = [
  { href: "/",          label: "Pipeline",   short: "P" },
  { href: "/data",      label: "Data",       short: "D" },
  { href: "/strategies",label: "Strategies", short: "S" },
  { href: "/optimizer", label: "Optimizer",  short: "O" },
  { href: "/backtest",  label: "Backtest",   short: "B" },
  { href: "/vault",     label: "Vault",      short: "V" },
  { href: "/trading",   label: "Terminal",   short: "T" },
];

export default function AppHeader() {
  const pathname = usePathname();

  const auth = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => api.get<{ authenticated: boolean }>("/api/data/auth/status"),
    refetchInterval: 30_000,
  });

  return (
    <header style={{
      background: "var(--bg-card)",
      borderBottom: "1px solid var(--border)",
      position: "sticky",
      top: 0,
      zIndex: 100,
    }}>
      <div style={{
        maxWidth: 1280,
        margin: "0 auto",
        padding: "0 20px",
        height: 48,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
      }}>
        {/* Logo */}
        <Link href="/" style={{
          fontSize: 15,
          fontWeight: 800,
          color: "var(--accent-hi)",
          textDecoration: "none",
          letterSpacing: "-0.02em",
          flexShrink: 0,
        }}>
          TRADE DASH
        </Link>

        {/* Nav */}
        <nav style={{ display: "flex", gap: 2, alignItems: "center" }}>
          {NAV.map(({ href, label }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link key={href} href={href} style={{
                padding: "5px 11px",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: active ? 700 : 500,
                color: active ? "#fff" : "var(--text-muted)",
                background: active ? "var(--accent)" : "transparent",
                textDecoration: "none",
                transition: "all 0.15s",
              }}>
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Kite status */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <span className={`dot ${auth.data?.authenticated ? "dot-green" : "dot-red"}`} />
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {auth.data?.authenticated ? "Kite Connected" : "Kite Offline"}
          </span>
          {!auth.data?.authenticated && (
            <a
              href="/data"
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--accent-hi)",
                textDecoration: "none",
                marginLeft: 4,
              }}
            >
              Connect →
            </a>
          )}
        </div>
      </div>
    </header>
  );
}
