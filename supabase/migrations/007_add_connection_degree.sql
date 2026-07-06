-- Add is_connected flag and update status values
ALTER TABLE doc_contacts DROP COLUMN IF EXISTS connection_degree;
ALTER TABLE doc_contacts ADD COLUMN IF NOT EXISTS is_connected boolean NOT NULL DEFAULT false;

ALTER TABLE doc_contacts DROP CONSTRAINT IF EXISTS doc_contacts_status_check;
UPDATE doc_contacts SET status = 'pending' WHERE status NOT IN ('pending', 'messaged', 'engaged');
ALTER TABLE doc_contacts ADD CONSTRAINT doc_contacts_status_check CHECK (status IN ('pending', 'messaged', 'engaged'));
ALTER TABLE doc_contacts ALTER COLUMN status SET DEFAULT 'pending';
