package database

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

type updateMigration struct {
	version    string
	statements []string
	// after runs in the migration's transaction, after its statements, for a change plain
	// SQL cannot make. It is not part of the checksum.
	after func(*sql.Tx) error
}

// migrateVersioned applies each migration once and records its checksum. A migration's
// statements are frozen once it has run anywhere: changing them fails the next startup,
// so a later schema change is a new entry, never an edit.
func migrateVersioned(db *sql.DB, driver string) error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY,
		checksum TEXT NOT NULL,
		applied_at TEXT NOT NULL
	)`); err != nil {
		return err
	}

	migrations := []updateMigration{
		{
			version:    "2026101101_chat",
			statements: chatStatements(),
		},
		{
			version:    "2026101201_accounts_permissions",
			statements: permissionsStatements(driver),
		},
		{
			version:    "2026101202_drop_update_control",
			statements: dropUpdateControlStatements(driver),
		},
		{
			version:    "2026102701_call_state",
			statements: callStateStatements(),
		},
		{version: "2026103001_chat_attachments", statements: chatAttachmentStatements()},
		{version: "2026103101_chat_notify", statements: chatNotifyStatements()},
		{version: "2026103102_chat_reactions", statements: chatReactionStatements()},
		{version: "2026103103_chat_seen", statements: chatSeenStatements()},
		{version: "2026110101_knock_replies", statements: knockReplyStatements()},
		{version: "2026110201_sign_up_invites", statements: signUpInviteStatements()},
		{version: "2026110202_account_deletion", statements: accountDeletionStatements()},
		{version: "2026110401_voice_moderation", statements: voiceModerationStatements()},
		{version: "2026110402_call_votes", statements: callVoteStatements()},
		{version: "2026110601_workshop", statements: workshopStatements()},
		savedMessagesMigration(driver),
		{version: "2026110701_space_names", statements: spaceNameStatements()},
		{version: "2026111001_room_doors", statements: roomDoorStatements()},
		{version: "2026111002_board_rules", statements: boardStatements()},
		{version: "2026111003_board_notes", statements: boardNoteStatements()},
		ravenMessagesMigration(driver),
		{version: "2026111005_board_events", statements: boardEventStatements()},
		{version: "2026111006_chat_link_previews", statements: chatLinkPreviewStatements()},
		{version: "2026111006_library", statements: libraryStatements()},
		{version: "2026111101_chat_polls", statements: chatPollStatements()},
	}
	for _, migration := range migrations {
		if err := applyUpdateMigration(db, driver, migration); err != nil {
			return err
		}
	}
	return nil
}

func applyUpdateMigration(db *sql.DB, driver string, migration updateMigration) error {
	hash := sha256.Sum256([]byte(strings.Join(migration.statements, "\n")))
	checksum := hex.EncodeToString(hash[:])
	var appliedChecksum string
	err := db.QueryRow(rebind(driver, `SELECT checksum FROM schema_migrations WHERE version = ?`), migration.version).Scan(&appliedChecksum)
	if err == nil {
		if appliedChecksum != checksum {
			return fmt.Errorf("migration %s checksum mismatch", migration.version)
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, statement := range migration.statements {
		if _, err := tx.Exec(statement); err != nil {
			return fmt.Errorf("migration %s: %w", migration.version, err)
		}
	}
	if migration.after != nil {
		if err := migration.after(tx); err != nil {
			return fmt.Errorf("migration %s: %w", migration.version, err)
		}
	}
	if _, err := tx.Exec(
		rebind(driver, `INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)`),
		migration.version,
		checksum,
		Now(),
	); err != nil {
		return err
	}
	return tx.Commit()
}

func savedMessagesMigration(driver string) updateMigration {
	migration := updateMigration{version: "2026110701_saved_messages", statements: savedMessagesStatements(driver)}
	if driver != "pgx" {
		migration.after = sqliteWidenChatKindCheck
	}
	return migration
}

// dropUpdateControlStatements removes the tables of the retired release-operations
// system (migration 2026071201_update_control, no longer applied). On a database that
// never had them it does nothing. Children are dropped before the tables they reference.
func dropUpdateControlStatements(driver string) []string {
	tables := []string{
		"release_action_authorizations",
		"release_ops_sessions",
		"release_administrators",
		"release_audit_events",
		"update_download_grants",
		"update_release_artifacts",
		"update_rollouts",
		"update_version_blocks",
		"update_enrollments",
		"update_cohort_assignments",
		"update_outcome_daily",
		"update_outcome_dedup",
		"update_diagnostic_reports",
		"update_releases",
		"update_cohorts",
		"update_channels",
	}
	statements := make([]string, 0, len(tables)+1)
	for _, table := range tables {
		statements = append(statements, "DROP TABLE IF EXISTS "+table)
	}
	if driver == "pgx" {
		statements = append(statements, "DROP FUNCTION IF EXISTS prevent_release_audit_mutation()")
	}
	return statements
}
