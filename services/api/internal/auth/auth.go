package auth

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/hex"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// PasswordCost is the bcrypt cost of new password hashes. A hash records its own cost,
// so passwords hashed at an earlier cost keep working; they move to this one the next
// time they are set. Tests lower it to keep many sign-ups fast.
var PasswordCost = 12

func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), PasswordCost)
	return string(hash), err
}

func VerifyPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

func NewID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	return hex.EncodeToString(bytes)
}

func NewJoinCode() string {
	bytes := make([]byte, 8)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	return strings.TrimRight(base32.StdEncoding.EncodeToString(bytes), "=")
}
