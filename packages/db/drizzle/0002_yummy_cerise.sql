CREATE TYPE "public"."worker_run_attempt_state" AS ENUM('queued', 'claimed', 'awaiting_approval', 'retry_scheduled', 'cancel_requested', 'completed', 'cancelled', 'dead_lettered');--> statement-breakpoint
CREATE TYPE "public"."worker_work_reason" AS ENUM('new_run', 'approval_granted', 'retry', 'resume');--> statement-breakpoint
CREATE TYPE "public"."worker_work_status" AS ENUM('queued', 'claimed', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'dead');--> statement-breakpoint
CREATE TABLE "worker_dead_letters" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"work_id" text NOT NULL,
	"run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"item" jsonb NOT NULL,
	"reason" text NOT NULL,
	"failed_at" timestamp with time zone NOT NULL,
	"result" jsonb NOT NULL,
	"retry_policy" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"work_id" text,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"attempt" integer,
	"trace_id" text,
	"message" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_work_records" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"item" jsonb NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"reason" "worker_work_reason" NOT NULL,
	"trace_id" text NOT NULL,
	"status" "worker_work_status" NOT NULL,
	"attempt_state" "worker_run_attempt_state" NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"enqueued_at" timestamp with time zone NOT NULL,
	"lease_id" text,
	"lease_worker_id" text,
	"lease_claimed_at" timestamp with time zone,
	"lease_heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"approval_id" text,
	"approval_payload_hash" text,
	"approval_action" text,
	"approval_risk" "risk_level",
	"approval_status" "approval_status",
	"approval_created_at" timestamp with time zone,
	"approval_expires_at" timestamp with time zone,
	"retry_of" text,
	"cancel_requested_at" timestamp with time zone,
	"cancel_reason" text,
	"terminal_reason" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_work_records_attempt_positive" CHECK ("worker_work_records"."attempt" > 0)
);
--> statement-breakpoint
ALTER TABLE "worker_dead_letters" ADD CONSTRAINT "worker_dead_letters_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_events" ADD CONSTRAINT "worker_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_work_records" ADD CONSTRAINT "worker_work_records_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_dead_letters_work_unique" ON "worker_dead_letters" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX "worker_dead_letters_org_failed_idx" ON "worker_dead_letters" USING btree ("org_id","failed_at");--> statement-breakpoint
CREATE INDEX "worker_dead_letters_org_run_idx" ON "worker_dead_letters" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "worker_events_org_created_idx" ON "worker_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "worker_events_org_run_created_idx" ON "worker_events" USING btree ("org_id","run_id","created_at");--> statement-breakpoint
CREATE INDEX "worker_events_type_created_idx" ON "worker_events" USING btree ("type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_work_records_active_idempotency_unique" ON "worker_work_records" USING btree ("org_id","idempotency_key") WHERE "worker_work_records"."status" in ('queued', 'claimed', 'awaiting_approval');--> statement-breakpoint
CREATE UNIQUE INDEX "worker_work_records_lease_id_unique" ON "worker_work_records" USING btree ("lease_id") WHERE "worker_work_records"."lease_id" is not null;--> statement-breakpoint
CREATE INDEX "worker_work_records_claim_idx" ON "worker_work_records" USING btree ("available_at","sequence") WHERE "worker_work_records"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "worker_work_records_lease_expiry_idx" ON "worker_work_records" USING btree ("lease_expires_at") WHERE "worker_work_records"."status" = 'claimed';--> statement-breakpoint
CREATE INDEX "worker_work_records_org_run_idx" ON "worker_work_records" USING btree ("org_id","run_id","attempt");--> statement-breakpoint
CREATE INDEX "worker_work_records_org_status_idx" ON "worker_work_records" USING btree ("org_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "worker_work_records_approval_idx" ON "worker_work_records" USING btree ("approval_id");