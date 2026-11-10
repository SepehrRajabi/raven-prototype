package http

import (
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Scheduled events repeat by a small subset of RFC 5545 rules: FREQ=DAILY|WEEKLY|MONTHLY,
// INTERVAL, BYDAY (weekly only) and UNTIL or COUNT. Occurrences are computed on read from
// the first start and the creator's time zone: each one keeps the first start's wall-clock
// time in that zone, so "every Sunday 18:00" stays at 18:00 across daylight saving.
//
// This is hand-rolled rather than a dependency: the subset is three frequencies, and
// time.Date in the event's zone already does the DST-correct part.

const (
	eventRuleMaxCount    = 500
	eventRuleMaxInterval = 99
	eventRuleUntilLayout = "20060102T150405Z"
	// eventRuleMaxPeriods bounds a search through a series, whatever the rule.
	eventRuleMaxPeriods = 20000
)

var errEventRule = errors.New("unsupported recurrence rule")

var eventRuleDays = map[string]time.Weekday{
	"MO": time.Monday, "TU": time.Tuesday, "WE": time.Wednesday, "TH": time.Thursday,
	"FR": time.Friday, "SA": time.Saturday, "SU": time.Sunday,
}

type eventRule struct {
	Freq     string
	Interval int
	ByDay    []time.Weekday
	Until    *time.Time
	Count    int
}

// parseEventRule reads a rule such as "FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,WE;COUNT=10".
// Anything outside the subset is refused rather than ignored.
func parseEventRule(text string) (eventRule, error) {
	rule := eventRule{Interval: 1}
	seen := map[string]bool{}
	for _, part := range strings.Split(strings.TrimPrefix(strings.TrimSpace(text), "RRULE:"), ";") {
		key, value, ok := strings.Cut(part, "=")
		key = strings.ToUpper(strings.TrimSpace(key))
		value = strings.ToUpper(strings.TrimSpace(value))
		if !ok || value == "" || seen[key] {
			return eventRule{}, errEventRule
		}
		seen[key] = true
		switch key {
		case "FREQ":
			if value != "DAILY" && value != "WEEKLY" && value != "MONTHLY" {
				return eventRule{}, errEventRule
			}
			rule.Freq = value
		case "INTERVAL":
			n, err := strconv.Atoi(value)
			if err != nil || n < 1 || n > eventRuleMaxInterval {
				return eventRule{}, errEventRule
			}
			rule.Interval = n
		case "BYDAY":
			for _, day := range strings.Split(value, ",") {
				weekday, ok := eventRuleDays[day]
				if !ok {
					return eventRule{}, errEventRule
				}
				rule.ByDay = append(rule.ByDay, weekday)
			}
		case "UNTIL":
			at, err := time.Parse(eventRuleUntilLayout, value)
			if err != nil {
				return eventRule{}, errEventRule
			}
			rule.Until = &at
		case "COUNT":
			n, err := strconv.Atoi(value)
			if err != nil || n < 1 || n > eventRuleMaxCount {
				return eventRule{}, errEventRule
			}
			rule.Count = n
		default:
			return eventRule{}, errEventRule
		}
	}
	if rule.Freq == "" || (rule.Until != nil && rule.Count > 0) || (len(rule.ByDay) > 0 && rule.Freq != "WEEKLY") {
		return eventRule{}, errEventRule
	}
	rule.ByDay = uniqueWeekdays(rule.ByDay)
	return rule, nil
}

// uniqueWeekdays sorts days Monday first (RFC 5545's default week start) and drops repeats.
func uniqueWeekdays(days []time.Weekday) []time.Weekday {
	seen := map[time.Weekday]bool{}
	out := []time.Weekday{}
	for _, day := range days {
		if !seen[day] {
			seen[day] = true
			out = append(out, day)
		}
	}
	sort.Slice(out, func(i, j int) bool { return mondayIndex(out[i]) < mondayIndex(out[j]) })
	return out
}

func mondayIndex(day time.Weekday) int {
	return (int(day) + 6) % 7
}

// String writes the rule back in a canonical form.
func (rule eventRule) String() string {
	parts := []string{"FREQ=" + rule.Freq}
	if rule.Interval > 1 {
		parts = append(parts, "INTERVAL="+strconv.Itoa(rule.Interval))
	}
	if len(rule.ByDay) > 0 {
		names := make([]string, 0, len(rule.ByDay))
		for _, day := range rule.ByDay {
			for name, weekday := range eventRuleDays {
				if weekday == day {
					names = append(names, name)
				}
			}
		}
		parts = append(parts, "BYDAY="+strings.Join(names, ","))
	}
	if rule.Until != nil {
		parts = append(parts, "UNTIL="+rule.Until.UTC().Format(eventRuleUntilLayout))
	}
	if rule.Count > 0 {
		parts = append(parts, "COUNT="+strconv.Itoa(rule.Count))
	}
	return strings.Join(parts, ";")
}

// eventOccurrence is one sitting of an event: its start and end, in UTC.
type eventOccurrence struct {
	Start time.Time
	End   time.Time
}

// eventSchedule is what occurrences are computed from.
type eventSchedule struct {
	First  time.Time
	Length time.Duration
	Rule   *eventRule
	Zone   *time.Location
}

// around returns the first occurrence that has not ended at now (ok false when the series
// is over) and the occurrence just before it (hasPrev false when there is none).
func (sched eventSchedule) around(now time.Time) (next eventOccurrence, ok bool, prev eventOccurrence, hasPrev bool) {
	if sched.Rule == nil {
		one := eventOccurrence{Start: sched.First.UTC(), End: sched.First.Add(sched.Length).UTC()}
		if one.End.After(now) {
			return one, true, eventOccurrence{}, false
		}
		return eventOccurrence{}, false, one, true
	}
	rule := *sched.Rule
	zone := sched.Zone
	if zone == nil {
		zone = time.UTC
	}
	local := sched.First.In(zone)
	year, month, day := local.Date()
	hour, minute, second := local.Clock()
	at := func(offsetDays int) time.Time {
		date := time.Date(year, month, day+offsetDays, 12, 0, 0, 0, time.UTC)
		return time.Date(date.Year(), date.Month(), date.Day(), hour, minute, second, 0, zone)
	}

	days := rule.ByDay
	if rule.Freq == "WEEKLY" && len(days) == 0 {
		days = []time.Weekday{local.Weekday()}
	}
	weekStart := -mondayIndex(local.Weekday())

	candidates := func(period int) []time.Time {
		switch rule.Freq {
		case "DAILY":
			return []time.Time{at(period * rule.Interval)}
		case "WEEKLY":
			out := make([]time.Time, 0, len(days))
			for _, d := range days {
				out = append(out, at(weekStart+period*7*rule.Interval+mondayIndex(d)))
			}
			return out
		default:
			months := int(month) - 1 + period*rule.Interval
			y, m := year+months/12, time.Month(months%12+1)
			start := time.Date(y, m, day, hour, minute, second, 0, zone)
			if start.Month() != m {
				// No such day this month (the 31st in April): RFC 5545 skips it.
				return nil
			}
			return []time.Time{start}
		}
	}

	// Without COUNT the position in the series does not matter, so start a little before
	// now instead of walking from the first start.
	period := 0
	if rule.Count == 0 {
		target := now
		if rule.Until != nil && rule.Until.Before(target) {
			target = *rule.Until
		}
		var periodLength time.Duration
		switch rule.Freq {
		case "DAILY":
			periodLength = 24 * time.Hour * time.Duration(rule.Interval)
		case "WEEKLY":
			periodLength = 7 * 24 * time.Hour * time.Duration(rule.Interval)
		default:
			periodLength = 28 * 24 * time.Hour * time.Duration(rule.Interval)
		}
		if elapsed := target.Sub(sched.First) - sched.Length; elapsed > 0 {
			period = int(elapsed/periodLength) - 2
			if period < 0 {
				period = 0
			}
		}
	}

	count := 0
	for limit := period + eventRuleMaxPeriods; period < limit; period++ {
		for _, start := range candidates(period) {
			if start.Before(sched.First) {
				continue
			}
			if rule.Until != nil && start.After(*rule.Until) {
				return eventOccurrence{}, false, prev, hasPrev
			}
			count++
			if rule.Count > 0 && count > rule.Count {
				return eventOccurrence{}, false, prev, hasPrev
			}
			one := eventOccurrence{Start: start.UTC(), End: start.Add(sched.Length).UTC()}
			if one.End.After(now) {
				return one, true, prev, hasPrev
			}
			prev, hasPrev = one, true
		}
	}
	return eventOccurrence{}, false, prev, hasPrev
}

// last returns the final occurrence of a bounded series, or false for an endless one.
func (sched eventSchedule) last() (eventOccurrence, bool) {
	if sched.Rule == nil {
		return eventOccurrence{Start: sched.First.UTC(), End: sched.First.Add(sched.Length).UTC()}, true
	}
	if sched.Rule.Count == 0 && sched.Rule.Until == nil {
		return eventOccurrence{}, false
	}
	far := sched.First.AddDate(100, 0, 0)
	if _, ok, prev, hasPrev := sched.around(far); !ok && hasPrev {
		return prev, true
	}
	return eventOccurrence{}, false
}
