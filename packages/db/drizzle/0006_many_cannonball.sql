CREATE TYPE "public"."agent_identity_scope" AS ENUM('workspace', 'public_channel', 'private_channel', 'dm', 'service_account');--> statement-breakpoint
CREATE TABLE "agent_identity_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"place_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"scope" "agent_identity_scope" NOT NULL,
	"name" text NOT NULL,
	"baseline" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"inherits_baseline" boolean DEFAULT true NOT NULL,
	"place_id" text,
	"model_policy_id" text,
	"runtime_profile_id" text,
	"access_bundle_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approver_principal_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"invocation_allowlist_principal_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_identity_bindings" ADD CONSTRAINT "agent_identity_bindings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_identity_bindings" ADD CONSTRAINT "agent_identity_bindings_identity_id_agent_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."agent_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_identity_bindings" ADD CONSTRAINT "agent_identity_bindings_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_model_policy_id_model_policies_id_fk" FOREIGN KEY ("model_policy_id") REFERENCES "public"."model_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_runtime_profile_id_runtime_profiles_id_fk" FOREIGN KEY ("runtime_profile_id") REFERENCES "public"."runtime_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_identity_bindings_place_identity_unique" ON "agent_identity_bindings" USING btree ("place_id","identity_id");--> statement-breakpoint
CREATE INDEX "agent_identity_bindings_org_identity_idx" ON "agent_identity_bindings" USING btree ("org_id","identity_id");--> statement-breakpoint
CREATE INDEX "agent_identities_org_scope_idx" ON "agent_identities" USING btree ("org_id","scope");--> statement-breakpoint
CREATE INDEX "agent_identities_org_place_idx" ON "agent_identities" USING btree ("org_id","place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_identities_org_baseline_unique" ON "agent_identities" USING btree ("org_id") WHERE "agent_identities"."baseline" = true;