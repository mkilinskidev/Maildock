-- Extend the Stage 1 singleton, retaining its generation guard and COMMIT locks.
CREATE FUNCTION maildock_receiving_acquire(actor uuid, ttl_ms integer) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE lease receiving_coordinator%ROWTYPE;
BEGIN
  IF actor IS NULL OR ttl_ms IS NULL OR ttl_ms <= 0 OR ttl_ms > 60000 THEN
    RAISE EXCEPTION 'Invalid receiving lease';
  END IF;
  SELECT * INTO STRICT lease FROM receiving_coordinator WHERE singleton FOR UPDATE;
  IF lease.expires_at > clock_timestamp() THEN RETURN NULL; END IF;
  RETURN maildock_receiving_takeover(actor,ttl_ms);
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_renew(actor uuid, term bigint, ttl_ms integer) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE lease receiving_coordinator%ROWTYPE;
BEGIN
  IF ttl_ms IS NULL OR ttl_ms <= 0 OR ttl_ms > 60000 THEN RAISE EXCEPTION 'Invalid receiving lease'; END IF;
  SELECT * INTO STRICT lease FROM receiving_coordinator WHERE singleton FOR UPDATE;
  IF actor IS NULL OR term IS NULL OR lease.owner IS DISTINCT FROM actor
    OR lease.generation <> term OR lease.expires_at <= clock_timestamp() THEN RETURN false; END IF;
  UPDATE receiving_coordinator SET expires_at=clock_timestamp()+ttl_ms*interval '1 millisecond' WHERE singleton;
  RETURN true;
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_validate(actor uuid, term bigint) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE lease receiving_coordinator%ROWTYPE;
BEGIN
  SELECT * INTO STRICT lease FROM receiving_coordinator WHERE singleton FOR SHARE;
  -- Compare database time AFTER locking, never in a pre-lock SELECT projection.
  RETURN actor IS NOT NULL AND term IS NOT NULL AND lease.owner IS NOT DISTINCT FROM actor
    AND lease.generation=term AND lease.expires_at>clock_timestamp();
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_release(actor uuid, term bigint) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE lease receiving_coordinator%ROWTYPE;
BEGIN
  SELECT * INTO STRICT lease FROM receiving_coordinator WHERE singleton FOR UPDATE;
  IF actor IS NULL OR term IS NULL OR lease.owner IS DISTINCT FROM actor OR lease.generation <> term THEN RETURN false; END IF;
  -- Keep identity/generation as a tombstone: release never resets or revives it.
  UPDATE receiving_coordinator SET expires_at='-infinity' WHERE singleton;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_acquire(uuid,integer),
  maildock_receiving_renew(uuid,bigint,integer), maildock_receiving_validate(uuid,bigint),
  maildock_receiving_release(uuid,bigint) FROM PUBLIC;
