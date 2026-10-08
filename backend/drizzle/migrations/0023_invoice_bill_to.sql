-- 0023_invoice_bill_to: who a paid invoice was billed to (backend doc 8.32, UI L45). The invoice PDF prints
-- the business's name, address, and NPWP: from the business profile while the invoice waits, and from this
-- copy once it is paid, written in the same transaction that records the payment. A receipt therefore
-- never changes when the profile does. Invoices paid before this column stay null and print the profile.
ALTER TABLE invoice ADD COLUMN bill_to jsonb
  CONSTRAINT invoice_bill_to_object
  CHECK (bill_to IS NULL OR (jsonb_typeof(bill_to) = 'object' AND jsonb_typeof(bill_to -> 'name') = 'string'));

-- The audit trigger is made again by drizzle/sql/20_triggers.sql without this copy: the business profile
-- it comes from is audited where it changes, and an invoice's entry keeps to its status and amounts.
DROP TRIGGER IF EXISTS audit_trg ON invoice;
