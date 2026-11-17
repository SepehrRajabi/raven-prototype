package main

import "testing"

func TestLimitsFromEnv(t *testing.T) {
	env := map[string]string{"RAVEN_BOT_DRAFT_MAX_MB": "50", "RAVEN_BOT_MAX_DRAFTS": "10"}
	l, err := limitsFromEnv(func(k string) string { return env[k] })
	if err != nil || l.DraftBytes != 50<<20 || l.TotalBytes != 0 || l.Drafts != 10 {
		t.Fatalf("limits %+v err %v", l, err)
	}
	for _, bad := range []string{"0", "-1", "ten", "2097152"} {
		env := map[string]string{"RAVEN_BOT_DISK_MAX_MB": bad}
		if _, err := limitsFromEnv(func(k string) string { return env[k] }); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
