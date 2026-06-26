CREATE TYPE "public"."memory_retention_kind" AS ENUM('forever', 'ttl_days', 'keep_until');--> statement-breakpoint
CREATE TYPE "public"."memory_source_kind" AS ENUM('slack_thread', 'doc', 'repo', 'ticket', 'mcp_output', 'uploaded_file', 'generated_report');--> statement-breakpoint
CREATE TABLE "memory_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"source_id" text NOT NULL,
	"place_id" text,
	"identity_id" text,
	"allowed_place_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_identity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sensitivity" "place_sensitivity" NOT NULL,
	"content_hash" text NOT NULL,
	"text" text NOT NULL,
	"citation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" "memory_source_kind" NOT NULL,
	"place_id" text,
	"identity_id" text,
	"sensitivity" "place_sensitivity" NOT NULL,
	"content_hash" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"title" text,
	"uri" text,
	"retention_kind" "memory_retention_kind" NOT NULL,
	"retention_ttl_days" integer,
	"retention_retain_until" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_source_id_memory_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."memory_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_chunks_org_place_idx" ON "memory_chunks" USING btree ("org_id","place_id");--> statement-breakpoint
CREATE INDEX "memory_chunks_source_idx" ON "memory_chunks" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "memory_sources_org_place_idx" ON "memory_sources" USING btree ("org_id","place_id");--> statement-breakpoint
CREATE INDEX "memory_sources_org_kind_idx" ON "memory_sources" USING btree ("org_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_sources_org_content_unique" ON "memory_sources" USING btree ("org_id","content_hash");