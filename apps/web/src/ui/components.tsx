import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Plus,
  X,
  XCircle,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { BudgetState, CapabilityGrant, HealthStatus, Run } from "../api";
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

/**
 * A panel whose body is hidden behind an "+ Add" toggle (collapsed by default),
 * so list/content leads and creation is progressive disclosure.
 */
export function CollapsibleSection({
  title,
  addLabel,
  closeLabel = "Cancel",
  children,
  defaultOpen = false,
}: {
  title: string;
  addLabel: string;
  closeLabel?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{title}</h2>
        <button
          type="button"
          className="secondary"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? (
            <X size={15} aria-hidden="true" />
          ) : (
            <Plus size={15} aria-hidden="true" />
          )}
          {open ? closeLabel : addLabel}
        </button>
      </div>
      {open ? (
        <div id={bodyId} className="collapsible-body">
          {children}
        </div>
      ) : null}
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
    normalized.includes("disabled") ||
    normalized.includes("revoked") ||
    normalized.includes("error")
      ? "danger"
      : normalized.startsWith("not ") ||
          normalized.includes("not connected") ||
          normalized.includes("not configured")
        ? "warning"
        : normalized.includes("pending") ||
            normalized.includes("awaiting") ||
            normalized.includes("ask") ||
            normalized.includes("paused") ||
            normalized.includes("required") ||
            normalized.includes("needs")
          ? "warning"
          : normalized.includes("active") ||
              normalized.includes("connected") ||
              normalized.includes("completed") ||
              normalized.includes("configured") ||
              normalized.includes("ready")
            ? "success"
            : "neutral";
  return <span className={`badge ${tone}`}>{value.replaceAll("_", " ")}</span>;
}

export function HealthBadge({ value }: { value: HealthStatus }) {
  const tone =
    value === "ok"
      ? "success"
      : value === "degraded"
        ? "warning"
        : value === "down"
          ? "danger"
          : "neutral";
  const Icon =
    value === "ok"
      ? CheckCircle2
      : value === "degraded"
        ? AlertTriangle
        : value === "down"
          ? XCircle
          : Clock;
  return (
    <span className={`badge ${tone}`}>
      <Icon size={13} aria-hidden="true" />
      {value}
    </span>
  );
}

export function BudgetStateBadge({ value }: { value: BudgetState }) {
  const tone =
    value === "ok" ? "success" : value === "warning" ? "warning" : "danger";
  const Icon =
    value === "ok"
      ? CheckCircle2
      : value === "warning"
        ? AlertTriangle
        : XCircle;
  return (
    <span className={`badge ${tone}`}>
      <Icon size={13} aria-hidden="true" />
      {value}
    </span>
  );
}

/**
 * Horizontal utilization bar driven by a 0..1+ ratio. The fill clamps to 100%
 * width but the underlying value can exceed 1 (over budget); the tone follows
 * the budget state so over-budget bars read as destructive.
 */
export function UtilizationBar({
  value,
  state,
  label,
}: {
  value: number;
  state: BudgetState;
  label: string;
}) {
  const ratio = Number.isFinite(value) && value > 0 ? value : 0;
  const percent = Math.round(ratio * 100);
  const width = Math.min(100, Math.max(0, percent));
  const tone =
    state === "ok" ? "success" : state === "warning" ? "warning" : "danger";
  return (
    <div
      className="utilization-bar"
      role="meter"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={`utilization-fill ${tone}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
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

export function SuccessCallout({ children }: { children: ReactNode }) {
  return (
    <div className="callout success" role="status" aria-live="polite">
      <CheckCircle2 size={17} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
