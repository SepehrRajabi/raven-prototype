package database

// chatPollStatements adds polls. A poll is a message whose body is the question, with its
// settings here, its answers in order, and each person's choices. An answer marked correct
// makes the poll a quiz. Votes keep who chose what even in an anonymous poll, so a person
// can see and change their own choice; the server never shows them to anyone else.
func chatPollStatements() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS chat_polls (
   message_id TEXT PRIMARY KEY,
   conversation_id TEXT NOT NULL,
   multiple BOOLEAN NOT NULL DEFAULT FALSE,
   anonymous BOOLEAN NOT NULL DEFAULT FALSE,
   closed_at TEXT,
   created_at TEXT NOT NULL
  )`,
		`CREATE INDEX IF NOT EXISTS idx_chat_polls_conversation ON chat_polls(conversation_id)`,
		`CREATE TABLE IF NOT EXISTS chat_poll_options (
   message_id TEXT NOT NULL,
   conversation_id TEXT NOT NULL,
   position INTEGER NOT NULL,
   text TEXT NOT NULL,
   correct BOOLEAN NOT NULL DEFAULT FALSE,
   PRIMARY KEY (message_id, position)
  )`,
		`CREATE INDEX IF NOT EXISTS idx_chat_poll_options_conversation ON chat_poll_options(conversation_id)`,
		`CREATE TABLE IF NOT EXISTS chat_poll_votes (
   message_id TEXT NOT NULL,
   conversation_id TEXT NOT NULL,
   user_id TEXT NOT NULL,
   position INTEGER NOT NULL,
   created_at TEXT NOT NULL,
   PRIMARY KEY (message_id, user_id, position)
  )`,
		`CREATE INDEX IF NOT EXISTS idx_chat_poll_votes_conversation ON chat_poll_votes(conversation_id)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_poll_votes_user ON chat_poll_votes(user_id)`,
	}
}

// chatPollFeedbackStatements adds what the asker writes for whoever picks an answer.
func chatPollFeedbackStatements() []string {
	return []string{
		`ALTER TABLE chat_poll_options ADD COLUMN feedback TEXT NOT NULL DEFAULT ''`,
	}
}

// chatPollMirrorStatements lets a saved or forwarded poll show the results of the poll it
// was copied from. results_of names that poll's message; it is NULL on a poll asked where
// it is, and on copies made before this column, which stay polls of their own. The asker
// chooses whether the poll may be forwarded, whether copies show its results, and, when
// they don't, whether they say how many people voted. Older polls keep allowing all three.
func chatPollMirrorStatements() []string {
	return []string{
		`ALTER TABLE chat_polls ADD COLUMN results_of TEXT`,
		`ALTER TABLE chat_polls ADD COLUMN forwardable BOOLEAN NOT NULL DEFAULT TRUE`,
		`ALTER TABLE chat_polls ADD COLUMN copy_results BOOLEAN NOT NULL DEFAULT TRUE`,
		`ALTER TABLE chat_polls ADD COLUMN copy_voters BOOLEAN NOT NULL DEFAULT TRUE`,
		`CREATE INDEX IF NOT EXISTS idx_chat_polls_results_of ON chat_polls(results_of)`,
	}
}
