import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { LockKeyhole, LogOut } from "lucide-react";
import { useState } from "react";
import {
  clearAdminApiToken,
  fetchBootstrap,
  hasStoredAdminToken,
  isBekApiError,
  saveAdminApiToken,
} from "../api";
import { Panel, WarningCallout } from "./components";
import { navigationItems } from "./product-model";

export function AppShell() {
  const queryClient = useQueryClient();
  const [tokenInput, setTokenInput] = useState("");
  const [rememberToken, setRememberToken] = useState(false);
  const [tokenVersion, setTokenVersion] = useState(0);
  const bootstrapQuery = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
    retry: false,
  });
  const error = bootstrapQuery.error;
  const authRequired = isBekApiError(error) && error.status === 401;
  const missingServerToken =
    isBekApiError(error) &&
    error.status === 500 &&
    error.message.includes("BEK_ADMIN_API_TOKEN");

  function refreshAuthState() {
    setTokenVersion((value) => value + 1);
    void queryClient.invalidateQueries();
  }

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
        {hasStoredAdminToken() ? (
          <button
            className="sidebar-action"
            type="button"
            onClick={() => {
              clearAdminApiToken();
              refreshAuthState();
            }}
          >
            <LogOut size={16} aria-hidden="true" />
            Clear token
          </button>
        ) : null}
      </aside>
      <main className="content" id="main-content" tabIndex={-1}>
        {authRequired ? (
          <AdminUnlock
            tokenInput={tokenInput}
            rememberToken={rememberToken}
            onTokenInput={setTokenInput}
            onRememberToken={setRememberToken}
            onUnlock={() => {
              saveAdminApiToken(tokenInput, { persist: rememberToken });
              setTokenInput("");
              refreshAuthState();
            }}
          />
        ) : missingServerToken ? (
          <AdminServerTokenMissing />
        ) : bootstrapQuery.isLoading ? (
          <div className="state">Loading Bek admin...</div>
        ) : bootstrapQuery.isError ? (
          <div className="state error">{bootstrapQuery.error.message}</div>
        ) : (
          <Outlet key={tokenVersion} />
        )}
      </main>
    </div>
  );
}

function AdminUnlock({
  tokenInput,
  rememberToken,
  onTokenInput,
  onRememberToken,
  onUnlock,
}: {
  tokenInput: string;
  rememberToken: boolean;
  onTokenInput: (value: string) => void;
  onRememberToken: (value: boolean) => void;
  onUnlock: () => void;
}) {
  const canUnlock = tokenInput.trim().length > 0;
  return (
    <div className="auth-panel">
      <Panel title="Admin API Locked">
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canUnlock) {
              onUnlock();
            }
          }}
        >
          <LockKeyhole size={26} aria-hidden="true" />
          <label>
            Admin token
            <input
              autoFocus
              type="password"
              value={tokenInput}
              onChange={(event) => onTokenInput(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={rememberToken}
              onChange={(event) => onRememberToken(event.target.checked)}
            />
            Remember on this browser
          </label>
          <button className="primary" disabled={!canUnlock}>
            Unlock Admin API
          </button>
        </form>
      </Panel>
    </div>
  );
}

function AdminServerTokenMissing() {
  return (
    <div className="auth-panel">
      <WarningCallout>
        The API requires admin auth, but `BEK_ADMIN_API_TOKEN` is not configured
        on the server.
      </WarningCallout>
    </div>
  );
}
