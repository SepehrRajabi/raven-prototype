package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"raven/services/api/internal/database"
	apihttp "raven/services/api/internal/http"
)

func runProvisioningCLI(server *apihttp.Server, args []string, stdout, stderr io.Writer) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	switch args[0] {
	case "user":
		usage := fmt.Errorf("usage: raven-api user <create|set-role|reset-password> [flags]")
		if len(args) < 2 {
			return true, usage
		}
		switch args[1] {
		case "create":
			return true, runUserCreate(server, args[2:], stdout, stderr)
		case "set-role":
			return true, runUserSetRole(server, args[2:], stdout, stderr)
		case "reset-password":
			return true, runUserResetPassword(server, args[2:], stdout, stderr)
		default:
			return true, usage
		}
	case "space":
		if len(args) < 2 {
			return true, fmt.Errorf("usage: raven-api space <create|add-user> [flags]")
		}
		switch args[1] {
		case "create":
			return true, runSpaceCreate(server, args[2:], stdout, stderr)
		case "add-user":
			return true, runSpaceAddUser(server, args[2:], stdout, stderr)
		default:
			return true, fmt.Errorf("usage: raven-api space <create|add-user> [flags]")
		}
	case "room":
		if len(args) < 2 || args[1] != "create" {
			return true, fmt.Errorf("usage: raven-api room create --name <room> --space <space-name-or-id>")
		}
		return true, runRoomCreate(server, args[2:], stdout, stderr)
	default:
		return false, nil
	}
}

func runUserCreate(server *apihttp.Server, args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("user create", stderr)
	username := fs.String("username", "", "username")
	displayName := fs.String("display-name", "", "display name")
	password := fs.String("password", "", "password (visible to other users of this machine in the process list; leave it out to read the password from standard input)")
	role := fs.String("role", "user", "role: admin or user")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if strings.TrimSpace(*username) == "" {
		return fmt.Errorf("user create requires --username")
	}
	if *password == "" {
		read, err := readPassword(cliStdin, stderr)
		if err != nil {
			return fmt.Errorf("user create: %w", err)
		}
		*password = read
	}
	if err := apihttp.ValidateNewUsername(strings.TrimSpace(*username)); err != nil {
		return fmt.Errorf("create user: %w", err)
	}
	if err := apihttp.ValidatePassword(*password, strings.TrimSpace(*username)); err != nil {
		return fmt.Errorf("create user: %w", err)
	}
	user, err := server.CreateUserWithDisplayName(*username, *displayName, *password, *role)
	if err != nil {
		if errors.Is(err, apihttp.ErrUsernameTaken) || database.IsUniqueViolation(err) {
			return fmt.Errorf("create user: username %q already exists", strings.TrimSpace(*username))
		}
		return fmt.Errorf("create user: %w", err)
	}
	server.RecordCLIChange("user.created", "user", user.ID, user.Username, map[string]any{"role": user.Role})
	fmt.Fprintf(stdout, "created %s user %q (%s) with display name %q\n", user.Role, user.Username, user.ID, user.DisplayName)
	return nil
}

// cliStdin is where a password left off the command line is read from.
var cliStdin io.Reader = os.Stdin

// readPassword reads one line from in, without its line ending. A password given on the
// command line shows in the process list and the shell's history; one piped in does not:
//
//	printf '%s\n' "$PASSWORD" | raven-api user create --username anna
func readPassword(in io.Reader, prompt io.Writer) (string, error) {
	if file, ok := in.(*os.File); ok {
		if info, err := file.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
			fmt.Fprint(prompt, "Password (shown as you type): ")
		}
	}
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	line = strings.TrimRight(line, "\r\n")
	if line == "" {
		return "", fmt.Errorf("no password: pass --password or write it to standard input")
	}
	return line, nil
}

func runUserSetRole(server *apihttp.Server, args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("user set-role", stderr)
	username := fs.String("username", "", "username")
	role := fs.String("role", "", "role: admin or user")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if strings.TrimSpace(*username) == "" || strings.TrimSpace(*role) == "" {
		return fmt.Errorf("user set-role requires --username and --role")
	}
	user, err := server.SetUserRole(*username, *role)
	if err != nil {
		return fmt.Errorf("set role: %w", err)
	}
	fmt.Fprintf(stdout, "user %q (%s) is now %s\n", user.Username, user.ID, user.Role)
	return nil
}

// runUserResetPassword prints a temporary password, which is the only time it is shown.
// The account has to choose its own the next time it signs in.
func runUserResetPassword(server *apihttp.Server, args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("user reset-password", stderr)
	username := fs.String("username", "", "username")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if strings.TrimSpace(*username) == "" {
		return fmt.Errorf("user reset-password requires --username")
	}
	user, temporary, err := server.ResetUserPassword(*username)
	if err != nil {
		return fmt.Errorf("reset password: %w", err)
	}
	fmt.Fprintf(stdout, "temporary password for %q: %s\n", user.Username, temporary)
	return nil
}

func runSpaceCreate(server *apihttp.Server, args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("space create", stderr)
	name := fs.String("name", "", "space name")
	creator := fs.String("creator", "", "creator username")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if strings.TrimSpace(*name) == "" || strings.TrimSpace(*creator) == "" {
		return fmt.Errorf("space create requires --name and --creator")
	}
	space, err := server.CreateSpace(*name, *creator)
	if err != nil {
		return fmt.Errorf("create space: %w", err)
	}
	fmt.Fprintf(stdout, "created space %q (%s) with creator %q\n", space.Name, space.ID, strings.TrimSpace(*creator))
	return nil
}

func runRoomCreate(server *apihttp.Server, args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("room create", stderr)
	name := fs.String("name", "", "room name")
	spaceReference := fs.String("space", "", "space name or ID")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if strings.TrimSpace(*name) == "" || strings.TrimSpace(*spaceReference) == "" {
		return fmt.Errorf("room create requires --name and --space")
	}
	result, err := server.CreateRoom(*name, *spaceReference)
	if err != nil {
		return fmt.Errorf("create room: %w", err)
	}
	fmt.Fprintf(
		stdout,
		"created room %q (%s) in space %q (%s) with creator %q\n",
		result.Room.Name, result.Room.ID, result.Space.Name, result.Space.ID, result.Creator.Username,
	)
	return nil
}

func runSpaceAddUser(server *apihttp.Server, args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("space add-user", stderr)
	spaceReference := fs.String("space", "", "space name or ID")
	username := fs.String("username", "", "username")
	role := fs.String("role", "member", "role: owner, moderator, or member")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if strings.TrimSpace(*spaceReference) == "" || strings.TrimSpace(*username) == "" {
		return fmt.Errorf("space add-user requires --space and --username")
	}
	var requestedRole *string
	fs.Visit(func(current *flag.Flag) {
		if current.Name == "role" {
			requestedRole = role
		}
	})
	result, err := server.AddUserToSpace(*spaceReference, *username, requestedRole)
	if err != nil {
		return fmt.Errorf("add user to space: %w", err)
	}
	fmt.Fprintf(
		stdout,
		"space member %q (%s) is joined to %q (%s) as %s\n",
		result.Member.Username, result.Member.UserID, result.Space.Name, result.Space.ID, result.Member.Role,
	)
	return nil
}

func newFlagSet(name string, stderr io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	return fs
}

func parseFlags(fs *flag.FlagSet, args []string) error {
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	return nil
}
