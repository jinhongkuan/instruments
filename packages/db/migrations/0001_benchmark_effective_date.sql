-- Hand-ordered: drizzle-kit emitted the new primary key before its column existed.
-- NOT NULL columns without defaults assume benchmark_rates is empty (no ingestion has run yet).
ALTER TABLE "benchmark_rates" ADD COLUMN "effective_date" date NOT NULL;--> statement-breakpoint
ALTER TABLE "benchmark_rates" ADD COLUMN "published_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "benchmark_rates" ADD COLUMN "revised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "benchmark_rates" DROP CONSTRAINT "benchmark_rates_source_observed_at_pk";--> statement-breakpoint
ALTER TABLE "benchmark_rates" ADD CONSTRAINT "benchmark_rates_source_effective_date_pk" PRIMARY KEY("source","effective_date");--> statement-breakpoint
ALTER TABLE "benchmark_rates" DROP COLUMN "observed_at";
