import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { fetchBootstrap, updateAgent } from "../api";
import {
  EmptyState,
  PageHeader,
  Panel,
  StatusBadge,
  SuccessCallout,
  WarningCallout,
} from "./components";

type AgentStatus = "active" | "paused" | "disabled";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });
  const [agentName, setAgentName] = useState("");
  const [agentDescription, setAgentDescription] = useState("");
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("active");
  const [defaultModelPolicyId, setDefaultModelPolicyId] = useState("");
  const [defaultRuntimeProfileId, setDefaultRuntimeProfileId] = useState("");
  const agentMutation = useMutation({
    mutationFn: updateAgent,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
  });

  useEffect(() => {
    if (!data) return;
    setAgentName(data.agent.name);
    setAgentDescription(data.agent.description);
    setAgentStatus(data.agent.status as AgentStatus);
    setDefaultModelPolicyId(data.agent.defaultModelPolicyId ?? "");
    setDefaultRuntimeProfileId(data.agent.defaultRuntimeProfileId ?? "");
  }, [data]);

  if (isLoading) return <div className="state">Loading settings...</div>;
  if (error || !data)
    return <div className="state error">No settings found.</div>;

  const trimmedName = agentName.trim();
  const trimmedDescription = agentDescription.trim();
  const canSave = trimmedName.length > 0 && !agentMutation.isPending;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Workspace Settings"
        title="Configure one handle. Route everything else behind it."
      />
      <section className="settings-grid summary-grid">
        <div className="summary-field">
          <span>Visible handle</span>
          <strong>{data.agent.handle}</strong>
          <small>Locked product surface</small>
        </div>
        <div className="summary-field">
          <span>Agent name</span>
          <strong>{data.agent.name}</strong>
          <small>{data.agent.description}</small>
        </div>
        <div className="summary-field">
          <span>Status</span>
          <StatusBadge value={data.agent.status} />
          <small>Applies to new work intake</small>
        </div>
        <div className="summary-field">
          <span>Workspace</span>
          <strong>{data.org.name}</strong>
          <small>{data.org.plan} plan</small>
        </div>
      </section>
      <Panel title="Agent Identity">
        {agentMutation.isError ? (
          <WarningCallout>
            {errorMessage(
              agentMutation.error,
              "Bek could not save agent settings.",
            )}
          </WarningCallout>
        ) : null}
        {agentMutation.isSuccess ? (
          <SuccessCallout>Agent settings saved.</SuccessCallout>
        ) : null}
        <form
          className="settings-grid"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave) return;
            const input: Parameters<typeof updateAgent>[0] = {
              name: trimmedName,
              description: trimmedDescription,
              status: agentStatus,
            };
            if (defaultModelPolicyId) {
              input.defaultModelPolicyId = defaultModelPolicyId;
            }
            if (defaultRuntimeProfileId) {
              input.defaultRuntimeProfileId = defaultRuntimeProfileId;
            }
            agentMutation.mutate(input);
          }}
        >
          <label>
            Visible handle
            <input
              value={data.agent.handle}
              readOnly
              aria-describedby="handle-lock"
            />
            <span className="field-hint" id="handle-lock">
              Bek exposes exactly one Slack handle.
            </span>
          </label>
          <label>
            Agent name
            <input
              value={agentName}
              required
              onChange={(event) => setAgentName(event.target.value)}
            />
          </label>
          <label className="wide-field">
            Description
            <textarea
              value={agentDescription}
              rows={3}
              onChange={(event) => setAgentDescription(event.target.value)}
            />
          </label>
          <label>
            Status
            <select
              value={agentStatus}
              onChange={(event) =>
                setAgentStatus(event.target.value as AgentStatus)
              }
            >
              <option value="active">active</option>
              <option value="paused">paused</option>
              <option value="disabled">disabled</option>
            </select>
          </label>
          <label>
            Default model policy
            <select
              value={defaultModelPolicyId}
              onChange={(event) => setDefaultModelPolicyId(event.target.value)}
            >
              <option value="">Use API default</option>
              {data.modelPolicies.map((policy) => (
                <option value={policy.id} key={policy.id}>
                  {policy.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Default runtime profile
            <select
              value={defaultRuntimeProfileId}
              onChange={(event) =>
                setDefaultRuntimeProfileId(event.target.value)
              }
            >
              <option value="">Use API default</option>
              {data.runtimeProfiles.map((profile) => (
                <option value={profile.id} key={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button
              className="primary"
              disabled={!canSave}
              aria-busy={agentMutation.isPending}
            >
              {agentMutation.isPending ? "Saving..." : "Save Agent"}
            </button>
          </div>
        </form>
      </Panel>
      <Panel title="Connected Places">
        {data.places.length === 0 ? (
          <EmptyState
            title="No places connected"
            body="Connect Slack before assigning Bek access by place."
          />
        ) : (
          <div className="bundle-list">
            {data.places.map((place) => (
              <div className="bundle" key={place.id}>
                <strong>{place.name}</strong>
                <span>{place.sensitivity}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
