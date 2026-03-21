export default function HomePage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--accent-muted))] p-8">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Trading dashboard
        </h1>
        <p className="mt-2 max-w-xl text-slate-600 dark:text-slate-400">
          Scaffold only: Next.js App Router, TypeScript, and Tailwind CSS v4.
          Add data sources, charts, and routes here when you are ready.
        </p>
      </div>
    </main>
  );
}
