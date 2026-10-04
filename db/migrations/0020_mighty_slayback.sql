ALTER TABLE "draft_attachments" ADD COLUMN "inline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "draft_attachments" ADD COLUMN "content_id" text;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "rich_document" jsonb;--> statement-breakpoint
ALTER TABLE "outgoing_message_attachments" ADD COLUMN "resource_id" uuid;--> statement-breakpoint
ALTER TABLE "outgoing_message_attachments" ADD COLUMN "content_id" text;--> statement-breakpoint
ALTER TABLE "outgoing_message_attachments" ADD COLUMN "inline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "rich_document" jsonb;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "html" text;--> statement-breakpoint
ALTER TABLE "staged_attachments" ADD COLUMN "draft_id" uuid;
--> statement-breakpoint
-- Upgrade only active drafts. Text-node newlines preserve blank/trailing lines
-- without violating the node limit for a legacy draft containing many breaks.
UPDATE drafts SET rich_document = jsonb_build_object('version', 1, 'editor', jsonb_build_object('root',
  jsonb_build_object('type','root','version',1,'direction',null,'format','','indent',0,'children',jsonb_build_array(
    jsonb_build_object('type','paragraph','version',1,'direction',null,'format','','indent',0,'textFormat',0,'textStyle','','children',
      CASE WHEN drafts.plain_text = '' THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object(
        'type','text','version',1,'text',replace(replace(drafts.plain_text,E'\r\n',E'\n'),E'\r',E'\n'),
        'format',0,'style','','detail',0,'mode','normal')) END
    )
  )))) WHERE status = 'active' AND rich_document IS NULL;
--> statement-breakpoint
ALTER TABLE draft_attachments ADD CONSTRAINT draft_inline_cid CHECK
  ((inline AND content_id IS NOT NULL AND content_id ~ '^[0-9a-f-]{36}@maildock[.]invalid$' AND blob_id IS NOT NULL) OR (NOT inline AND content_id IS NULL));
--> statement-breakpoint
ALTER TABLE outgoing_message_attachments ADD CONSTRAINT outgoing_inline_cid CHECK
  ((inline AND content_id IS NOT NULL AND content_id ~ '^[0-9a-f-]{36}@maildock[.]invalid$' AND resource_id IS NOT NULL) OR (NOT inline AND content_id IS NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_outgoing_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.account_id, NEW."from", NEW."to", NEW.cc, NEW.bcc,
         NEW.subject, NEW.plain_text, NEW.rich_document, NEW.html, NEW.message_id, NEW.mime_base64, NEW.mime_blob_id, NEW.created_at, NEW.sent_copy_policy, NEW.in_reply_to, NEW."references")
     IS DISTINCT FROM
     ROW(OLD.id, OLD.account_id, OLD."from", OLD."to", OLD.cc, OLD.bcc,
         OLD.subject, OLD.plain_text, OLD.rich_document, OLD.html, OLD.message_id, OLD.mime_base64, OLD.mime_blob_id, OLD.created_at, OLD.sent_copy_policy, OLD.in_reply_to, OLD."references") THEN
    RAISE EXCEPTION 'Outgoing message snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;
