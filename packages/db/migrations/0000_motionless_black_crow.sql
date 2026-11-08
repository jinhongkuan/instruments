CREATE TYPE "public"."instrument_kind" AS ENUM('perp', 'spot_borrow', 'option');--> statement-breakpoint
CREATE TYPE "public"."option_type" AS ENUM('call', 'put');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "assets_symbol_unique" UNIQUE("symbol")
);
--> statement-breakpoint
CREATE TABLE "borrow_rates" (
	"venue_instrument_id" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"borrow_apr" double precision NOT NULL,
	"supply_apr" double precision,
	"liquidation_ltv" double precision,
	CONSTRAINT "borrow_rates_venue_instrument_id_observed_at_pk" PRIMARY KEY("venue_instrument_id","observed_at")
);
--> statement-breakpoint
CREATE TABLE "daily_prices" (
	"asset_id" integer NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "daily_prices_asset_id_day_pk" PRIMARY KEY("asset_id","day")
);
--> statement-breakpoint
CREATE TABLE "funding_rates" (
	"venue_instrument_id" integer NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"rate" double precision NOT NULL,
	"premium" double precision,
	"oracle_price" double precision,
	CONSTRAINT "funding_rates_venue_instrument_id_hour_pk" PRIMARY KEY("venue_instrument_id","hour")
);
--> statement-breakpoint
CREATE TABLE "option_quotes" (
	"venue_instrument_id" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"expiry" timestamp with time zone NOT NULL,
	"strike" double precision NOT NULL,
	"type" "option_type" NOT NULL,
	"bid" double precision,
	"ask" double precision,
	"mark" double precision,
	"implied_vol" double precision,
	"underlying_price" double precision,
	CONSTRAINT "option_quotes_venue_instrument_id_observed_at_expiry_strike_type_pk" PRIMARY KEY("venue_instrument_id","observed_at","expiry","strike","type")
);
--> statement-breakpoint
CREATE TABLE "parameter_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"description" text NOT NULL,
	"parameters" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venue_instruments" (
	"id" serial PRIMARY KEY NOT NULL,
	"venue_id" integer NOT NULL,
	"asset_id" integer NOT NULL,
	"venue_symbol" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "instrument_kind" NOT NULL,
	CONSTRAINT "venues_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "borrow_rates" ADD CONSTRAINT "borrow_rates_venue_instrument_id_venue_instruments_id_fk" FOREIGN KEY ("venue_instrument_id") REFERENCES "public"."venue_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_prices" ADD CONSTRAINT "daily_prices_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_rates" ADD CONSTRAINT "funding_rates_venue_instrument_id_venue_instruments_id_fk" FOREIGN KEY ("venue_instrument_id") REFERENCES "public"."venue_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_quotes" ADD CONSTRAINT "option_quotes_venue_instrument_id_venue_instruments_id_fk" FOREIGN KEY ("venue_instrument_id") REFERENCES "public"."venue_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_instruments" ADD CONSTRAINT "venue_instruments_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_instruments" ADD CONSTRAINT "venue_instruments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "option_quotes_by_expiry" ON "option_quotes" USING btree ("venue_instrument_id","expiry","observed_at");--> statement-breakpoint
CREATE INDEX "venue_instruments_lookup" ON "venue_instruments" USING btree ("venue_id","venue_symbol","valid_from");