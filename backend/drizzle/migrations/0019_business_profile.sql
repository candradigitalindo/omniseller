-- 0019_business_profile: the business profile and its legal documents (PRD 6.13 and 12, Permendag 19/2026;
-- UI L47; backend doc 8.29). The business name and time zone stay on `tenant`; `tenant.legal` was never
-- used and is left for a later contract step. These rows have tenant_id, so they get RLS and audit.

-- legal documents and the business logo are files of their own kinds
ALTER TABLE file_object DROP CONSTRAINT file_object_purpose_check;
ALTER TABLE file_object ADD CONSTRAINT file_object_purpose_check CHECK (purpose IN (
  'product_image', 'label', 'pick_list', 'export', 'import', 'settlement', 'tax_document', 'evidence', 'other',
  'legal_document', 'logo'));

-- One per business, made when first saved. A seller is registered (NIB) or in the process of getting one
-- (the regulation allows six months), never both.
CREATE TABLE business_profile (
  id                    ulid PRIMARY KEY,
  tenant_id             ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  row_version           integer NOT NULL DEFAULT 1,
  address               jsonb NOT NULL DEFAULT '{}',
  phone                 text CHECK (phone ~ '^\+?[0-9]{8,15}$'),
  logo_file_id          ulid,
  nib                   text CHECK (nib ~ '^[0-9]{13}$'),
  nib_in_process_since  date,
  nib_reminded_stage    text CHECK (nib_reminded_stage IN ('30d', '7d', 'passed')),
  npwp                  text CHECK (npwp ~ '^[0-9]{15,16}$'),
  pkp                   boolean NOT NULL DEFAULT false,
  CONSTRAINT business_profile_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT business_profile_tenant_uq UNIQUE (tenant_id),
  CONSTRAINT business_profile_nib_or_process CHECK (nib IS NULL OR nib_in_process_since IS NULL),
  CONSTRAINT business_profile_logo_fk FOREIGN KEY (tenant_id, logo_file_id)
    REFERENCES file_object (tenant_id, id) ON DELETE SET NULL (logo_file_id)
);

-- NIB, NPWP, SPPKP, deeds, licences: a file, its number, and how long it is valid. `reminded_stage` is the
-- last renewal reminder sent; a new `valid_until` starts the reminders again.
CREATE TABLE business_document (
  id              ulid PRIMARY KEY,
  tenant_id       ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1,
  kind            text NOT NULL CHECK (kind IN ('nib', 'npwp', 'sppkp', 'deed', 'business_license', 'other')),
  title           text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  number          text CHECK (char_length(number) BETWEEN 1 AND 60),
  issued_on       date,
  valid_until     date,
  file_object_id  ulid NOT NULL,
  file_name       text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  reminded_stage  text CHECK (reminded_stage IN ('30d', '7d', 'expired')),
  created_by      ulid,
  CONSTRAINT business_document_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT business_document_file_fk FOREIGN KEY (tenant_id, file_object_id)
    REFERENCES file_object (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT business_document_dates CHECK (valid_until IS NULL OR issued_on IS NULL OR valid_until >= issued_on)
);
CREATE INDEX business_document_tenant_id_idx ON business_document (tenant_id, id DESC);
-- the reminder scan: documents with an end date that have not had their last reminder
CREATE INDEX business_document_due_idx ON business_document (valid_until)
  WHERE valid_until IS NOT NULL AND reminded_stage IS DISTINCT FROM 'expired';
