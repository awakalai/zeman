-- Two different things are called a batch (§ stage 12).
--
-- A reliability gate written this morning asserted that a receipt_documents row naming a batch
-- must name a batch that exists. It failed, and the live database said 64 of its 108 documents
-- were in breach. They are not in breach. The invariant was wrong.
--
-- `receipt_documents.batch_id` and `receipt_batches.id` are different namespaces:
--
--   · receipt_batches.id is a batch the administrator reviews — a row, with totals, a decision,
--     and a conversion into a transaction.
--
--   · receipt_documents.batch_id is the grouping the browser makes when somebody selects several
--     images and sends them together. sarraf_receipt_intake_begin_v3 validates it as
--     `^[A-Za-z0-9._:-]{1,140}$` and nothing else — it is a UUID the client invented, and it is
--     what the storage path is built from: ingest/<grouping>/<document>.jpg
--
-- Nothing is broken. What is wrong is that one name means two things, which cost an hour today
-- and would cost it again — a foreign key added on that reasoning would have refused every
-- upload from the moment it was applied.
--
-- The rename is not done here. It would touch the intake command, the OCR route, the storage
-- paths of every object already written, and the browser — a large change to a working path, to
-- fix a name. What is done here is the thing that actually stops the next person losing the
-- hour: the column says what it is, in the database, where anybody reading the schema will see
-- it before they reason about it.
--
-- The one real gap the same gate found is closed: two documents could claim the same stored
-- object. The live database has none (asked before this was written, in INSPECT section 5.d),
-- so the index can be created safely.

begin;

comment on column public.receipt_documents.batch_id is
  'The grouping the uploader''s browser made when several images were sent together, and what the storage path is built from. NOT a receipt_batches.id — that is a different thing with the same name, and 64 of the first 108 documents here name a grouping that has no receipt_batches row, correctly. Do not add a foreign key.';

comment on column public.receipt_batches.id is
  'A batch the administrator reviews: totals, a decision, a conversion into a transaction. Not the same as receipt_documents.batch_id, which is the browser''s upload grouping.';

-- One document per stored object.
--
-- There was no constraint at all. Two documents claiming one object means deleting or replacing
-- either one silently changes the other, and the storage-integrity arithmetic in INSPECT — which
-- counts objects nothing references by matching against storage_path — stops being able to
-- count. The intake command builds the path from the document id, so duplicates should not
-- arise; this is what makes that a rule rather than a habit.
create unique index if not exists receipt_documents_storage_path_uq
  on public.receipt_documents(storage_path);

commit;
