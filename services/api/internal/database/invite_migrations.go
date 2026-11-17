package database

// signUpInviteStatements adds the two ways into a server that do not need an
// administrator: open sign-up and single-use invite codes. Both switches start off, and
// so does the capability to invite, so applying this changes nothing until an
// administrator turns them on.
func signUpInviteStatements() []string {
	return []string{
		`ALTER TABLE server_settings ADD COLUMN sign_up_open BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE server_settings ADD COLUMN invitations_open BOOLEAN NOT NULL DEFAULT FALSE`,
		`INSERT INTO server_settings (id, avatar_object_key, updated_at) VALUES (1, '', '2026-11-02T00:00:00Z') ON CONFLICT(id) DO NOTHING`,
		// Only a hash of the code is kept; code_hint is its last four characters, so the
		// person who made it can tell their codes apart.
		`CREATE TABLE IF NOT EXISTS account_invites (
			id TEXT PRIMARY KEY,
			code_hash TEXT NOT NULL UNIQUE,
			code_hint TEXT NOT NULL,
			created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			used_at TEXT,
			used_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
			revoked_at TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_account_invites_creator ON account_invites(created_by_user_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_account_invites_used_by ON account_invites(used_by_user_id)`,
		`INSERT INTO server_capability_defaults (capability, allowed, limit_value, updated_at)
		 VALUES ('` + CapabilityInvitesCreate + `', FALSE, NULL, '2026-11-02T00:00:00Z') ON CONFLICT(capability) DO NOTHING`,
	}
}

// serverNameStatements adds the server's display name, set from the admin dashboard.
// Empty means RAVEN_SERVER_NAME, or "Raven" when that is not set either.
func serverNameStatements() []string {
	return []string{
		`ALTER TABLE server_settings ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`,
	}
}
