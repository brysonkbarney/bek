import { useQuery } from "@tanstack/react-query";
import { fetchBootstrap } from "../api";
import { EmptyState, PageHeader, Panel } from "./components";

export function SettingsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });

  if (isLoading) return <div className="state">Loading settings...</div>;
  if (!data) return <div className="state error">No settings found.</div>;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Workspace Settings"
        title="Configure one handle. Route everything else behind it."
      />
      <section className="settings-grid">
        <label>
          Visible handle
          <input value={data.agent.handle} readOnly />
        </label>
        <label>
          Agent name
          <input value={data.agent.name} readOnly />
        </label>
        <label>
          Status
          <input value={data.agent.status} readOnly />
        </label>
        <label>
          Workspace
          <input value={data.org.name} readOnly />
        </label>
      </section>
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
