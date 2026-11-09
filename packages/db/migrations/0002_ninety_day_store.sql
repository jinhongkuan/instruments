CREATE TABLE "atm_by_tenor" (
	"venue_instrument_id" integer NOT NULL,
	"tenor_days" integer NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"iv" double precision NOT NULL,
	"premium_fraction" double precision NOT NULL,
	CONSTRAINT "atm_by_tenor_venue_instrument_id_tenor_days_hour_pk" PRIMARY KEY("venue_instrument_id","tenor_days","hour")
);
--> statement-breakpoint
CREATE TABLE "latest_chain" (
	"venue_instrument_id" integer NOT NULL,
	"instrument_name" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"expiry" timestamp with time zone NOT NULL,
	"strike" double precision NOT NULL,
	"type" "option_type" NOT NULL,
	"mark_usd" double precision NOT NULL,
	"bid_usd" double precision,
	"ask_usd" double precision,
	"mark_iv" double precision NOT NULL,
	"underlying_price" double precision NOT NULL,
	CONSTRAINT "latest_chain_venue_instrument_id_instrument_name_pk" PRIMARY KEY("venue_instrument_id","instrument_name")
);
--> statement-breakpoint
CREATE TABLE "prices_hourly" (
	"venue_instrument_id" integer NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	CONSTRAINT "prices_hourly_venue_instrument_id_hour_pk" PRIMARY KEY("venue_instrument_id","hour")
);
--> statement-breakpoint
ALTER TABLE "daily_prices" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "option_quotes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "daily_prices" CASCADE;--> statement-breakpoint
DROP TABLE "option_quotes" CASCADE;--> statement-breakpoint
ALTER TABLE "funding_rates" ADD COLUMN "settled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "atm_by_tenor" ADD CONSTRAINT "atm_by_tenor_venue_instrument_id_venue_instruments_id_fk" FOREIGN KEY ("venue_instrument_id") REFERENCES "public"."venue_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "latest_chain" ADD CONSTRAINT "latest_chain_venue_instrument_id_venue_instruments_id_fk" FOREIGN KEY ("venue_instrument_id") REFERENCES "public"."venue_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices_hourly" ADD CONSTRAINT "prices_hourly_venue_instrument_id_venue_instruments_id_fk" FOREIGN KEY ("venue_instrument_id") REFERENCES "public"."venue_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "venue_instruments_open_symbol" ON "venue_instruments" USING btree ("venue_id","venue_symbol") WHERE valid_to is null;