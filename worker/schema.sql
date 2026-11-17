PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS members (
 id TEXT PRIMARY KEY, firebase_uid TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
 business_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS plans (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, amount_paise INTEGER NOT NULL,
 billing_cycle TEXT NOT NULL, interval_count INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO plans(id,name,amount_paise,billing_cycle,interval_count) VALUES
 ('consultancy_yearly','Consultancy annual membership',100000,'YEARLY',1),
 ('advertiser_monthly','Advertisement access',5000,'MONTHLY',1);
CREATE TABLE IF NOT EXISTS subscriptions (
 id TEXT PRIMARY KEY, member_id TEXT NOT NULL, plan_id TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'PAYU',
 payu_txnid TEXT UNIQUE, payu_mihpayid TEXT, payu_auth_ref_id TEXT,
 mandate_status TEXT NOT NULL DEFAULT 'PENDING', status TEXT NOT NULL DEFAULT 'PENDING',
 started_at TEXT, current_period_end TEXT, cancelled_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(member_id) REFERENCES members(id), FOREIGN KEY(plan_id) REFERENCES plans(id)
);
CREATE TABLE IF NOT EXISTS payments (
 id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, provider_txn_id TEXT, amount_paise INTEGER NOT NULL,
 currency TEXT NOT NULL DEFAULT 'INR', status TEXT NOT NULL, raw_reference TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(subscription_id) REFERENCES subscriptions(id)
);
CREATE TABLE IF NOT EXISTS advertisements (
 id TEXT PRIMARY KEY, member_id TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL, body TEXT NOT NULL,
 external_url TEXT, status TEXT NOT NULL DEFAULT 'PENDING', admin_note TEXT, submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reviewed_at TEXT, published_at TEXT, published_by TEXT,
 FOREIGN KEY(member_id) REFERENCES members(id)
);
CREATE TABLE IF NOT EXISTS webhook_events (
 id TEXT PRIMARY KEY, provider_event_id TEXT UNIQUE, event_type TEXT NOT NULL, payload TEXT NOT NULL,
 received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, processed_at TEXT
);
CREATE TABLE IF NOT EXISTS admin_audit (
 id TEXT PRIMARY KEY, admin_uid TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL,
 details TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ads_status ON advertisements(status,submitted_at);
CREATE INDEX IF NOT EXISTS idx_sub_member ON subscriptions(member_id,created_at);
CREATE INDEX IF NOT EXISTS idx_payments_subscription ON payments(subscription_id,created_at);
