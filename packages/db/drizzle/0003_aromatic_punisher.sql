DROP INDEX "worker_dead_letters_work_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "worker_dead_letters_org_work_unique" ON "worker_dead_letters" USING btree ("org_id","work_id");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_events_org_sequence_unique" ON "worker_events" USING btree ("org_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_work_records_org_sequence_unique" ON "worker_work_records" USING btree ("org_id","sequence");