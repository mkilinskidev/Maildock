CREATE OR REPLACE FUNCTION public.maildock_search_addresses(addresses jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER AS $$
  SELECT coalesce(pg_catalog.string_agg(coalesce(a->>'name', '') || ' ' ||
    coalesce(a->>'address', '') || ' ' ||
    pg_catalog.replace(coalesce(a->>'address', ''), '@', ' ') || ' ' ||
    pg_catalog.regexp_replace(coalesce(a->>'address', ''), '[^[:alnum:]_]+', ' ', 'g'), ' '), '')
  FROM pg_catalog.jsonb_array_elements(addresses) a
$$;


CREATE OR REPLACE FUNCTION public.maildock_search_vector(subject text, from_addresses jsonb,
  sender jsonb, recipients jsonb, cc jsonb, body text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER AS $$
  SELECT pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple', coalesce(subject, '')), 'A') ||
    pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple', public.maildock_search_addresses(from_addresses || sender)), 'B') ||
    pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple', public.maildock_search_addresses(recipients || cc)), 'C') ||
    pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple', coalesce(body, '')), 'D')
$$;
