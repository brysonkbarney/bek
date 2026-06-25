import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  CircleSlash,
  Clock,
  Database,
  ExternalLink,
  GitPullRequest,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  Route,
  Server,
  ShieldCheck,
  Slack,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  attachBundleToPlace,
  createAccessBundle,
  createChannel,
  createGrant,
  decideApproval,
  discoverSlackChannels,
  fetchBootstrap,
  fetchRunDetail,
  fetchSlackInstallStart,
  fetchSetupStatus,
  hasBuildTimeAdminToken,
  hasStoredAdminToken,
  linkPrincipalExternalIdentity,
  updateModelPolicy,
  updateChannel,
  type AccessBundle,
  type ApprovalRequest,
  type Bootstrap,
  type DiscoveredSlackChannel,
  type ModelPolicy,
  type Run,
  type RunEvent,
} from "../api";
import {
  bundlesForPlace,
  connectorSummaries,
  findPlace,
  findRunPlace,
  formatDateTime,
  formatMoney,
  grantsByDecision,
  setupOperationsFromStatus,
  visibleHandleAntiPatterns,
  type SetupOperation,
} from "./product-model";
import {
  CostCell,
  DecisionBadge,
  EmptyState,
  MetricCard,
  PageHeader,
  Panel,
  RiskBadge,
  RunLink,
  StatusBadge,
  SuccessCallout,
  WarningCallout,
} from "./components";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function ConnectorIcon({ id }: { id: string }) {
  const Icon =
    id === "slack"
      ? Slack
      : id === "github"
        ? GitPullRequest
        : id === "model"
          ? Route
          : id === "runtime"
            ? Server
            : id === "sandbox"
              ? LockKeyhole
              : Database;
  return <Icon size={20} aria-hidden="true" />;
}

function activeSlackWorkspaceId(data: Bootstrap): string | undefined {
  return data.connectorInstalls.find(
    (install) =>
      install.kind === "slack" &&
      install.provider === "slack" &&
      install.status === "active",
  )?.externalId;
}

function slackTeamIdForPlace(place: Bootstrap["places"][number]) {
  const teamId = place.metadata?.teamId ?? place.metadata?.slackTeamId;
  return typeof teamId === "string" ? teamId : undefined;
}

export function SetupPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });
  const {
    data: setupStatus,
    isLoading: isSetupLoading,
    error: setupError,
  } = useQuery({
    queryKey: ["setupStatus"],
    queryFn: fetchSetupStatus,
  });

  if (isLoading || isSetupLoading)
    return <div className="state">Loading setup...</div>;
  if (error || setupError || !data || !setupStatus)
    return <div className="state error">Bek API is not reachable.</div>;

  const adminAuthDetail = hasBuildTimeAdminToken()
    ? "Using a local dev admin token."
    : hasStoredAdminToken()
      ? "Using a browser-entered admin token."
      : "Admin API accepted this session.";
  const operations = setupOperationsFromStatus(setupStatus, {
    adminAuthDetail,
    adminAuthenticated: true,
  });
  const requiredOperations = operations.filter(
    (operation) => operation.id !== "github-preview",
  );
  const progress = {
    complete: requiredOperations.filter((operation) => operation.complete)
      .length,
    total: requiredOperations.length,
  };
  const requiredOperationsReady = progress.complete === progress.total;
  const setupReady = setupStatus.readyForWorkspace && requiredOperationsReady;
  const workspaceReviewOperation: SetupOperation | undefined =
    !setupStatus.readyForWorkspace
      ? {
          id: "workspace-readiness",
          phase: "Review",
          title: "Review workspace readiness",
          detail:
            "The visible setup operations are complete, but the API has not marked the workspace ready yet.",
          status: "needs review",
          complete: false,
          facts: ["readyForWorkspace is false"],
          primaryAction: { label: "Open settings", route: "/settings" },
          secondaryAction: { label: "Review access", route: "/access-bundles" },
        }
      : undefined;
  const nextOperation =
    requiredOperations.find((operation) => !operation.complete) ??
    workspaceReviewOperation;
  const featuredOperation: SetupOperation = nextOperation ?? {
    id: "workspace-ready",
    phase: "Ready",
    title: "Workspace setup is ready",
    detail:
      "Slack, policy, models, and runtime configuration are ready for governed workspace use.",
    status: "ready",
    complete: true,
    facts: ["All required setup facts are complete"],
    primaryAction: { label: "Open overview", route: "/" },
    secondaryAction: { label: "Open runs", route: "/runs" },
  };
  const githubPreview = operations.find(
    (operation) => operation.id === "github-preview",
  );

  return (
    <div className="page">
      <PageHeader
        eyebrow="Setup"
        title="Bring @bek online one real operation at a time."
        description="Use the facts already reported by the API to unlock admin access, validate the local demo, connect Slack, and finish the policy needed for workspace use."
      />
      <section className="metrics">
        <MetricCard
          icon={<ShieldCheck />}
          label="Visible teammate"
          value={setupStatus.visibleHandle}
          detail={
            setupStatus.singleVisibleAgent
              ? "One visible @bek"
              : "Needs @bek handle repair"
          }
        />
        <MetricCard
          icon={<Server />}
          label="Setup progress"
          value={`${progress.complete}/${progress.total}`}
          detail={
            setupReady
              ? "Workspace ready"
              : setupStatus.readyForLocalDemo
                ? "Local demo ready"
                : "Finish required steps"
          }
        />
        <MetricCard
          icon={<KeyRound />}
          label="Pending approvals"
          value={String(setupStatus.pendingApprovals)}
          detail="Human gate for risky work"
        />
      </section>
      <section className="setup-overview">
        <Panel
          title={setupReady ? "Ready for workspace" : "Next operation"}
          action={<StatusBadge value={setupReady ? "ready" : "needs setup"} />}
        >
          <div className="setup-next-action">
            <span className="setup-phase">{featuredOperation.phase}</span>
            <div>
              <strong>{featuredOperation.title}</strong>
              <p className="muted">{featuredOperation.detail}</p>
            </div>
            <div className="row-actions">
              <Link
                to={featuredOperation.primaryAction.route}
                className="primary"
              >
                {featuredOperation.primaryAction.label}
                <ExternalLink size={14} aria-hidden="true" />
              </Link>
              {featuredOperation.secondaryAction ? (
                <Link
                  to={featuredOperation.secondaryAction.route}
                  className="secondary"
                >
                  {featuredOperation.secondaryAction.label}
                </Link>
              ) : null}
            </div>
          </div>
        </Panel>
        <Panel title="Guardrails">
          <div className="bundle-list">
            {visibleHandleAntiPatterns.map((item) => (
              <div className="bundle danger-outline" key={item}>
                <strong>{item}</strong>
                <span>
                  Teams should not need to choose the right bot before asking
                  for help.
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </section>
      <Panel title="Operations checklist">
        <div className="setup-operation-list">
          {operations
            .filter((operation) => operation.id !== "github-preview")
            .map((operation) => (
              <SetupOperationCard operation={operation} key={operation.id} />
            ))}
        </div>
      </Panel>
      {githubPreview ? (
        <Panel
          title="GitHub preview"
          action={<StatusBadge value={githubPreview.status} />}
        >
          <div className="setup-preview">
            <GitPullRequest size={22} aria-hidden="true" />
            <div>
              <strong>{githubPreview.title}</strong>
              <p className="muted">{githubPreview.detail}</p>
              <div className="chips">
                {githubPreview.facts.map((fact) => (
                  <span className="chip" key={fact}>
                    {fact}
                  </span>
                ))}
              </div>
            </div>
            <Link to={githubPreview.primaryAction.route} className="secondary">
              {githubPreview.primaryAction.label}
              <ExternalLink size={14} aria-hidden="true" />
            </Link>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function SetupOperationCard({ operation }: { operation: SetupOperation }) {
  return (
    <article
      className={
        operation.complete
          ? "setup-operation complete"
          : "setup-operation attention"
      }
    >
      <div className="setup-operation-marker" aria-hidden="true">
        {operation.complete ? <Check size={16} /> : <Clock size={16} />}
      </div>
      <div className="setup-operation-body">
        <div className="setup-operation-heading">
          <span className="setup-phase">{operation.phase}</span>
          <StatusBadge value={operation.status} />
        </div>
        <strong>{operation.title}</strong>
        <p className="muted">{operation.detail}</p>
        <div className="chips">
          {operation.facts.map((fact) => (
            <span
              className={operation.complete ? "chip" : "chip warning-chip"}
              key={fact}
            >
              {fact}
            </span>
          ))}
        </div>
      </div>
      <div className="setup-operation-actions">
        <Link to={operation.primaryAction.route} className="inline-link">
          {operation.primaryAction.label}
          <ExternalLink size={13} aria-hidden="true" />
        </Link>
        {operation.secondaryAction ? (
          <Link to={operation.secondaryAction.route} className="inline-link">
            {operation.secondaryAction.label}
          </Link>
        ) : null}
      </div>
    </article>
  );
}

export function ChannelsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });
  const [channelName, setChannelName] = useState("");
  const [externalId, setExternalId] = useState("");
  const [externalTeamId, setExternalTeamId] = useState("");
  const [sensitivity, setSensitivity] = useState("internal");
  const discoveryMutation = useMutation({
    mutationFn: () => discoverSlackChannels({ limit: 100 }),
  });
  const createChannelMutation = useMutation({
    mutationFn: createChannel,
    onSuccess: () => {
      setChannelName("");
      setExternalId("");
      setExternalTeamId("");
      setSensitivity("internal");
      return queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
  });

  if (isLoading) return <div className="state">Loading channels...</div>;
  if (error || !data)
    return <div className="state error">Bek API is not reachable.</div>;

  const trimmedChannelName = channelName.trim();
  const trimmedExternalId = externalId.trim();
  const installedSlackTeamId = activeSlackWorkspaceId(data);
  const trimmedExternalTeamId = externalTeamId.trim() || installedSlackTeamId;
  const canCreate =
    trimmedChannelName.length > 0 &&
    trimmedExternalId.length > 0 &&
    !createChannelMutation.isPending;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Channel scopes"
        title="Decide what @bek can do in each place."
      />
      <Panel
        title="Discover Slack Channels"
        action={
          <button
            className="secondary"
            disabled={discoveryMutation.isPending}
            aria-busy={discoveryMutation.isPending}
            onClick={() => discoveryMutation.mutate()}
          >
            <RefreshCw size={16} aria-hidden="true" />
            {discoveryMutation.isPending ? "Discovering..." : "Discover"}
          </button>
        }
      >
        {discoveryMutation.isError ? (
          <WarningCallout>
            {errorMessage(
              discoveryMutation.error,
              "Bek could not discover Slack channels.",
            )}
          </WarningCallout>
        ) : null}
        {discoveryMutation.data ? (
          <SlackDiscoveryResults
            channels={discoveryMutation.data.channels}
            data={data}
            isCreating={createChannelMutation.isPending}
            teamId={
              discoveryMutation.data.teamId ?? installedSlackTeamId ?? null
            }
            workspaceName={discoveryMutation.data.workspaceName ?? null}
            onImport={(channel) => {
              createChannelMutation.mutate({
                name: channel.name,
                externalId: channel.id,
                ...(discoveryMutation.data.teamId
                  ? { externalTeamId: discoveryMutation.data.teamId }
                  : {}),
                sensitivity: channel.isPrivate ? "confidential" : "internal",
              });
            }}
          />
        ) : discoveryMutation.isError ? null : (
          <EmptyState
            title="No discovery run"
            body="Install Slack or set SLACK_BOT_TOKEN to import channels from the workspace."
          />
        )}
      </Panel>
      <Panel title="Add Slack Channel Scope">
        {createChannelMutation.isError ? (
          <WarningCallout>
            {errorMessage(
              createChannelMutation.error,
              "Bek could not create that channel scope.",
            )}
          </WarningCallout>
        ) : null}
        {createChannelMutation.isSuccess ? (
          <SuccessCallout>Channel scope created.</SuccessCallout>
        ) : null}
        <form
          className="settings-grid"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canCreate) return;
            createChannelMutation.mutate({
              name: trimmedChannelName,
              externalId: trimmedExternalId,
              ...(trimmedExternalTeamId
                ? { externalTeamId: trimmedExternalTeamId }
                : {}),
              sensitivity,
            });
          }}
        >
          <label>
            Channel name
            <input
              value={channelName}
              required
              placeholder="#eng-product"
              onChange={(event) => setChannelName(event.target.value)}
            />
          </label>
          <label>
            Slack channel ID
            <input
              value={externalId}
              required
              placeholder="C0123456789"
              onChange={(event) => setExternalId(event.target.value)}
            />
          </label>
          <label>
            Slack workspace ID
            <input
              value={externalTeamId}
              placeholder={installedSlackTeamId ?? "T0123456789"}
              onChange={(event) => setExternalTeamId(event.target.value)}
            />
            <span className="field-hint">
              Bek uses this with the channel ID when routing Slack callbacks.
            </span>
          </label>
          <label>
            Sensitivity
            <select
              value={sensitivity}
              onChange={(event) => setSensitivity(event.target.value)}
            >
              <option value="public">public</option>
              <option value="internal">internal</option>
              <option value="confidential">confidential</option>
              <option value="restricted">restricted</option>
            </select>
          </label>
          <div className="form-actions">
            <button
              className="primary"
              disabled={!canCreate}
              aria-busy={createChannelMutation.isPending}
            >
              {createChannelMutation.isPending ? "Adding..." : "Add Channel"}
            </button>
          </div>
        </form>
      </Panel>
      <section className="channel-grid">
        {data.places.length === 0 ? (
          <EmptyState
            title="No channel scopes"
            body="Connect Slack and choose a pilot channel to scope Bek access."
          />
        ) : (
          data.places.map((place) => {
            const bundles = bundlesForPlace(data.accessBundles, place.id);
            const runs = data.runs.filter(
              (run) => run.placeScopeId === place.id,
            );
            return (
              <Panel
                key={place.id}
                title={place.name}
                action={
                  <Link
                    to="/channels/$channelId"
                    params={{ channelId: place.id }}
                    className="secondary"
                  >
                    Details
                    <ExternalLink size={14} aria-hidden="true" />
                  </Link>
                }
              >
                <div className="meta-row">
                  <StatusBadge value={place.sensitivity} />
                  <span>{place.externalId}</span>
                </div>
                <div className="bundle-list">
                  {bundles.length === 0 ? (
                    <EmptyState
                      title="No bundles attached"
                      body="Attach an access bundle before Bek can act here."
                    />
                  ) : (
                    bundles.map((bundle) => (
                      <div className="bundle" key={bundle.id}>
                        <strong>{bundle.name}</strong>
                        <span>{bundle.grants.length} grants attached</span>
                      </div>
                    ))
                  )}
                </div>
                <p className="muted">{runs.length} runs from this place</p>
              </Panel>
            );
          })
        )}
      </section>
    </div>
  );
}

function SlackDiscoveryResults({
  channels,
  data,
  isCreating,
  teamId,
  workspaceName,
  onImport,
}: {
  channels: DiscoveredSlackChannel[];
  data: Bootstrap;
  isCreating: boolean;
  teamId: string | null;
  workspaceName: string | null;
  onImport: (channel: DiscoveredSlackChannel) => void;
}) {
  const configuredExternalIds = new Set(
    data.places.flatMap((place) => {
      const teamId = slackPlaceTeamId(place);
      return teamId
        ? [place.externalId, `${teamId}:${place.externalId}`]
        : [place.externalId];
    }),
  );
  const discoveryLabel = workspaceName ?? teamId ?? "Slack workspace";
  return (
    <div className="discovery-results">
      <div className="split-row">
        <div>
          <strong>{discoveryLabel}</strong>
          <span className="muted">{channels.length} channels found</span>
        </div>
      </div>
      {channels.length === 0 ? (
        <EmptyState
          title="No channels found"
          body="Bek did not receive any visible public or private channels."
        />
      ) : (
        <div className="table-scroll">
          <table>
            <caption className="sr-only">Discovered Slack channels</caption>
            <thead>
              <tr>
                <th scope="col">Channel</th>
                <th scope="col">Visibility</th>
                <th scope="col">Members</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => {
                const placeKey = teamId
                  ? `${teamId}:${channel.id}`
                  : channel.id;
                const alreadyConfigured =
                  channel.configured || configuredExternalIds.has(placeKey);
                const canImport =
                  channel.botIsMember && !alreadyConfigured && !isCreating;
                return (
                  <tr key={channel.id}>
                    <td data-label="Channel">
                      <strong>{channel.name}</strong>
                      <div className="muted">{channel.id}</div>
                    </td>
                    <td data-label="Visibility">
                      <StatusBadge
                        value={channel.isPrivate ? "private" : "public"}
                      />
                    </td>
                    <td data-label="Members">
                      {channel.numMembers === null
                        ? "Unknown"
                        : channel.numMembers}
                    </td>
                    <td data-label="Status">
                      {alreadyConfigured ? (
                        <StatusBadge value="configured" />
                      ) : channel.botIsMember ? (
                        <StatusBadge value="ready" />
                      ) : (
                        <StatusBadge value="not joined" />
                      )}
                    </td>
                    <td data-label="Action">
                      <button
                        className="secondary"
                        disabled={!canImport}
                        title={
                          channel.botIsMember
                            ? alreadyConfigured
                              ? "Already added"
                              : "Add channel"
                            : "Invite Bek to this channel first"
                        }
                        onClick={() => onImport(channel)}
                      >
                        <Plus size={16} aria-hidden="true" />
                        {alreadyConfigured
                          ? "Added"
                          : channel.botIsMember
                            ? "Add"
                            : "Invite first"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function slackPlaceTeamId(place: Bootstrap["places"][number]) {
  const rawTeamId = place.metadata?.teamId ?? place.metadata?.slackTeamId;
  return typeof rawTeamId === "string" && rawTeamId.trim()
    ? rawTeamId.trim()
    : undefined;
}

export function AccessBundlesPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });
  const [bundleName, setBundleName] = useState("");
  const [bundleDescription, setBundleDescription] = useState("");
  const [attachedPlaceId, setAttachedPlaceId] = useState("");
  const createBundleMutation = useMutation({
    mutationFn: createAccessBundle,
    onSuccess: () => {
      setBundleName("");
      setBundleDescription("");
      setAttachedPlaceId("");
      return queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
  });

  if (isLoading) return <div className="state">Loading access bundles...</div>;
  if (error || !data)
    return <div className="state error">Bek API is not reachable.</div>;

  const trimmedBundleName = bundleName.trim();
  const trimmedBundleDescription = bundleDescription.trim();
  const canCreate =
    trimmedBundleName.length > 0 &&
    trimmedBundleDescription.length > 0 &&
    !createBundleMutation.isPending;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Access bundles"
        title="Bundle tools, repos, models, and approvals by place."
      />
      <Panel title="Create Access Bundle">
        {createBundleMutation.isError ? (
          <WarningCallout>
            {errorMessage(
              createBundleMutation.error,
              "Bek could not create that access bundle.",
            )}
          </WarningCallout>
        ) : null}
        {createBundleMutation.isSuccess ? (
          <SuccessCallout>Access bundle created.</SuccessCallout>
        ) : null}
        <form
          className="settings-grid"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canCreate) return;
            createBundleMutation.mutate({
              name: trimmedBundleName,
              description: trimmedBundleDescription,
              attachedPlaceIds: attachedPlaceId ? [attachedPlaceId] : [],
            });
          }}
        >
          <label>
            Bundle name
            <input
              value={bundleName}
              required
              placeholder="Engineering triage"
              onChange={(event) => setBundleName(event.target.value)}
            />
          </label>
          <label>
            Description
            <input
              value={bundleDescription}
              required
              placeholder="Governed @bek access for this team"
              onChange={(event) => setBundleDescription(event.target.value)}
            />
          </label>
          <label>
            Attach place
            <select
              value={attachedPlaceId}
              onChange={(event) => setAttachedPlaceId(event.target.value)}
            >
              <option value="">No place yet</option>
              {data.places.map((place) => (
                <option value={place.id} key={place.id}>
                  {place.name}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button
              className="primary"
              disabled={!canCreate}
              aria-busy={createBundleMutation.isPending}
            >
              {createBundleMutation.isPending ? "Creating..." : "Create Bundle"}
            </button>
          </div>
        </form>
      </Panel>
      {data.accessBundles.length === 0 ? (
        <EmptyState
          title="No access bundles"
          body="Create a bundle to define what Bek can do in each place."
        />
      ) : (
        <div className="bundle-board">
          {data.accessBundles.map((bundle) => (
            <AccessBundleSummaryCard
              data={data}
              bundle={bundle}
              key={bundle.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AccessBundleSummaryCard({
  data,
  bundle,
}: {
  data: Bootstrap;
  bundle: AccessBundle;
}) {
  const grouped = grantsByDecision(bundle.grants);
  const attachedPlaces = data.places.filter((place) =>
    bundle.attachedPlaceIds.includes(place.id),
  );
  return (
    <Panel
      title={bundle.name}
      action={
        <Link
          to="/access-bundles/$bundleId"
          params={{ bundleId: bundle.id }}
          className="secondary"
        >
          Details
          <ExternalLink size={14} aria-hidden="true" />
        </Link>
      }
    >
      <p className="muted">{bundle.description}</p>
      <div className="split-row">
        <div>
          <span className="muted">Attached places</span>
          <strong>{attachedPlaces.length}</strong>
        </div>
        <div>
          <span className="muted">Grants</span>
          <strong>{bundle.grants.length}</strong>
        </div>
        <div>
          <span className="muted">Approval gates</span>
          <strong>{grouped.ask.length}</strong>
        </div>
      </div>
      <div className="chips">
        {attachedPlaces.length === 0 ? (
          <span className="chip warning-chip">No place attached</span>
        ) : (
          attachedPlaces.map((place) => (
            <span className="chip" key={place.id}>
              {place.name}
            </span>
          ))
        )}
      </div>
    </Panel>
  );
}

function AccessBundleEditor({
  data,
  bundle,
}: {
  data: Bootstrap;
  bundle: AccessBundle;
}) {
  const queryClient = useQueryClient();
  const [capability, setCapability] = useState("github.read");
  const [resource, setResource] = useState("github:redohq/checkout");
  const [decision, setDecision] = useState<"allow" | "ask" | "deny">("allow");
  const [risk, setRisk] = useState("read_internal");
  const [placeId, setPlaceId] = useState("");
  const createGrantMutation = useMutation({
    mutationFn: createGrant,
    onSuccess: () => {
      setResource("");
      return queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
  });
  const attachMutation = useMutation({
    mutationFn: attachBundleToPlace,
    onSuccess: () => {
      setPlaceId("");
      return queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
  });
  const grouped = grantsByDecision(bundle.grants);
  const attachedPlaces = data.places.filter((place) =>
    bundle.attachedPlaceIds.includes(place.id),
  );
  const availablePlaces = data.places.filter(
    (place) => !bundle.attachedPlaceIds.includes(place.id),
  );
  const trimmedResource = resource.trim();
  const canAttach = placeId.length > 0 && !attachMutation.isPending;
  const canAddGrant =
    trimmedResource.length > 0 && !createGrantMutation.isPending;

  return (
    <Panel title={bundle.name}>
      <p className="muted">{bundle.description}</p>
      {attachMutation.isError ? (
        <WarningCallout>
          {errorMessage(
            attachMutation.error,
            "Bek could not attach that place.",
          )}
        </WarningCallout>
      ) : null}
      {attachMutation.isSuccess ? (
        <SuccessCallout>Place attached to this bundle.</SuccessCallout>
      ) : null}
      {createGrantMutation.isError ? (
        <WarningCallout>
          {errorMessage(
            createGrantMutation.error,
            "Bek could not create that grant.",
          )}
        </WarningCallout>
      ) : null}
      {createGrantMutation.isSuccess ? (
        <SuccessCallout>Grant added to this bundle.</SuccessCallout>
      ) : null}
      <div className="chips">
        {attachedPlaces.length === 0 ? (
          <span className="chip warning-chip">No place attached</span>
        ) : (
          attachedPlaces.map((place) => (
            <Link
              to="/channels/$channelId"
              params={{ channelId: place.id }}
              className="chip chip-link"
              key={place.id}
            >
              {place.name}
            </Link>
          ))
        )}
      </div>
      <div className="settings-grid compact-form">
        <label>
          Attach place
          <select
            value={placeId}
            disabled={availablePlaces.length === 0}
            onChange={(event) => setPlaceId(event.target.value)}
          >
            <option value="">Choose place</option>
            {availablePlaces.map((place) => (
              <option value={place.id} key={place.id}>
                {place.name}
              </option>
            ))}
          </select>
          {availablePlaces.length === 0 ? (
            <span className="field-hint">All places are already attached.</span>
          ) : null}
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={!canAttach}
            aria-busy={attachMutation.isPending}
            onClick={() =>
              attachMutation.mutate({ bundleId: bundle.id, placeId })
            }
          >
            {attachMutation.isPending ? "Attaching..." : "Attach"}
          </button>
        </div>
      </div>
      <form
        className="settings-grid compact-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canAddGrant) return;
          createGrantMutation.mutate({
            bundleId: bundle.id,
            capability,
            resource: trimmedResource,
            decision,
            risk,
            requiresApproval: decision === "ask",
          });
        }}
      >
        <label>
          Capability
          <select
            value={capability}
            onChange={(event) => setCapability(event.target.value)}
          >
            <option value="slack.read">slack.read</option>
            <option value="github.read">github.read</option>
            <option value="github.pr">github.pr</option>
            <option value="mcp.tool">mcp.tool</option>
            <option value="sandbox.exec">sandbox.exec</option>
            <option value="model.call">model.call</option>
          </select>
        </label>
        <label>
          Resource
          <input
            value={resource}
            required
            placeholder="github:org/repo"
            onChange={(event) => setResource(event.target.value)}
          />
        </label>
        <label>
          Decision
          <select
            value={decision}
            onChange={(event) =>
              setDecision(event.target.value as "allow" | "ask" | "deny")
            }
          >
            <option value="allow">allow</option>
            <option value="ask">ask</option>
            <option value="deny">deny</option>
          </select>
        </label>
        <label>
          Risk
          <select
            value={risk}
            onChange={(event) => setRisk(event.target.value)}
          >
            <option value="read_internal">read_internal</option>
            <option value="write_draft">write_draft</option>
            <option value="write_external">write_external</option>
            <option value="privileged">privileged</option>
          </select>
        </label>
        <div className="form-actions">
          <button
            className="secondary"
            disabled={!canAddGrant}
            aria-busy={createGrantMutation.isPending}
          >
            {createGrantMutation.isPending ? "Adding..." : "Add Grant"}
          </button>
        </div>
      </form>
      <div className="grant-columns">
        {(["allow", "ask", "deny"] as const).map((decision) => (
          <div className="grant-column" key={decision}>
            <DecisionBadge value={decision} />
            {grouped[decision].length === 0 ? (
              <span className="muted">No grants</span>
            ) : null}
            {grouped[decision].map((grant) => (
              <div className="grant" key={grant.id}>
                <strong>{grant.capability}</strong>
                <span>{grant.resource}</span>
                <RiskBadge value={grant.risk} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function ChannelDetailPage() {
  const { channelId } = useParams({ from: "/channels/$channelId" });
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });
  const place = data ? findPlace(data, channelId) : undefined;
  const [name, setName] = useState("");
  const [externalId, setExternalId] = useState("");
  const [externalTeamId, setExternalTeamId] = useState("");
  const [sensitivity, setSensitivity] = useState("internal");
  const [bundleId, setBundleId] = useState("");
  const updateMutation = useMutation({
    mutationFn: updateChannel,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
  });
  const attachMutation = useMutation({
    mutationFn: attachBundleToPlace,
    onSuccess: () => {
      setBundleId("");
      return queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
  });

  useEffect(() => {
    if (!place) return;
    setName(place.name);
    setExternalId(place.externalId);
    setExternalTeamId(slackTeamIdForPlace(place) ?? "");
    setSensitivity(place.sensitivity);
  }, [place]);

  if (isLoading) return <div className="state">Loading channel...</div>;
  if (error || !data)
    return <div className="state error">Bek API is not reachable.</div>;
  if (!place) {
    return (
      <div className="page">
        <PageHeader
          eyebrow="Channel detail"
          title="Channel scope not found."
          actions={
            <Link to="/channels" className="secondary">
              <ArrowLeft size={16} aria-hidden="true" />
              Channels
            </Link>
          }
        />
        <EmptyState
          title="No matching channel"
          body="The channel may have been removed or the route is stale."
        />
      </div>
    );
  }

  const bundles = bundlesForPlace(data.accessBundles, place.id);
  const availableBundles = data.accessBundles.filter(
    (bundle) => !bundle.attachedPlaceIds.includes(place.id),
  );
  const runs = data.runs.filter((run) => run.placeScopeId === place.id);
  const trimmedName = name.trim();
  const trimmedExternalId = externalId.trim();
  const installedSlackTeamId = activeSlackWorkspaceId(data);
  const trimmedExternalTeamId = externalTeamId.trim() || installedSlackTeamId;
  const canSave =
    trimmedName.length > 0 &&
    trimmedExternalId.length > 0 &&
    !updateMutation.isPending;
  const canAttach = bundleId.length > 0 && !attachMutation.isPending;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Channel detail"
        title={place.name}
        description="Tune the Slack place where teammates ask @bek for help, then attach only the bundles that should apply here."
        actions={
          <Link to="/channels" className="secondary">
            <ArrowLeft size={16} aria-hidden="true" />
            Channels
          </Link>
        }
      />
      <section className="metrics">
        <MetricCard
          icon={<Slack />}
          label="Slack ID"
          value={place.externalId}
          detail={place.kind.replaceAll("_", " ")}
        />
        <MetricCard
          icon={<ShieldCheck />}
          label="Bundles"
          value={String(bundles.length)}
          detail="Policy attached here"
        />
        <MetricCard
          icon={<Clock />}
          label="Runs"
          value={String(runs.length)}
          detail="Auditable work from this place"
        />
      </section>
      <section className="grid">
        <Panel title="Channel settings">
          {updateMutation.isError ? (
            <WarningCallout>
              {errorMessage(
                updateMutation.error,
                "Bek could not save channel settings.",
              )}
            </WarningCallout>
          ) : null}
          {updateMutation.isSuccess ? (
            <SuccessCallout>Channel settings saved.</SuccessCallout>
          ) : null}
          <form
            className="settings-grid compact-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSave) return;
              updateMutation.mutate({
                channelId: place.id,
                name: trimmedName,
                externalId: trimmedExternalId,
                ...(trimmedExternalTeamId
                  ? { externalTeamId: trimmedExternalTeamId }
                  : {}),
                sensitivity,
              });
            }}
          >
            <label>
              Channel name
              <input
                value={name}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              Slack channel ID
              <input
                value={externalId}
                required
                onChange={(event) => setExternalId(event.target.value)}
              />
            </label>
            <label>
              Slack workspace ID
              <input
                value={externalTeamId}
                placeholder={installedSlackTeamId ?? "T0123456789"}
                onChange={(event) => setExternalTeamId(event.target.value)}
              />
              <span className="field-hint">
                Keep this aligned with the workspace that installed Bek.
              </span>
            </label>
            <label>
              Sensitivity
              <select
                value={sensitivity}
                onChange={(event) => setSensitivity(event.target.value)}
              >
                <option value="public">public</option>
                <option value="internal">internal</option>
                <option value="confidential">confidential</option>
                <option value="restricted">restricted</option>
              </select>
            </label>
            <div className="form-actions">
              <button
                className="primary"
                disabled={!canSave}
                aria-busy={updateMutation.isPending}
              >
                {updateMutation.isPending ? "Saving..." : "Save Channel"}
              </button>
            </div>
          </form>
        </Panel>
        <Panel title="Attach access">
          {attachMutation.isError ? (
            <WarningCallout>
              {errorMessage(
                attachMutation.error,
                "Bek could not attach that bundle.",
              )}
            </WarningCallout>
          ) : null}
          {attachMutation.isSuccess ? (
            <SuccessCallout>Access bundle attached.</SuccessCallout>
          ) : null}
          <div className="settings-grid compact-form">
            <label>
              Access bundle
              <select
                value={bundleId}
                disabled={availableBundles.length === 0}
                onChange={(event) => setBundleId(event.target.value)}
              >
                <option value="">Choose bundle</option>
                {availableBundles.map((bundle) => (
                  <option value={bundle.id} key={bundle.id}>
                    {bundle.name}
                  </option>
                ))}
              </select>
              {availableBundles.length === 0 ? (
                <span className="field-hint">
                  Every bundle is already attached here.
                </span>
              ) : null}
            </label>
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                disabled={!canAttach}
                aria-busy={attachMutation.isPending}
                onClick={() =>
                  attachMutation.mutate({ bundleId, placeId: place.id })
                }
              >
                {attachMutation.isPending ? "Attaching..." : "Attach Bundle"}
              </button>
            </div>
          </div>
          <div className="bundle-list">
            {bundles.length === 0 ? (
              <EmptyState
                title="No bundles attached"
                body="Attach a bundle before @bek can act in this channel."
              />
            ) : (
              bundles.map((bundle) => (
                <Link
                  to="/access-bundles/$bundleId"
                  params={{ bundleId: bundle.id }}
                  className="bundle link-card"
                  key={bundle.id}
                >
                  <strong>{bundle.name}</strong>
                  <span>{bundle.grants.length} grants attached</span>
                </Link>
              ))
            )}
          </div>
        </Panel>
      </section>
      <Panel title="Runs from this channel">
        <RunsTable
          data={data}
          runs={runs}
          emptyTitle="No runs from this channel"
          emptyBody="Runs will appear here after someone asks @bek to work in this place."
        />
      </Panel>
    </div>
  );
}

export function AccessBundleDetailPage() {
  const { bundleId } = useParams({ from: "/access-bundles/$bundleId" });
  const { data, isLoading, error } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });

  if (isLoading) return <div className="state">Loading access bundle...</div>;
  if (error || !data)
    return <div className="state error">Bek API is not reachable.</div>;

  const bundle = data.accessBundles.find(
    (candidate) => candidate.id === bundleId,
  );
  if (!bundle) {
    return (
      <div className="page">
        <PageHeader
          eyebrow="Access detail"
          title="Access bundle not found."
          actions={
            <Link to="/access-bundles" className="secondary">
              <ArrowLeft size={16} aria-hidden="true" />
              Access
            </Link>
          }
        />
        <EmptyState
          title="No matching bundle"
          body="The bundle may have been removed or the route is stale."
        />
      </div>
    );
  }

  const attachedPlaces = data.places.filter((place) =>
    bundle.attachedPlaceIds.includes(place.id),
  );
  const grouped = grantsByDecision(bundle.grants);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Access detail"
        title={bundle.name}
        description={bundle.description}
        actions={
          <Link to="/access-bundles" className="secondary">
            <ArrowLeft size={16} aria-hidden="true" />
            Access
          </Link>
        }
      />
      <section className="metrics">
        <MetricCard
          icon={<ShieldCheck />}
          label="Attached places"
          value={String(attachedPlaces.length)}
          detail="Slack scopes governed"
        />
        <MetricCard
          icon={<KeyRound />}
          label="Approval gates"
          value={String(grouped.ask.length)}
          detail="Ask before action"
        />
        <MetricCard
          icon={<Route />}
          label="Total grants"
          value={String(bundle.grants.length)}
          detail="Allow, ask, and deny"
        />
      </section>
      <AccessBundleEditor data={data} bundle={bundle} />
    </div>
  );
}

export function ApprovalsPage() {
  const queryClient = useQueryClient();
  const [confirmationApprovalId, setConfirmationApprovalId] = useState<
    string | undefined
  >();
  const { data, isLoading, error } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });
  const decisionMutation = useMutation({
    mutationFn: decideApproval,
    onSuccess: () => {
      setConfirmationApprovalId(undefined);
      return queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
  });

  if (isLoading) return <div className="state">Loading approvals...</div>;
  if (error || !data)
    return <div className="state error">Bek API is not reachable.</div>;

  const approvalContexts = sortedApprovalContexts(data);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Human gates"
        title="Risky Bek actions wait for approval."
      />
      <Panel>
        {decisionMutation.isError ? (
          <WarningCallout>
            {errorMessage(
              decisionMutation.error,
              "Bek could not save that approval decision. Try again.",
            )}
          </WarningCallout>
        ) : null}
        {decisionMutation.isSuccess ? (
          <SuccessCallout>Approval decision saved.</SuccessCallout>
        ) : null}
        {approvalContexts.length === 0 ? (
          <EmptyState
            title="No approvals yet"
            body="Trigger the demo PR run to see a write_external approval."
          />
        ) : (
          <div className="table-scroll">
            <table className="responsive-table wide-table">
              <caption className="sr-only">Bek approval requests</caption>
              <thead>
                <tr>
                  <th scope="col">Action</th>
                  <th scope="col">Risk</th>
                  <th scope="col">Status</th>
                  <th scope="col">Run</th>
                  <th scope="col">Place</th>
                  <th scope="col">Requester</th>
                  <th scope="col">Payload Hash</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {approvalContexts.map((context) => (
                  <ApprovalRow
                    context={context}
                    confirmationPending={
                      confirmationApprovalId === context.approval.id
                    }
                    isDisabled={decisionMutation.isPending}
                    pendingDecision={
                      decisionMutation.variables?.approvalId ===
                      context.approval.id
                        ? decisionMutation.variables.decision
                        : undefined
                    }
                    onCancelConfirmation={() =>
                      setConfirmationApprovalId(undefined)
                    }
                    onDecision={(decision) => {
                      if (
                        decision === "approve" &&
                        isHighRiskApproval(context.approval) &&
                        confirmationApprovalId !== context.approval.id
                      ) {
                        setConfirmationApprovalId(context.approval.id);
                        return;
                      }
                      decisionMutation.mutate({
                        approvalId: context.approval.id,
                        decision,
                        principalId: "principal_admin",
                        payloadHash: context.approval.payloadHash,
                      });
                    }}
                    key={context.approval.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

type ApprovalContext = {
  approval: ApprovalRequest;
  run: Run | undefined;
  place: Bootstrap["places"][number] | undefined;
  requester: NonNullable<Bootstrap["principals"]>[number] | undefined;
};

function ApprovalRow({
  context,
  confirmationPending,
  isDisabled,
  pendingDecision,
  onCancelConfirmation,
  onDecision,
}: {
  context: ApprovalContext;
  confirmationPending: boolean;
  isDisabled: boolean;
  pendingDecision: "approve" | "deny" | undefined;
  onCancelConfirmation: () => void;
  onDecision: (decision: "approve" | "deny") => void;
}) {
  const { approval, run, place, requester } = context;
  const approvePending = pendingDecision === "approve";
  const denyPending = pendingDecision === "deny";
  const highRisk = isHighRiskApproval(approval);
  return (
    <tr>
      <td data-label="Action">{approval.action}</td>
      <td data-label="Risk">
        <RiskBadge value={approval.risk} />
      </td>
      <td data-label="Status">
        <StatusBadge value={approval.status} />
      </td>
      <td data-label="Run">
        {run ? (
          <div>
            <RunLink run={run} />
            <div className="muted">{run.status.replaceAll("_", " ")}</div>
          </div>
        ) : (
          <span className="muted">{approval.runId}</span>
        )}
      </td>
      <td data-label="Place">
        {place ? (
          <div>
            <strong>{place.name}</strong>
            <div className="muted">
              {place.provider}:{place.externalId}
            </div>
          </div>
        ) : (
          <span className="muted">Unknown place</span>
        )}
      </td>
      <td data-label="Requester">
        {requester ? (
          <div>
            <strong>{requester.displayName}</strong>
            <div className="muted">{requester.id}</div>
          </div>
        ) : (
          <span className="muted">{approval.requestedByPrincipalId}</span>
        )}
      </td>
      <td data-label="Payload Hash">
        <code>{shortHash(approval.payloadHash)}</code>
      </td>
      <td data-label="Expires">{formatDateTime(approval.expiresAt)}</td>
      <td data-label="Decision">
        {approval.status === "pending" ? (
          confirmationPending ? (
            <div>
              <p className="muted">
                Confirm {approval.action} for run {run?.id ?? approval.runId}{" "}
                with hash <code>{shortHash(approval.payloadHash)}</code>.
              </p>
              <div className="row-actions">
                <button
                  className={`icon-button${approvePending ? " pending" : ""}`}
                  aria-label={
                    approvePending
                      ? `Confirming ${approval.action}`
                      : `Confirm approval for ${approval.action}`
                  }
                  aria-busy={approvePending}
                  disabled={isDisabled}
                  title="Confirm approval"
                  onClick={() => onDecision("approve")}
                >
                  <Check size={16} aria-hidden="true" />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Cancel approval confirmation for ${approval.action}`}
                  disabled={isDisabled}
                  title="Cancel confirmation"
                  onClick={onCancelConfirmation}
                >
                  <CircleSlash size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : (
            <div className="row-actions">
              <button
                className={`icon-button${approvePending ? " pending" : ""}`}
                aria-label={
                  approvePending
                    ? `Approving ${approval.action}`
                    : highRisk
                      ? `Review approval for ${approval.action}`
                      : `Approve ${approval.action}`
                }
                aria-busy={approvePending}
                disabled={isDisabled}
                title={highRisk ? "Review approval" : "Approve"}
                onClick={() => onDecision("approve")}
              >
                <Check size={16} aria-hidden="true" />
              </button>
              <button
                className={`icon-button danger${denyPending ? " pending" : ""}`}
                aria-label={
                  denyPending
                    ? `Denying ${approval.action}`
                    : `Deny ${approval.action}`
                }
                aria-busy={denyPending}
                disabled={isDisabled}
                title="Deny"
                onClick={() => onDecision("deny")}
              >
                <CircleSlash size={16} aria-hidden="true" />
              </button>
            </div>
          )
        ) : (
          <span className="muted">decided</span>
        )}
      </td>
    </tr>
  );
}

function sortedApprovalContexts(data: Bootstrap): ApprovalContext[] {
  const principals = data.principals ?? [];
  return data.approvals
    .map((approval) => {
      const run = data.runs.find(
        (candidate) => candidate.id === approval.runId,
      );
      return {
        approval,
        run,
        place: run ? findRunPlace(data, run) : undefined,
        requester: principals.find(
          (principal) => principal.id === approval.requestedByPrincipalId,
        ),
      };
    })
    .sort((left, right) => {
      const statusDelta =
        approvalStatusSortRank(left.approval.status) -
        approvalStatusSortRank(right.approval.status);
      if (statusDelta !== 0) return statusDelta;
      const leftTime = Date.parse(
        left.approval.status === "pending"
          ? left.approval.expiresAt
          : left.approval.createdAt,
      );
      const rightTime = Date.parse(
        right.approval.status === "pending"
          ? right.approval.expiresAt
          : right.approval.createdAt,
      );
      return left.approval.status === "pending"
        ? leftTime - rightTime
        : rightTime - leftTime;
    });
}

function approvalStatusSortRank(status: ApprovalRequest["status"]): number {
  return status === "pending" ? 0 : 1;
}

function isHighRiskApproval(approval: ApprovalRequest): boolean {
  return approval.risk === "write_external" || approval.risk === "privileged";
}

function shortHash(hash: string): string {
  return hash.length > 24 ? `${hash.slice(0, 12)}...${hash.slice(-8)}` : hash;
}

export function ConnectorsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });
  const {
    data: setupStatus,
    isLoading: isSetupLoading,
    error: setupError,
  } = useQuery({
    queryKey: ["setupStatus"],
    queryFn: fetchSetupStatus,
  });
  const [pendingSlackInstallUrl, setPendingSlackInstallUrl] = useState("");
  const [slackPrincipalId, setSlackPrincipalId] = useState("");
  const [slackUserId, setSlackUserId] = useState("");
  const slackInstallMutation = useMutation({
    mutationFn: () => fetchSlackInstallStart("/connectors"),
    onSuccess: (install) => {
      if (install.exchangeEnabled && install.tokenStorageConfigured) {
        window.location.assign(install.url);
        return;
      }
      setPendingSlackInstallUrl(install.url);
    },
  });
  const slackIdentityMutation = useMutation({
    mutationFn: linkPrincipalExternalIdentity,
    onSuccess: () => {
      setSlackUserId("");
      return queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
  });
  const slackInstallResult = new URLSearchParams(window.location.search).get(
    "slack_install",
  );

  if (isLoading || isSetupLoading)
    return <div className="state">Loading connectors...</div>;
  if (error || setupError || !data || !setupStatus)
    return <div className="state error">Bek API is not reachable.</div>;

  const slackSummary = connectorSummaries(data).find(
    (connector) => connector.id === "slack",
  );
  const otherConnectors = connectorSummaries(data).filter(
    (connector) => connector.id !== "slack",
  );
  const humanPrincipals = (data.principals ?? []).filter(
    (principal) => principal.kind === "human",
  );
  const mappedSlackPrincipals = humanPrincipals.filter(
    (principal) => principal.externalProvider === "slack",
  );
  const selectedSlackPrincipalId =
    slackPrincipalId || humanPrincipals[0]?.id || "";
  const trimmedSlackUserId = slackUserId.trim();
  const slackTeamId = setupStatus.slackWorkspaceId;
  const canLinkSlackIdentity =
    Boolean(selectedSlackPrincipalId) &&
    Boolean(slackTeamId) &&
    trimmedSlackUserId.length > 0 &&
    !slackIdentityMutation.isPending;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Connectors"
        title="Slack, repos, MCP tools, sandboxes, and model providers plug into one agent."
      />
      {slackInstallResult === "installed" ? (
        <SuccessCallout>Slack workspace connected.</SuccessCallout>
      ) : slackInstallResult === "validated" ? (
        <WarningCallout>
          Slack returned successfully, but OAuth exchange is disabled.
        </WarningCallout>
      ) : slackInstallResult === "error" ? (
        <WarningCallout>
          Slack install returned with an error. Review OAuth and credential
          settings before trying again.
        </WarningCallout>
      ) : null}
      {slackSummary ? (
        <Panel
          title="Slack"
          action={<StatusBadge value={slackSummary.status} />}
        >
          {slackInstallMutation.isError ? (
            <WarningCallout>
              {errorMessage(
                slackInstallMutation.error,
                "Bek could not start Slack install.",
              )}
            </WarningCallout>
          ) : null}
          {pendingSlackInstallUrl ? (
            <WarningCallout>
              OAuth can start, but token exchange or local token storage is not
              fully enabled yet.
            </WarningCallout>
          ) : null}
          <div className="connector-card">
            <div className="connector-icon">
              <Slack size={20} aria-hidden="true" />
            </div>
            <div>
              <strong>{slackSummary.metric}</strong>
              <p className="muted">{slackSummary.detail}</p>
            </div>
          </div>
          <div className="summary-grid connector-detail-grid">
            <div className="summary-field">
              <span>Workspace</span>
              <strong>
                {setupStatus.slackWorkspaceName ??
                  setupStatus.slackWorkspaceId ??
                  "Not installed"}
              </strong>
              {setupStatus.slackWorkspaceId ? (
                <small>{setupStatus.slackWorkspaceId}</small>
              ) : null}
            </div>
            <div className="summary-field">
              <span>Install</span>
              <strong>{setupStatus.slackInstallStatus ?? "missing"}</strong>
              <small>OAuth workspace state</small>
            </div>
            <div className="summary-field">
              <span>Bot user</span>
              <strong>{setupStatus.slackBotUserId ?? "missing"}</strong>
              <small>Used for posting replies</small>
            </div>
            <div className="summary-field">
              <span>Token</span>
              <strong>
                {setupStatus.slackTokenStored ? "stored" : "missing"}
              </strong>
              <small>Encrypted local vault status</small>
            </div>
          </div>
          <section
            className="connector-subsection"
            aria-labelledby="slack-user-mapping-heading"
          >
            <h3 id="slack-user-mapping-heading">Slack User Mapping</h3>
            {slackIdentityMutation.isError ? (
              <WarningCallout>
                {errorMessage(
                  slackIdentityMutation.error,
                  "Bek could not link that Slack user.",
                )}
              </WarningCallout>
            ) : null}
            {slackIdentityMutation.isSuccess ? (
              <SuccessCallout>Slack user linked to principal.</SuccessCallout>
            ) : null}
            <form
              className="settings-grid compact-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!canLinkSlackIdentity || !slackTeamId) return;
                slackIdentityMutation.mutate({
                  principalId: selectedSlackPrincipalId,
                  externalProvider: "slack",
                  externalId: `${slackTeamId}:${trimmedSlackUserId}`,
                  metadata: {
                    teamId: slackTeamId,
                    slackUserId: trimmedSlackUserId,
                  },
                });
              }}
            >
              <label>
                Bek principal
                <select
                  value={selectedSlackPrincipalId}
                  onChange={(event) => setSlackPrincipalId(event.target.value)}
                >
                  {humanPrincipals.map((principal) => (
                    <option value={principal.id} key={principal.id}>
                      {principal.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Slack user ID
                <input
                  value={slackUserId}
                  placeholder="U0123456789"
                  onChange={(event) => setSlackUserId(event.target.value)}
                />
                <span className="field-hint">
                  Bek stores this as {slackTeamId ?? "workspace"}:user for
                  callback approvals and mentions.
                </span>
              </label>
              <div className="form-actions">
                <button
                  className="primary"
                  disabled={!canLinkSlackIdentity}
                  aria-busy={slackIdentityMutation.isPending}
                >
                  {slackIdentityMutation.isPending ? "Linking..." : "Link User"}
                </button>
              </div>
            </form>
            {mappedSlackPrincipals.length > 0 ? (
              <div className="bundle-list">
                {mappedSlackPrincipals.map((principal) => (
                  <div className="bundle" key={principal.id}>
                    <strong>{principal.displayName}</strong>
                    <span>{principal.externalId}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No Slack users mapped"
                body="Map approvers and requesters before real Slack approvals."
              />
            )}
          </section>
          <div className="form-actions connector-actions">
            <button
              type="button"
              className="primary"
              disabled={slackInstallMutation.isPending}
              aria-busy={slackInstallMutation.isPending}
              onClick={() => {
                if (pendingSlackInstallUrl) {
                  window.location.assign(pendingSlackInstallUrl);
                  return;
                }
                slackInstallMutation.mutate();
              }}
            >
              {slackInstallMutation.isPending
                ? "Preparing..."
                : pendingSlackInstallUrl
                  ? "Continue to Slack"
                  : setupStatus.slackInstalled
                    ? "Reinstall Slack"
                    : "Connect Slack"}
            </button>
            <Link to="/channels" className="secondary">
              Manage channels
              <ExternalLink size={14} aria-hidden="true" />
            </Link>
          </div>
        </Panel>
      ) : null}
      <section className="connector-grid">
        {otherConnectors.map((connector) => (
          <Panel
            title={connector.name}
            key={connector.id}
            action={<StatusBadge value={connector.status} />}
          >
            <div className="connector-card">
              <div className="connector-icon">
                <ConnectorIcon id={connector.id} />
              </div>
              <div>
                <strong>{connector.metric}</strong>
                <p className="muted">{connector.detail}</p>
              </div>
            </div>
            <Link to={connector.route} className="inline-link">
              {connector.actionLabel}
              <ExternalLink size={13} aria-hidden="true" />
            </Link>
          </Panel>
        ))}
      </section>
    </div>
  );
}

export function ModelsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });

  if (isLoading) return <div className="state">Loading models...</div>;
  if (error || !data)
    return <div className="state error">Bek API is not reachable.</div>;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Model routing"
        title="Model choice is policy, not lock-in."
      />
      {data.modelPolicies.length === 0 ? (
        <EmptyState
          title="No model policies"
          body="Add a model policy before Bek can route work."
        />
      ) : (
        <section className="bundle-list">
          {data.modelPolicies.map((policy) => (
            <ModelPolicyPanel policy={policy} key={policy.id} />
          ))}
        </section>
      )}
    </div>
  );
}

function ModelPolicyPanel({ policy }: { policy: ModelPolicy }) {
  const queryClient = useQueryClient();
  const [defaultModel, setDefaultModel] = useState(policy.defaultModel);
  const [fallbackModels, setFallbackModels] = useState(
    policy.fallbackModels.join(", "),
  );
  const [perRunBudgetCents, setPerRunBudgetCents] = useState(
    String(policy.perRunBudgetCents),
  );
  const modelMutation = useMutation({
    mutationFn: updateModelPolicy,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
  });

  useEffect(() => {
    setDefaultModel(policy.defaultModel);
    setFallbackModels(policy.fallbackModels.join(", "));
    setPerRunBudgetCents(String(policy.perRunBudgetCents));
  }, [policy]);

  const parsedFallbacks = fallbackModels
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const parsedBudget = Number(perRunBudgetCents);
  const defaultModelLooksValid = modelIdLooksValid(defaultModel);
  const fallbackModelsLookValid = parsedFallbacks.every(modelIdLooksValid);
  const canSave =
    defaultModel.trim().length > 0 &&
    defaultModelLooksValid &&
    fallbackModelsLookValid &&
    Number.isFinite(parsedBudget) &&
    parsedBudget > 0 &&
    !modelMutation.isPending;

  return (
    <Panel title={policy.name}>
      {modelMutation.isError ? (
        <WarningCallout>
          {errorMessage(
            modelMutation.error,
            "Bek could not update that model policy.",
          )}
        </WarningCallout>
      ) : null}
      {modelMutation.isSuccess ? (
        <SuccessCallout>Model policy saved.</SuccessCallout>
      ) : null}
      {!defaultModelLooksValid || !fallbackModelsLookValid ? (
        <WarningCallout>
          Use Gateway model IDs in provider/model format. Secrets stay in server
          env; set BEK_MODEL_GATEWAY=vercel_ai_sdk to run live calls.
        </WarningCallout>
      ) : null}
      <div className="split-row">
        <div>
          <span className="muted">Default Gateway model</span>
          <strong>{policy.defaultModel}</strong>
        </div>
        <div>
          <span className="muted">Per-run estimate cap</span>
          <strong>{formatMoney(policy.perRunBudgetCents)}</strong>
        </div>
      </div>
      <div className="chips">
        {policy.fallbackModels.length === 0 ? (
          <span className="chip warning-chip">No fallback configured</span>
        ) : (
          policy.fallbackModels.map((model) => (
            <span className="chip" key={model}>
              {model}
            </span>
          ))
        )}
      </div>
      <form
        className="settings-grid compact-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave) return;
          modelMutation.mutate({
            modelPolicyId: policy.id,
            defaultModel: defaultModel.trim(),
            fallbackModels: parsedFallbacks,
            perRunBudgetCents: Math.round(parsedBudget),
          });
        }}
      >
        <label>
          Default Gateway model ID
          <input
            value={defaultModel}
            required
            placeholder="openai/gpt-5.4"
            onChange={(event) => setDefaultModel(event.target.value)}
          />
        </label>
        <label>
          Fallback Gateway model IDs, attempted in order
          <input
            value={fallbackModels}
            placeholder="anthropic/claude-sonnet-4.8, openai-compatible/local"
            onChange={(event) => setFallbackModels(event.target.value)}
          />
        </label>
        <label>
          Per-run estimate cap, cents
          <input
            value={perRunBudgetCents}
            type="number"
            min="1"
            step="1"
            required
            onChange={(event) => setPerRunBudgetCents(event.target.value)}
          />
        </label>
        <div className="form-actions">
          <button
            className="secondary"
            disabled={!canSave}
            aria-busy={modelMutation.isPending}
          >
            {modelMutation.isPending ? "Saving..." : "Save Policy"}
          </button>
        </div>
      </form>
    </Panel>
  );
}

function modelIdLooksValid(modelId: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(modelId.trim());
}

export function MemoryPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });

  if (isLoading) return <div className="state">Loading memory...</div>;
  if (error || !data)
    return <div className="state error">Bek API is not reachable.</div>;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Memory"
        title="Team memory must be scoped, reviewable, and removable."
      />
      <section className="metrics">
        <MetricCard
          icon={<Database />}
          label="Workspace memories"
          value="0"
          detail="Planned for v0.2"
        />
        <MetricCard
          icon={<LockKeyhole />}
          label="Retention"
          value="Off"
          detail="No silent long-term memory in local mode"
        />
        <MetricCard
          icon={<ShieldCheck />}
          label="Visibility"
          value="Admin review"
          detail="Every future memory has provenance"
        />
      </section>
      <Panel title="Memory stance">
        <p className="muted">
          Bek stores auditable run events and approvals today. Durable memory
          should ship only after tenant isolation, redaction, retention
          controls, and per-place memory policy are in place.
        </p>
      </Panel>
    </div>
  );
}

export function AuditPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });

  if (isLoading) return <div className="state">Loading audit log...</div>;
  if (error || !data)
    return <div className="state error">Bek API is not reachable.</div>;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Audit"
        title="Every policy decision and action should leave a trail."
      />
      <Panel>
        <EventTimeline events={data.events} />
      </Panel>
    </div>
  );
}

export function RunDetailPage() {
  const { runId } = useParams({ from: "/runs/$runId" });
  const { data, isLoading, error } = useQuery({
    queryKey: ["run", runId],
    queryFn: () => fetchRunDetail(runId),
  });

  if (isLoading) return <div className="state">Loading run...</div>;
  if (error || !data) return <div className="state error">Run not found.</div>;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Run detail"
        title={data.run.prompt}
        actions={
          <Link to="/runs" className="secondary">
            <ArrowLeft size={16} aria-hidden="true" />
            Runs
          </Link>
        }
      />
      <section className="metrics">
        <MetricCard
          icon={<Clock />}
          label="Status"
          value={data.run.status.replaceAll("_", " ")}
          detail={formatDateTime(data.run.updatedAt)}
        />
        <MetricCard
          icon={<GitPullRequest />}
          label="Trigger"
          value={data.run.trigger}
          detail={data.run.runtimeProfileId}
        />
        <MetricCard
          icon={<KeyRound />}
          label="Cost"
          value={formatMoney(
            data.run.actualCostCents || data.run.estimatedCostCents,
          )}
          detail="estimated or actual"
        />
      </section>
      <section className="grid">
        <Panel title="Approvals">
          {data.approvals.length === 0 ? (
            <EmptyState
              title="No approval required"
              body="This run completed under channel policy."
            />
          ) : (
            <div className="bundle-list">
              {data.approvals.map((approval) => (
                <div className="bundle" key={approval.id}>
                  <strong>{approval.action}</strong>
                  <span>{approval.payloadHash}</span>
                  <StatusBadge value={approval.status} />
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Events">
          <EventTimeline events={data.events} />
        </Panel>
      </section>
    </div>
  );
}

export function RunsTable({
  data,
  runs = data.runs,
  emptyTitle = "No runs yet",
  emptyBody = "Runs will appear here after Bek completes work.",
}: {
  data: Bootstrap;
  runs?: Run[];
  emptyTitle?: string;
  emptyBody?: string;
}) {
  if (runs.length === 0) {
    return <EmptyState title={emptyTitle} body={emptyBody} />;
  }
  return (
    <div className="table-scroll">
      <table className="responsive-table">
        <caption className="sr-only">Bek runs</caption>
        <thead>
          <tr>
            <th scope="col">Run</th>
            <th scope="col">Place</th>
            <th scope="col">Status</th>
            <th scope="col">Cost</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td data-label="Run">
                <RunLink run={run} />
              </td>
              <td data-label="Place">
                {findRunPlace(data, run)?.name ?? run.placeScopeId}
              </td>
              <td data-label="Status">
                <StatusBadge value={run.status} />
              </td>
              <td data-label="Cost">
                <CostCell run={run} />
              </td>
              <td data-label="Updated">{formatDateTime(run.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventTimeline({ events }: { events: RunEvent[] }) {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No events"
        body="Bek has not recorded events for this scope yet."
      />
    );
  }
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.id}>
          <StatusBadge value={event.type} />
          <span>{event.message}</span>
          <small>{formatDateTime(event.createdAt)}</small>
        </li>
      ))}
    </ol>
  );
}
