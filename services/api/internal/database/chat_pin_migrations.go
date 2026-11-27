package database

// chatPinStatements adds the messages pinned in a space's text rooms: one row per pinned
// message, with who pinned it and when. message_id has no foreign key, like the other
// chat tables, so bulk deletes never depend on order; the code that erases a message or
// removes a conversation deletes its pins in the same transaction.
//
// members_can_pin is a text room's own choice: when it is on, members who can write there
// may pin too. It is off until someone who runs the room turns it on.
func chatPinStatements() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS chat_pins (
			message_id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL,
			pinned_by TEXT NOT NULL,
			pinned_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_pins_conversation ON chat_pins(conversation_id, pinned_at)`,
		`ALTER TABLE chat_conversations ADD COLUMN members_can_pin BOOLEAN NOT NULL DEFAULT FALSE`,
	}
}
