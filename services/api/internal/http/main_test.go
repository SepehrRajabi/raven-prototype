package http

import (
	"os"
	"testing"

	"raven/services/api/internal/auth"

	"golang.org/x/crypto/bcrypt"
)

// TestMain hashes passwords at bcrypt's lowest cost. The tests sign up hundreds of
// accounts, and at the production cost that alone would take minutes.
func TestMain(m *testing.M) {
	auth.PasswordCost = bcrypt.MinCost
	os.Exit(m.Run())
}
