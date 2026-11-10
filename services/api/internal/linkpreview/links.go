package linkpreview

import (
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"
)

// trailingPunctuation ends a sentence that ends with an address; it is not part of it.
const trailingPunctuation = ".,;:!?'\"»”’،؛؟…"

var closers = map[rune]rune{')': '(', ']': '[', '}': '{'}

// FirstLink returns the first web address written out in full in a message, found the way
// the desktop client finds the links it draws (apps/desktop/src/lib/chat/format.ts): not
// in code, starting where a word does, without the punctuation of the sentence around
// it. It returns "" when there is none.
func FirstLink(body string) string {
	lines := strings.Split(body, "\n")
	for i := 0; i < len(lines); i++ {
		if strings.HasPrefix(strings.TrimLeftFunc(lines[i], unicode.IsSpace), "```") {
			closing := -1
			for j := i + 1; j < len(lines); j++ {
				if strings.TrimSpace(lines[j]) == "```" {
					closing = j
					break
				}
			}
			if closing > i {
				i = closing
				continue
			}
		}
		if link := firstLinkInLine(lines[i]); link != "" {
			return link
		}
	}
	return ""
}

func firstLinkInLine(line string) string {
	for i := 0; i < len(line); i++ {
		switch line[i] {
		case '`':
			// A code span, when it closes and is not empty, is skipped whole.
			if end := strings.IndexByte(line[i+1:], '`'); end > 0 {
				i += end + 1
			}
		case 'h', 'H':
			if before, _ := utf8.DecodeLastRuneInString(line[:i]); i > 0 && isWordRune(before) {
				continue
			}
			lower := strings.ToLower(line[i:min(len(line), i+8)])
			if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
				continue
			}
			end := strings.IndexFunc(line[i:], func(r rune) bool { return unicode.IsSpace(r) || r == '<' || r == '>' })
			if end < 0 {
				end = len(line) - i
			}
			if link := readAddress(line[i : i+end]); link != "" {
				return link
			}
		}
	}
	return ""
}

func isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_'
}

// readAddress takes the punctuation that merely follows an address off its end and checks
// that what is left is an http or https address with a host.
func readAddress(raw string) string {
	for raw != "" {
		last, size := utf8.DecodeLastRuneInString(raw)
		if strings.ContainsRune(trailingPunctuation, last) {
			raw = raw[:len(raw)-size]
			continue
		}
		if opener, ok := closers[last]; ok {
			// A closing bracket belongs to the address only if it closes one inside it.
			body := raw[:len(raw)-size]
			if strings.Count(body, string(opener)) <= strings.Count(body, string(last)) {
				raw = body
				continue
			}
		}
		break
	}
	cleaned := strings.Map(func(r rune) rune {
		if isDirectionControl(r) {
			return -1
		}
		return r
	}, raw)
	parsed, err := url.Parse(cleaned)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return ""
	}
	return parsed.String()
}
