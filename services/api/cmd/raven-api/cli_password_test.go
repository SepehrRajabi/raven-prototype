package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"raven/services/api/internal/database"
	apihttp "raven/services/api/internal/http"
)

// A password left off the command line is read from standard input, so it does not
// show in the process list.
func TestUserCreateReadsThePasswordFromStandardInput(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "raven-cli-stdin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	server := apihttp.New(db)

	previous := cliStdin
	t.Cleanup(func() { cliStdin = previous })

	var stdout, stderr bytes.Buffer
	cliStdin = strings.NewReader("piped-secret-1\r\n")
	if _, err := runProvisioningCLI(server, []string{"user", "create", "--username", "dana"}, &stdout, &stderr); err != nil {
		t.Fatalf("create with a piped password: %v", err)
	}
	if strings.Contains(stdout.String(), "piped-secret-1") {
		t.Fatal("the password was printed")
	}
	if _, _, err := server.ResetUserPassword("dana"); err != nil {
		t.Fatalf("the account was not created: %v", err)
	}

	cliStdin = strings.NewReader("")
	if _, err := runProvisioningCLI(server, []string{"user", "create", "--username", "erin"}, &stdout, &stderr); err == nil {
		t.Fatal("an empty standard input made an account")
	}
}
