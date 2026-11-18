
-- KTF Admin Panel: database migration 0002

-- Member account controls
ALTER TABLE members
ADD COLUMN account_status TEXT NOT NULL DEFAULT 'ACTIVE';

-- Payment review and audit information
ALTER TABLE payments
ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'PAYU';

ALTER TABLE payments
ADD COLUMN reviewed_by TEXT;

ALTER TABLE payments
ADD COLUMN reviewed_at TEXT;

-- Member notifications and announcements
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    member_id TEXT,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    read_at TEXT,
    FOREIGN KEY(member_id) REFERENCES members(id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_member
ON notifications(member_id, created_at);

-- Admin audit history
CREATE INDEX IF NOT EXISTS idx_admin_audit_created
ON admin_audit(created_at);
