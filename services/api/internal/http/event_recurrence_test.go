package http

import (
	"testing"
	"time"
)

func mustRule(t *testing.T, text string) *eventRule {
	t.Helper()
	rule, err := parseEventRule(text)
	if err != nil {
		t.Fatalf("parse %q: %v", text, err)
	}
	return &rule
}

func TestParseEventRule(t *testing.T) {
	for _, bad := range []string{
		"", "FREQ=YEARLY", "FREQ=DAILY;BYDAY=MO", "FREQ=WEEKLY;COUNT=2;UNTIL=20270101T000000Z",
		"FREQ=WEEKLY;BYDAY=XX", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;COUNT=501", "FREQ=DAILY;BYHOUR=3",
		"FREQ=DAILY;FREQ=WEEKLY", "INTERVAL=2",
	} {
		if _, err := parseEventRule(bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
	rule := mustRule(t, "freq=weekly;byday=su,mo,su;interval=2;count=4")
	if got := rule.String(); got != "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;COUNT=4" {
		t.Fatalf("canonical form = %q", got)
	}
}

// A weekly 18:00 in Berlin stays at 18:00 local across the October change to winter time,
// which moves it by an hour in UTC.
func TestEventOccurrencesKeepLocalTimeAcrossDST(t *testing.T) {
	berlin, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Skip("no time zone data:", err)
	}
	first := time.Date(2026, 10, 18, 18, 0, 0, 0, berlin) // a Sunday, summer time
	sched := eventSchedule{First: first, Length: time.Hour, Rule: mustRule(t, "FREQ=WEEKLY;BYDAY=SU"), Zone: berlin}

	next, ok, prev, hasPrev := sched.around(first.Add(2 * time.Hour))
	if !ok || !hasPrev || !prev.Start.Equal(first) {
		t.Fatalf("unexpected around: %v %v %v %v", next, ok, prev, hasPrev)
	}
	local := next.Start.In(berlin)
	if local.Weekday() != time.Sunday || local.Hour() != 18 || local.Day() != 25 {
		t.Fatalf("second occurrence at %v", local)
	}
	if got := next.Start.Sub(first.UTC()); got != 7*24*time.Hour+time.Hour {
		t.Fatalf("expected a week and an hour in UTC across the change, got %v", got)
	}

	// Far ahead, the jump still lands on the right Sunday at 18:00.
	far, ok, _, _ := sched.around(time.Date(2030, 3, 5, 0, 0, 0, 0, time.UTC))
	if !ok || far.Start.In(berlin).Weekday() != time.Sunday || far.Start.In(berlin).Hour() != 18 || far.Start.In(berlin).Before(time.Date(2030, 3, 5, 0, 0, 0, 0, berlin)) {
		t.Fatalf("far occurrence %v", far.Start.In(berlin))
	}
	if !far.Start.In(berlin).Before(time.Date(2030, 3, 12, 0, 0, 0, 0, berlin)) {
		t.Fatalf("skipped a week: %v", far.Start.In(berlin))
	}
}

func TestEventOccurrencesCountUntilAndMonthly(t *testing.T) {
	first := time.Date(2026, 1, 31, 9, 0, 0, 0, time.UTC)

	// Monthly on the 31st skips months without one.
	monthly := eventSchedule{First: first, Length: time.Hour, Rule: mustRule(t, "FREQ=MONTHLY;COUNT=3"), Zone: time.UTC}
	next, ok, _, _ := monthly.around(first.Add(2 * time.Hour))
	if !ok || next.Start.Month() != time.March || next.Start.Day() != 31 {
		t.Fatalf("expected March 31, got %v", next.Start)
	}
	last, ok := monthly.last()
	if !ok || last.Start.Month() != time.May {
		t.Fatalf("third occurrence should be May 31, got %v", last.Start)
	}
	if _, ok, _, _ := monthly.around(last.End); ok {
		t.Fatal("series should be over after its count")
	}

	// Daily every two days until a date, inclusive.
	daily := eventSchedule{First: first, Length: 30 * time.Minute, Rule: mustRule(t, "FREQ=DAILY;INTERVAL=2;UNTIL=20260204T090000Z"), Zone: time.UTC}
	last, ok = daily.last()
	if !ok || last.Start.Day() != 4 || last.Start.Month() != time.February {
		t.Fatalf("last daily = %v", last.Start)
	}

	// Endless series have no last occurrence; a one-off ends with itself.
	if _, ok := (eventSchedule{First: first, Length: time.Hour, Rule: mustRule(t, "FREQ=DAILY")}).last(); ok {
		t.Fatal("endless series reported a last occurrence")
	}
	one := eventSchedule{First: first, Length: time.Hour}
	if _, ok, prev, hasPrev := one.around(first.Add(2 * time.Hour)); ok || !hasPrev || !prev.Start.Equal(first) {
		t.Fatal("one-off after its end should be over")
	}
}

// Weekly on several days walks them in order, starting from the first start even when
// it is midweek.
func TestEventOccurrencesWeeklySeveralDays(t *testing.T) {
	first := time.Date(2026, 11, 11, 20, 0, 0, 0, time.UTC) // Wednesday
	sched := eventSchedule{First: first, Length: time.Hour, Rule: mustRule(t, "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3"), Zone: time.UTC}
	want := []int{11, 16, 18}
	now := first.Add(-time.Hour)
	for _, day := range want {
		next, ok, _, _ := sched.around(now)
		if !ok || next.Start.Day() != day {
			t.Fatalf("expected the %dth, got %v (%v)", day, next.Start, ok)
		}
		now = next.End
	}
	if _, ok, _, _ := sched.around(now); ok {
		t.Fatal("count of three exceeded")
	}
}
