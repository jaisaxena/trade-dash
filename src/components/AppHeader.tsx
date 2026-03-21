import Link from "next/link";

export default function AppHeader() {
  return (
    <header className="border-b border-[hsl(var(--border))] bg-white/80 backdrop-blur-sm dark:bg-slate-950/80">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <Link
          href="/"
          className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100"
        >
          Trade Dash
        </Link>
        <nav className="flex items-center gap-4 text-sm text-slate-600 dark:text-slate-400">
          <Link
            href="/"
            className="hover:text-[hsl(var(--accent))] dark:hover:text-[hsl(var(--accent))]"
          >
            Home
          </Link>
        </nav>
      </div>
    </header>
  );
}
