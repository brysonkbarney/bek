CREATE TYPE "public"."agent_status" AS ENUM('active', 'paused', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "public"."capability_kind" AS ENUM('slack.read', 'slack.write', 'github.read', 'github.branch', 'github.pr', 'linear.read', 'linear.write', 'mcp.tool', 'sandbox.exec', 'model.call');--> statement-breakpoint
CREATE TYPE "public"."capability_profile_kind" AS ENUM('answer', 'coding', 'incident', 'support', 'data', 'workflow');--> statement-breakpoint
CREATE TYPE "public"."connector_install_status" AS ENUM('pending', 'active', 'paused', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."connector_kind" AS ENUM('slack', 'github', 'linear', 'model_provider', 'mcp', 'sandbox', 'custom');--> statement-breakpoint
CREATE TYPE "public"."credential_status" AS ENUM('active', 'disabled', 'rotation_due', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."policy_decision" AS ENUM('allow', 'ask', 'deny');--> statement-breakpoint
CREATE TYPE "public"."organization_plan" AS ENUM('oss', 'team', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."place_kind" AS ENUM('slack_channel', 'slack_dm', 'github_repo', 'project', 'system');--> statement-breakpoint
CREATE TYPE "public"."place_provider" AS ENUM('slack', 'github', 'system');--> statement-breakpoint
CREATE TYPE "public"."place_sensitivity" AS ENUM('public', 'internal', 'confidential', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."principal_kind" AS ENUM('human', 'agent', 'service_account', 'integration', 'system');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('read_internal', 'write_draft', 'write_external', 'privileged');--> statement-breakpoint
CREATE TYPE "public"."run_event_type" AS ENUM('run.created', 'policy.evaluated', 'model.selected', 'tool.requested', 'approval.requested', 'approval.decided', 'run.status_changed', 'run.completed', 'run.failed');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'reading_context', 'planning', 'awaiting_approval', 'running_tools', 'working_in_sandbox', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."runtime_kind" AS ENUM('ai_sdk', 'opencode', 'langgraph', 'external');--> statement-breakpoint
CREATE TYPE "public"."trigger_kind" AS ENUM('mention', 'reaction', 'dm', 'slash_command', 'api', 'schedule');--> statement-breakpoint
CREATE TYPE "public"."usage_status" AS ENUM('succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "access_bundle_places" (
	"org_id" text NOT NULL,
	"access_bundle_id" text NOT NULL,
	"place_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_bundle_places_pk" PRIMARY KEY("access_bundle_id","place_id")
);
--> statement-breakpoint
CREATE TABLE "access_bundles" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"budget_policy_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"name" text NOT NULL,
	"handle" text DEFAULT '@bek' NOT NULL,
	"description" text NOT NULL,
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"default_model_policy_id" text NOT NULL,
	"default_runtime_profile_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_handle_is_bek" CHECK ("agents"."handle" = '@bek')
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"action" text NOT NULL,
	"risk" "risk_level" NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"payload_hash" text NOT NULL,
	"payload_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by_principal_id" text NOT NULL,
	"decided_by_principal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"actor_principal_id" text,
	"run_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"decision" "policy_decision",
	"risk" "risk_level",
	"message" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"per_run_cents" integer NOT NULL,
	"per_day_cents" integer NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"access_bundle_id" text NOT NULL,
	"capability" "capability_kind" NOT NULL,
	"resource" text NOT NULL,
	"decision" "policy_decision" NOT NULL,
	"risk" "risk_level" NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capability_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"capability_kind" "capability_profile_kind" NOT NULL,
	"runtime_profile_id" text NOT NULL,
	"model_policy_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" "connector_kind" NOT NULL,
	"provider" text NOT NULL,
	"external_id" text,
	"display_name" text NOT NULL,
	"status" "connector_install_status" DEFAULT 'pending' NOT NULL,
	"installed_by_principal_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential_metadata" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"connector_install_id" text,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"external_account_id" text,
	"secret_ref" text NOT NULL,
	"status" "credential_status" DEFAULT 'active' NOT NULL,
	"scope_summary" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"rotation_due_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"default_model" text NOT NULL,
	"fallback_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"per_run_budget_cents" integer NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"run_event_id" text,
	"model_policy_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_cents" integer DEFAULT 0 NOT NULL,
	"actual_cost_cents" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"status" "usage_status" NOT NULL,
	"error_code" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" "organization_plan" DEFAULT 'oss' NOT NULL,
	"primary_agent_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" "place_kind" NOT NULL,
	"provider" "place_provider" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"sensitivity" "place_sensitivity" NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" "principal_kind" NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"external_provider" text,
	"external_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"type" "run_event_type" NOT NULL,
	"message" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"requester_principal_id" text NOT NULL,
	"place_scope_id" text NOT NULL,
	"trigger" "trigger_kind" NOT NULL,
	"prompt" text NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"model_policy_id" text NOT NULL,
	"runtime_profile_id" text NOT NULL,
	"estimated_cost_cents" integer DEFAULT 0 NOT NULL,
	"actual_cost_cents" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runtime_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"runtime_kind" "runtime_kind" NOT NULL,
	"adapter" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"run_event_id" text,
	"connector_install_id" text,
	"credential_id" text,
	"capability" "capability_kind" NOT NULL,
	"tool_name" text NOT NULL,
	"resource" text NOT NULL,
	"decision" "policy_decision" NOT NULL,
	"risk" "risk_level" NOT NULL,
	"status" "usage_status" NOT NULL,
	"duration_ms" integer,
	"estimated_cost_cents" integer DEFAULT 0 NOT NULL,
	"actual_cost_cents" integer DEFAULT 0 NOT NULL,
	"payload_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_bundle_places" ADD CONSTRAINT "access_bundle_places_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_bundle_places" ADD CONSTRAINT "access_bundle_places_access_bundle_id_access_bundles_id_fk" FOREIGN KEY ("access_bundle_id") REFERENCES "public"."access_bundles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_bundle_places" ADD CONSTRAINT "access_bundle_places_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_bundles" ADD CONSTRAINT "access_bundles_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_bundles" ADD CONSTRAINT "access_bundles_budget_policy_id_budget_policies_id_fk" FOREIGN KEY ("budget_policy_id") REFERENCES "public"."budget_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_default_model_policy_id_model_policies_id_fk" FOREIGN KEY ("default_model_policy_id") REFERENCES "public"."model_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_default_runtime_profile_id_runtime_profiles_id_fk" FOREIGN KEY ("default_runtime_profile_id") REFERENCES "public"."runtime_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_principal_id_principals_id_fk" FOREIGN KEY ("requested_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_principal_id_principals_id_fk" FOREIGN KEY ("decided_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_principal_id_principals_id_fk" FOREIGN KEY ("actor_principal_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD CONSTRAINT "budget_policies_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_access_bundle_id_access_bundles_id_fk" FOREIGN KEY ("access_bundle_id") REFERENCES "public"."access_bundles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_profiles" ADD CONSTRAINT "capability_profiles_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_profiles" ADD CONSTRAINT "capability_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_profiles" ADD CONSTRAINT "capability_profiles_runtime_profile_id_runtime_profiles_id_fk" FOREIGN KEY ("runtime_profile_id") REFERENCES "public"."runtime_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_profiles" ADD CONSTRAINT "capability_profiles_model_policy_id_model_policies_id_fk" FOREIGN KEY ("model_policy_id") REFERENCES "public"."model_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_installs" ADD CONSTRAINT "connector_installs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_installs" ADD CONSTRAINT "connector_installs_installed_by_principal_id_principals_id_fk" FOREIGN KEY ("installed_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_metadata" ADD CONSTRAINT "credential_metadata_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_metadata" ADD CONSTRAINT "credential_metadata_connector_install_id_connector_installs_id_fk" FOREIGN KEY ("connector_install_id") REFERENCES "public"."connector_installs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_policies" ADD CONSTRAINT "model_policies_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_run_event_id_run_events_id_fk" FOREIGN KEY ("run_event_id") REFERENCES "public"."run_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_model_policy_id_model_policies_id_fk" FOREIGN KEY ("model_policy_id") REFERENCES "public"."model_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_requester_principal_id_principals_id_fk" FOREIGN KEY ("requester_principal_id") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_place_scope_id_places_id_fk" FOREIGN KEY ("place_scope_id") REFERENCES "public"."places"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_model_policy_id_model_policies_id_fk" FOREIGN KEY ("model_policy_id") REFERENCES "public"."model_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_runtime_profile_id_runtime_profiles_id_fk" FOREIGN KEY ("runtime_profile_id") REFERENCES "public"."runtime_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_usage" ADD CONSTRAINT "tool_usage_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_usage" ADD CONSTRAINT "tool_usage_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_usage" ADD CONSTRAINT "tool_usage_run_event_id_run_events_id_fk" FOREIGN KEY ("run_event_id") REFERENCES "public"."run_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_usage" ADD CONSTRAINT "tool_usage_connector_install_id_connector_installs_id_fk" FOREIGN KEY ("connector_install_id") REFERENCES "public"."connector_installs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_usage" ADD CONSTRAINT "tool_usage_credential_id_credential_metadata_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential_metadata"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_bundle_places_org_place_idx" ON "access_bundle_places" USING btree ("org_id","place_id");--> statement-breakpoint
CREATE INDEX "access_bundles_org_idx" ON "access_bundles" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_bundles_org_name_unique" ON "access_bundles" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_visible_agent_per_org" ON "agents" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_principal_unique" ON "agents" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "approvals_run_idx" ON "approvals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "approvals_org_status_idx" ON "approvals" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_run_action_payload_unique" ON "approvals" USING btree ("run_id","action","payload_hash");--> statement-breakpoint
CREATE INDEX "audit_events_org_created_idx" ON "audit_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_run_idx" ON "audit_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_principal_id");--> statement-breakpoint
CREATE INDEX "budget_policies_org_idx" ON "budget_policies" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_policies_org_name_unique" ON "budget_policies" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "grants_org_capability_idx" ON "grants" USING btree ("org_id","capability");--> statement-breakpoint
CREATE INDEX "grants_bundle_idx" ON "grants" USING btree ("access_bundle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grants_bundle_capability_resource_unique" ON "grants" USING btree ("access_bundle_id","capability","resource");--> statement-breakpoint
CREATE INDEX "capability_profiles_org_agent_idx" ON "capability_profiles" USING btree ("org_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capability_profiles_agent_kind_unique" ON "capability_profiles" USING btree ("agent_id","capability_kind");--> statement-breakpoint
CREATE INDEX "connector_installs_org_kind_idx" ON "connector_installs" USING btree ("org_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_installs_org_provider_external_unique" ON "connector_installs" USING btree ("org_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "credential_metadata_org_provider_idx" ON "credential_metadata" USING btree ("org_id","provider");--> statement-breakpoint
CREATE INDEX "credential_metadata_connector_idx" ON "credential_metadata" USING btree ("connector_install_id");--> statement-breakpoint
CREATE INDEX "model_policies_org_idx" ON "model_policies" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_policies_org_name_unique" ON "model_policies" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "model_usage_org_created_idx" ON "model_usage" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "model_usage_run_idx" ON "model_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "model_usage_model_idx" ON "model_usage" USING btree ("provider","model");--> statement-breakpoint
CREATE UNIQUE INDEX "orgs_slug_unique" ON "orgs" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "orgs_primary_agent_idx" ON "orgs" USING btree ("primary_agent_id");--> statement-breakpoint
CREATE INDEX "places_org_kind_idx" ON "places" USING btree ("org_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "places_org_provider_external_unique" ON "places" USING btree ("org_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "principals_org_kind_idx" ON "principals" USING btree ("org_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "principals_org_external_unique" ON "principals" USING btree ("org_id","external_provider","external_id");--> statement-breakpoint
CREATE INDEX "run_events_run_created_idx" ON "run_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "run_events_org_idx" ON "run_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "runs_org_created_idx" ON "runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_org_status_idx" ON "runs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "runs_place_created_idx" ON "runs" USING btree ("place_scope_id","created_at");--> statement-breakpoint
CREATE INDEX "runtime_profiles_org_idx" ON "runtime_profiles" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_profiles_org_name_unique" ON "runtime_profiles" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "tool_usage_org_created_idx" ON "tool_usage" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_usage_run_idx" ON "tool_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "tool_usage_tool_idx" ON "tool_usage" USING btree ("connector_install_id","tool_name");