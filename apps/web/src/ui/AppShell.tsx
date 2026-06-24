import { Link, Outlet } from "@tanstack/react-router";
import { navigationItems } from "./product-model";

export function AppShell() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside className="sidebar" aria-label="Bek workspace">
        <Link to="/" className="brand" aria-label="Open Bek overview">
          <div className="brand-mark" aria-hidden="true">
            B
          </div>
          <div>
            <strong>Bek</strong>
            <span>Open teammate</span>
          </div>
        </Link>
        <nav className="primary-nav" aria-label="Bek admin navigation">
          {navigationItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.to === "/" }}
                activeProps={{ className: "active", "aria-current": "page" }}
              >
                <Icon size={17} aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="content" id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
