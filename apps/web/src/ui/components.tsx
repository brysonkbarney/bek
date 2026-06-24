import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  XCircle,
} from "lucide-react";
import { useId, type ReactNode } from "react";
import type { CapabilityGrant, Run } from "../api";
import { formatMoney } from "./product-model";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description ? <p className="lede">{description}</p> : null}
      </div>
      {actions ? <div className="header-actions">{actions}</div> : null}
    </header>
  );
}

export function Panel({
  title,
  children,
  action,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="panel" aria-labelledby={title ? headingId : undefined}>
      {title ? (
        <div className="panel-heading">
          <h2 id={headingId}>{title}</h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state" role="status" aria-live="polite">
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

export function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  const tone =
    normalized.includes("failed") ||
    normalized.includes("denied") ||
    normalized.includes("disabled")
      ? "danger"
      : normalized.includes("pending") ||
          normalized.includes("awaiting") ||
          normalized.includes("ask")
        ? "warning"
        : normalized.includes("active") ||
            normalized.includes("connected") ||
            normalized.includes("completed")
          ? "success"
          : "neutral";
  return <span className={`badge ${tone}`}>{value.replaceAll("_", " ")}</span>;
}

export function RiskBadge({ value }: { value: string }) {
  const tone =
    value.includes("privileged") || value.includes("external")
      ? "danger"
      : value.includes("draft")
        ? "warning"
        : "neutral";
  return <span className={`badge ${tone}`}>{value.replaceAll("_", " ")}</span>;
}

export function DecisionBadge({
  value,
}: {
  value: CapabilityGrant["decision"];
}) {
  const Icon =
    value === "allow" ? CheckCircle2 : value === "ask" ? Clock : XCircle;
  return (
    <span
      className={`badge ${value === "allow" ? "success" : value === "ask" ? "warning" : "danger"}`}
    >
      <Icon size={13} aria-hidden="true" />
      {value}
    </span>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail?: string;
  icon: ReactNode;
}) {
  return (
    <article className="metric">
      <div className="metric-icon" aria-hidden="true">
        {icon}
      </div>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </article>
  );
}

export function RunLink({ run }: { run: Run }) {
  return (
    <Link
      to="/runs/$runId"
      params={{ runId: run.id }}
      className="inline-link"
      aria-label={`Open run ${run.id}`}
    >
      {run.id}
      <ExternalLink size={13} aria-hidden="true" />
    </Link>
  );
}

export function CostCell({ run }: { run: Run }) {
  return (
    <span>
      {formatMoney(run.actualCostCents || run.estimatedCostCents)}
      {run.actualCostCents === 0 ? (
        <small className="muted"> est.</small>
      ) : null}
    </span>
  );
}

export function WarningCallout({ children }: { children: ReactNode }) {
  return (
    <div className="callout" role="alert">
      <AlertTriangle size={17} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
