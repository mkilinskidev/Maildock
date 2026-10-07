CREATE FUNCTION public.maildock_search_addresses(addresses jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT coalesce(string_agg(coalesce(a->>'name', '') || ' ' ||
    coalesce(a->>'address', '') || ' ' ||
    replace(coalesce(a->>'address', ''), '@', ' ') || ' ' ||
    regexp_replace(coalesce(a->>'address', ''), '[^[:alnum:]_]+', ' ', 'g'), ' '), '')
  FROM jsonb_array_elements(addresses) a
$$;
CREATE FUNCTION public.maildock_search_vector(subject text, from_addresses jsonb, sender jsonb, recipients jsonb, cc jsonb, body text) RETURNS tsvector
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT setweight(to_tsvector('simple', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('simple', maildock_search_addresses(from_addresses || sender)), 'B') ||
    setweight(to_tsvector('simple', maildock_search_addresses(recipients || cc)), 'C') ||
    setweight(to_tsvector('simple', coalesce(body, '')), 'D')
$$;
