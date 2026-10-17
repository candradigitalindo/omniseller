-- A multi-file operation may prescribe a different type/size for each input field.
-- Existing single-file uploads remain valid without a field binding.
ALTER TABLE commerce_file ADD COLUMN field_name text
 CHECK (field_name IS NULL OR length(field_name) BETWEEN 1 AND 200);
