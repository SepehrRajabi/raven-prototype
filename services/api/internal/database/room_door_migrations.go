package database

// roomDoorStatements gives every room a door, and records when an accepted knock has been
// used to walk in, so one answer lets someone in once. Rooms that already exist stay open.
func roomDoorStatements() []string {
	return []string{
		`ALTER TABLE nests ADD COLUMN door TEXT NOT NULL DEFAULT 'open' CHECK (door IN ('open', 'knock', 'quiet'))`,
		`ALTER TABLE knocks ADD COLUMN consumed_at TEXT`,
	}
}
