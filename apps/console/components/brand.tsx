export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <Logo />
          <h1 className="mt-4 text-xl font-bold">{title}</h1>
        </div>
        <div className="card">{children}</div>
      </div>
    </main>
  );
}

/** SAILES mark: chat bubble with a red bar chart, navy wordmark. */
export function Logo({ light = false }: { light?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2 text-xl font-extrabold tracking-tight ${light ? 'text-white' : 'text-navy'}`}>
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <path d="M3 4h22a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H11l-6 5v-5H3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill={light ? '#fff' : '#1B2A4A'} />
        <rect x="7" y="13" width="3" height="4" fill="#E63946" />
        <rect x="12.5" y="10" width="3" height="7" fill="#E63946" />
        <rect x="18" y="7" width="3" height="10" fill="#E63946" />
      </svg>
      SAILES
    </span>
  );
}
