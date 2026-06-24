CREATE TABLE "outbound_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"status" text NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_id" text,
	"approval_id" text,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_deliveries_org_key_unique" ON "outbound_deliveries" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "outbound_deliveries_due_idx" ON "outbound_deliveries" USING btree ("org_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbound_deliveries_run_idx" ON "outbound_deliveries" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "outbound_deliveries_approval_idx" ON "outbound_deliveries" USING btree ("approval_id");