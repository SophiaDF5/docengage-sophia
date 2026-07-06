-- Add email column to doc_contacts
ALTER TABLE doc_contacts ADD COLUMN IF NOT EXISTS email text;
