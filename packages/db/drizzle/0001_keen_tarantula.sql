CREATE TABLE "ingress_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"status" text NOT NULL,
	"run_id" text,
	"approval_id" text,
	"response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingress_deliveries" ADD CONSTRAINT "ingress_deliveries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingress_deliveries" ADD CONSTRAINT "ingress_deliveries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingress_deliveries" ADD CONSTRAINT "ingress_deliveries_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ingress_deliveries_org_key_unique" ON "ingress_deliveries" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "ingress_deliveries_org_created_idx" ON "ingress_deliveries" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "ingress_deliveries_run_idx" ON "ingress_deliveries" USING btree ("run_id");