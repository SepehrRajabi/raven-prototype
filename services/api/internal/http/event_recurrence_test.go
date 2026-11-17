package http

import (
	"strconv"
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

// An endless monthly series that has run for years lands on this month's occurrence and
// still knows the one before it. The fast-forward used to count 28-day months and jump
// past real occurrences.
func TestEventOccurrencesLongRunningMonthly(t *testing.T) {
	first := time.Date(2020, 1, 15, 18, 0, 0, 0, time.UTC)
	sched := eventSchedule{First: first, Length: time.Hour, Rule: mustRule(t, "FREQ=MONTHLY"), Zone: time.UTC}
	next, ok, prev, hasPrev := sched.around(time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC))
	if !ok || !next.Start.Equal(time.Date(2026, 11, 15, 18, 0, 0, 0, time.UTC)) {
		t.Fatalf("next = %v (%v), want 2026-11-15 18:00", next.Start, ok)
	}
	if !hasPrev || !prev.Start.Equal(time.Date(2026, 10, 15, 18, 0, 0, 0, time.UTC)) {
		t.Fatalf("prev = %v (%v), want 2026-10-15 18:00", prev.Start, hasPrev)
	}

	// The 29th of February every twelve months is absent for seven years around 2100; the
	// occurrence before now is still the last leap day.
	leap := eventSchedule{First: time.Date(2080, 2, 29, 9, 0, 0, 0, time.UTC), Length: time.Hour, Rule: mustRule(t, "FREQ=MONTHLY;INTERVAL=12"), Zone: time.UTC}
	next, ok, prev, hasPrev = leap.around(time.Date(2103, 6, 1, 0, 0, 0, 0, time.UTC))
	if !ok || !next.Start.Equal(time.Date(2104, 2, 29, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("leap next = %v (%v)", next.Start, ok)
	}
	if !hasPrev || !prev.Start.Equal(time.Date(2096, 2, 29, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("leap prev = %v (%v)", prev.Start, hasPrev)
	}
}

// A series bounded by UNTIL far after its first start reports its real last occurrence,
// which is what series_ends_at is set from.
func TestEventOccurrencesLongUntilHasLast(t *testing.T) {
	first := time.Date(2020, 1, 15, 18, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		rule string
		want time.Time
	}{
		{"FREQ=MONTHLY;UNTIL=20281231T000000Z", time.Date(2028, 12, 15, 18, 0, 0, 0, time.UTC)},
		{"FREQ=MONTHLY;INTERVAL=5;UNTIL=20400101T000000Z", time.Date(2039, 8, 15, 18, 0, 0, 0, time.UTC)},
		{"FREQ=WEEKLY;BYDAY=MO,FR;UNTIL=20351231T000000Z", time.Date(2035, 12, 28, 18, 0, 0, 0, time.UTC)},
		{"FREQ=DAILY;INTERVAL=3;UNTIL=20450101T000000Z", time.Date(2044, 12, 31, 18, 0, 0, 0, time.UTC)},
	} {
		sched := eventSchedule{First: first, Length: time.Hour, Rule: mustRule(t, tc.rule), Zone: time.UTC}
		last, ok := sched.last()
		if !ok || !last.Start.Equal(tc.want) {
			t.Errorf("%s: last = %v (%v), want %v", tc.rule, last.Start, ok, tc.want)
		}
	}
}

// The fast-forward gives the same answer as walking the series from its first start, for
// every start day, several intervals, a zone with daylight saving and many years.
func TestEventOccurrencesFastForwardMatchesWalk(t *testing.T) {
	zone, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("no time zone data:", err)
	}
	type step func(k int) (time.Time, bool)
	walk := func(length time.Duration, now time.Time, next step) (eventOccurrence, eventOccurrence, bool) {
		var prev eventOccurrence
		hasPrev := false
		for k := 0; k < 100000; k++ {
			start, ok := next(k)
			if !ok {
				continue
			}
			one := eventOccurrence{Start: start.UTC(), End: start.Add(length).UTC()}
			if one.End.After(now) {
				return one, prev, hasPrev
			}
			prev, hasPrev = one, true
		}
		t.Fatal("walk did not end")
		return eventOccurrence{}, eventOccurrence{}, false
	}
	nows := []time.Time{
		time.Date(2020, 3, 8, 7, 30, 0, 0, time.UTC),
		time.Date(2023, 11, 5, 6, 0, 0, 0, time.UTC),
		time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC),
		time.Date(2041, 2, 28, 23, 0, 0, 0, time.UTC),
		time.Date(2057, 7, 1, 0, 0, 0, 0, time.UTC),
	}
	check := func(name string, sched eventSchedule, next step) {
		t.Helper()
		for _, now := range nows {
			want, wantPrev, wantHasPrev := walk(sched.Length, now, next)
			got, ok, prev, hasPrev := sched.around(now)
			if !ok || !got.Start.Equal(want.Start) || hasPrev != wantHasPrev || !prev.Start.Equal(wantPrev.Start) {
				t.Errorf("%s %s at %v: got %v/%v prev %v/%v, want %v prev %v/%v", name, sched.Rule, now, got.Start, ok, prev.Start, hasPrev, want.Start, wantPrev.Start, wantHasPrev)
			}
		}
	}
	for day := 1; day <= 31; day++ {
		first := time.Date(2019, 1, day, 1, 30, 0, 0, zone)
		for _, interval := range []int{1, 2, 3, 7, 12, 99} {
			rule := mustRule(t, "FREQ=MONTHLY;INTERVAL="+strconv.Itoa(interval))
			check("monthly", eventSchedule{First: first, Length: 3 * time.Hour, Rule: rule, Zone: zone}, func(k int) (time.Time, bool) {
				start := time.Date(2019, time.Month(1+k*interval), day, 1, 30, 0, 0, zone)
				return start, start.Day() == day
			})
		}
	}
	first := time.Date(2019, 3, 9, 23, 30, 0, 0, zone)
	for _, interval := range []int{1, 2, 13} {
		rule := mustRule(t, "FREQ=DAILY;INTERVAL="+strconv.Itoa(interval))
		check("daily", eventSchedule{First: first, Length: 2 * time.Hour, Rule: rule, Zone: zone}, func(k int) (time.Time, bool) {
			return time.Date(2019, 3, 9+k*interval, 23, 30, 0, 0, zone), true
		})
		rule = mustRule(t, "FREQ=WEEKLY;INTERVAL="+strconv.Itoa(interval))
		check("weekly", eventSchedule{First: first, Length: 2 * time.Hour, Rule: rule, Zone: zone}, func(k int) (time.Time, bool) {
			return time.Date(2019, 3, 9+7*k*interval, 23, 30, 0, 0, zone), true
		})
	}
}
