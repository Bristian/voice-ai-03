import "./globals.css";

export const metadata = {
  title: "Voice AI Dashboard",
  description: "Car Dealership Voice AI — Supervisor Dashboard",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-text-primary">
        <nav className="border-b border-border px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-accent font-bold text-lg">🚗</span>
            <span className="font-semibold text-sm">Voice AI Dashboard</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-text-muted">
            <a href="/" className="hover:text-accent transition-colors">Active Calls</a>
            <a href="/history" className="hover:text-accent transition-colors">Call History</a>
          </div>
        </nav>
        <main className="p-6 max-w-7xl mx-auto">{children}</main>
      </body>
    </html>
  );
}
