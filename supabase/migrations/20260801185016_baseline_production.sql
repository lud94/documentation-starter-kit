-- categorie: additive
-- rollback: sur une cible vierge dediee, supprimer les objets public crees par cette baseline; si des donnees ont ete ecrites depuis, recreer ou restaurer la cible avant retrait
-- reversible: partielle




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";





SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."prospector_leads" (
    "id" "text" NOT NULL,
    "data" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "workspace_id" "text"
);


ALTER TABLE "public"."prospector_leads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."prospector_pappers_cache" (
    "siren" "text" NOT NULL,
    "data" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."prospector_pappers_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."prospector_settings" (
    "key" "text" NOT NULL,
    "value" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."prospector_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."prospector_store" (
    "kind" "text" NOT NULL,
    "id" "text" NOT NULL,
    "workspace_id" "text" NOT NULL,
    "data" "jsonb",
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."prospector_store" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."prospector_usage" (
    "key" "text" NOT NULL,
    "count" integer DEFAULT 0,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."prospector_usage" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."prospector_workspaces" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "leads" integer DEFAULT 0 NOT NULL,
    "users" integer DEFAULT 1 NOT NULL,
    "plan" "text" DEFAULT 'Starter'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "client_email" "text",
    "status" "text" DEFAULT 'active'::"text",
    "permissions" "jsonb",
    "client_password_hash" "text"
);


ALTER TABLE "public"."prospector_workspaces" OWNER TO "postgres";


ALTER TABLE ONLY "public"."prospector_leads"
    ADD CONSTRAINT "prospector_leads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."prospector_pappers_cache"
    ADD CONSTRAINT "prospector_pappers_cache_pkey" PRIMARY KEY ("siren");



ALTER TABLE ONLY "public"."prospector_settings"
    ADD CONSTRAINT "prospector_settings_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."prospector_store"
    ADD CONSTRAINT "prospector_store_pkey" PRIMARY KEY ("kind", "id", "workspace_id");



ALTER TABLE ONLY "public"."prospector_usage"
    ADD CONSTRAINT "prospector_usage_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."prospector_workspaces"
    ADD CONSTRAINT "prospector_workspaces_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."prospector_leads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."prospector_pappers_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."prospector_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."prospector_store" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."prospector_usage" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."prospector_workspaces" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";





































































































































































GRANT ALL ON TABLE "public"."prospector_leads" TO "anon";
GRANT ALL ON TABLE "public"."prospector_leads" TO "authenticated";
GRANT ALL ON TABLE "public"."prospector_leads" TO "service_role";



GRANT ALL ON TABLE "public"."prospector_pappers_cache" TO "anon";
GRANT ALL ON TABLE "public"."prospector_pappers_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."prospector_pappers_cache" TO "service_role";



GRANT ALL ON TABLE "public"."prospector_settings" TO "anon";
GRANT ALL ON TABLE "public"."prospector_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."prospector_settings" TO "service_role";



GRANT ALL ON TABLE "public"."prospector_store" TO "anon";
GRANT ALL ON TABLE "public"."prospector_store" TO "authenticated";
GRANT ALL ON TABLE "public"."prospector_store" TO "service_role";



GRANT ALL ON TABLE "public"."prospector_usage" TO "anon";
GRANT ALL ON TABLE "public"."prospector_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."prospector_usage" TO "service_role";



GRANT ALL ON TABLE "public"."prospector_workspaces" TO "anon";
GRANT ALL ON TABLE "public"."prospector_workspaces" TO "authenticated";
GRANT ALL ON TABLE "public"."prospector_workspaces" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
