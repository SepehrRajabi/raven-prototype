package http

import (
	"fmt"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gofiber/fiber/v2"
)

// serverMetrics is the small set of counters and timings an operator needs to tell
// whether messaging is healthy: are sends succeeding, how long does delivery take, are
// clients falling behind, and is the database pool keeping up. It is exposed in the
// Prometheus text format at /v1/admin/metrics. Nothing in it identifies a person or a
// conversation, and no message text ever reaches it.
type serverMetrics struct {
	startedAt time.Time

	chatSends       labelledCounter // by result
	chatEvents      labelledCounter // by event type
	chatRateLimited labelledCounter // by route
	// chatLinkPreviews counts link preview fetches by outcome: ok, nothing (the page had
	// nothing to show), blocked (not a public address), failed, stale (the message
	// changed meanwhile) and dropped (the queue was full).
	chatLinkPreviews labelledCounter
	streamsClosed    labelledCounter // by reason
	streamsOpened    atomic.Uint64
	streamsOpen      atomic.Int64
	changesRequests  atomic.Uint64
	changesResets    atomic.Uint64

	sendDuration   *histogram // whole send request, in ms
	publishDelay   *histogram // commit to frames queued, in ms
	streamWriteLag *histogram // frame queued to written to the socket, in ms
	fanout         *histogram // recipients per chat event
}

func newServerMetrics() *serverMetrics {
	latency := []float64{1, 2, 5, 10, 20, 50, 75, 100, 200, 500, 1000, 5000}
	return &serverMetrics{
		startedAt:      time.Now(),
		sendDuration:   newHistogram(latency),
		publishDelay:   newHistogram(latency),
		streamWriteLag: newHistogram(latency),
		fanout:         newHistogram([]float64{1, 2, 5, 10, 25, 50, 100, 250, 500, 1000}),
	}
}

type labelledCounter struct {
	mu     sync.Mutex
	values map[string]uint64
}

func (c *labelledCounter) inc(label string) {
	c.mu.Lock()
	if c.values == nil {
		c.values = map[string]uint64{}
	}
	c.values[label]++
	c.mu.Unlock()
}

func (c *labelledCounter) snapshot() map[string]uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]uint64, len(c.values))
	for label, value := range c.values {
		out[label] = value
	}
	return out
}

// histogram counts observations into fixed upper bounds, cumulatively when written out.
type histogram struct {
	bounds []float64
	counts []atomic.Uint64 // one per bound, plus one for everything above the last
	sumMu  sync.Mutex
	sum    float64
}

func newHistogram(bounds []float64) *histogram {
	return &histogram{bounds: bounds, counts: make([]atomic.Uint64, len(bounds)+1)}
}

func (h *histogram) observe(value float64) {
	index := sort.SearchFloat64s(h.bounds, value)
	h.counts[index].Add(1)
	h.sumMu.Lock()
	h.sum += value
	h.sumMu.Unlock()
}

func (h *histogram) observeSince(start time.Time) {
	h.observe(float64(time.Since(start).Microseconds()) / 1000)
}

func (h *histogram) write(out *strings.Builder, name, help string) {
	fmt.Fprintf(out, "# HELP %s %s\n# TYPE %s histogram\n", name, help, name)
	var cumulative uint64
	for index, bound := range h.bounds {
		cumulative += h.counts[index].Load()
		fmt.Fprintf(out, "%s_bucket{le=\"%g\"} %d\n", name, bound, cumulative)
	}
	cumulative += h.counts[len(h.bounds)].Load()
	fmt.Fprintf(out, "%s_bucket{le=\"+Inf\"} %d\n", name, cumulative)
	h.sumMu.Lock()
	sum := h.sum
	h.sumMu.Unlock()
	fmt.Fprintf(out, "%s_sum %g\n%s_count %d\n", name, sum, name, cumulative)
}

func writeCounter(out *strings.Builder, name, help string, value uint64) {
	fmt.Fprintf(out, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", name, help, name, name, value)
}

func writeGauge(out *strings.Builder, name, help string, value float64) {
	fmt.Fprintf(out, "# HELP %s %s\n# TYPE %s gauge\n%s %g\n", name, help, name, name, value)
}

func writeLabelled(out *strings.Builder, name, help, label string, values map[string]uint64) {
	fmt.Fprintf(out, "# HELP %s %s\n# TYPE %s counter\n", name, help, name)
	labels := make([]string, 0, len(values))
	for value := range values {
		labels = append(labels, value)
	}
	sort.Strings(labels)
	for _, value := range labels {
		fmt.Fprintf(out, "%s{%s=%q} %d\n", name, label, value, values[value])
	}
}

func (s *Server) adminMetrics(c *fiber.Ctx) error {
	m := s.metrics
	var out strings.Builder

	writeLabelled(&out, "raven_chat_sends_total", "Message sends by outcome.", "result", m.chatSends.snapshot())
	writeLabelled(&out, "raven_chat_link_previews_total", "Link preview fetches by outcome.", "result", m.chatLinkPreviews.snapshot())
	m.sendDuration.write(&out, "raven_chat_send_duration_ms", "Time to handle a message send, in milliseconds.")
	m.publishDelay.write(&out, "raven_chat_publish_delay_ms", "Time from a chat change being committed to its events being queued, in milliseconds.")
	m.streamWriteLag.write(&out, "raven_stream_write_lag_ms", "Time a chat event waits in a client's queue before it is written, in milliseconds.")
	m.fanout.write(&out, "raven_chat_fanout_recipients", "People each chat event is addressed to.")
	writeLabelled(&out, "raven_chat_events_total", "Chat events published, by type.", "type", m.chatEvents.snapshot())
	writeLabelled(&out, "raven_chat_rate_limited_total", "Chat requests refused by a rate limit, by route.", "route", m.chatRateLimited.snapshot())
	writeCounter(&out, "raven_chat_changes_requests_total", "Catch-up requests from clients that noticed a gap or reconnected.", m.changesRequests.Load())
	writeCounter(&out, "raven_chat_changes_resets_total", "Catch-up requests too far behind to answer incrementally.", m.changesResets.Load())

	writeGauge(&out, "raven_streams_open", "Event streams currently connected.", float64(m.streamsOpen.Load()))
	writeCounter(&out, "raven_streams_opened_total", "Event streams opened since start.", m.streamsOpened.Load())
	writeLabelled(&out, "raven_streams_closed_total", "Event streams closed, by reason. 'lagged' means the client could not keep up.", "reason", m.streamsClosed.snapshot())

	stats := s.db.Stats()
	writeGauge(&out, "raven_db_open_connections", "Database connections open.", float64(stats.OpenConnections))
	writeGauge(&out, "raven_db_in_use_connections", "Database connections in use.", float64(stats.InUse))
	writeGauge(&out, "raven_db_max_open_connections", "Database connection limit (0 means unlimited).", float64(stats.MaxOpenConnections))
	writeCounter(&out, "raven_db_wait_count_total", "Times a request had to wait for a database connection.", uint64(stats.WaitCount))
	writeGauge(&out, "raven_db_wait_duration_ms_total", "Total time spent waiting for a database connection, in milliseconds.", float64(stats.WaitDuration.Milliseconds()))

	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	writeGauge(&out, "raven_go_goroutines", "Goroutines running.", float64(runtime.NumGoroutine()))
	writeGauge(&out, "raven_go_heap_alloc_bytes", "Heap memory in use.", float64(memory.HeapAlloc))
	writeGauge(&out, "raven_go_sys_bytes", "Memory obtained from the operating system.", float64(memory.Sys))
	writeGauge(&out, "raven_process_uptime_seconds", "Seconds since the API started.", time.Since(m.startedAt).Seconds())

	c.Set(fiber.HeaderContentType, "text/plain; version=0.0.4; charset=utf-8")
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.SendString(out.String())
}
