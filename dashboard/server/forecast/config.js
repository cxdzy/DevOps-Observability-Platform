// Every number the forecast uses, in one place. Each forecast_events row stores the version, so a
// change of any value here must also change the version. The values are fixed before the
// evaluation runs; see the Rules of the forecast task (section 2).
const FORECAST_CONFIG = Object.freeze({
  version: "2026-11-22.1",

  // The job runs once a minute.
  intervalMs: 60 * 1000,

  memory: Object.freeze({
    // 30 minutes of points at 60 second steps.
    windowMin: 30,
    stepSec: 60,
    // Rolling minimum over 5 minutes, so a garbage collection saw-tooth is not read as a trend.
    envelopeMin: 5,
    // After a restart the window starts again and needs at least 10 minutes of points.
    minMinutes: 10,
    // Warning rule: slope above 0, R squared at least 0.80, rise over the window at least 4 percent
    // of the limit, and at most 60 minutes to the limit.
    minR2: 0.8,
    minRisePct: 4,
    maxEstMin: 60,
    // An open warning closes when the estimate rises above 90 minutes.
    closeEstMin: 90,
  }),

  disk: Object.freeze({
    // 6 hours of points at 5 minute steps. The envelope is one step, so no smoothing.
    windowMin: 360,
    stepSec: 300,
    envelopeMin: 5,
    minMinutes: 10,
    // Warning rule: rise at least 2 percent of capacity, R squared at least 0.80, at most 12 hours
    // to full. An open warning closes above 18 hours.
    minR2: 0.8,
    minRisePct: 2,
    maxEstMin: 12 * 60,
    closeEstMin: 18 * 60,
    // The filesystems that are forecast, on every active server.
    mountpoints: Object.freeze(["/"]),
    // Real filesystem types only (no tmpfs, overlay or vfat).
    fstypes: Object.freeze(["ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs"]),
  }),

  restarts: Object.freeze({
    // Three or more start time changes of one container in 15 minutes.
    windowMin: 15,
    minChanges: 3,
  }),

  // A series whose last point is older than 5 minutes is not current: the container is gone, or
  // (for the host series) cAdvisor is not answering. Prometheus marks a series stale within one scrape.
  staleAfterMin: 5,

  // An open warning closes when its rule has been false for 10 minutes in a row.
  closeAfterFalseMin: 10,

  // A limit at or above this is the kernel's "no limit" value (about 9.2e18 bytes).
  unlimitedBytes: 2 ** 62,

  // forecast-report.js. A warning is true when the outcome comes within 1.5 times the estimate at
  // open plus 10 minutes. The outcome for memory and disk is 95 percent of the limit or capacity.
  // A miss is an event with no warning open in the 120 minutes before it.
  report: Object.freeze({
    outcomePct: 95,
    estFactor: 1.5,
    estPlusMin: 10,
    missLookbackMin: 120,
    // Prometheus allows about 11000 points per series, so history is read in pieces of 7 days.
    chunkHours: 7 * 24,
    stepSec: 60,
    diskStepSec: 300,
  }),

  // GET /api/internal/forecast/new: at most 20 rows, about 60 requests a minute, and a token of at
  // least 32 characters.
  internal: Object.freeze({
    maxRows: 20,
    ratePerMinute: 60,
    minTokenLength: 32,
  }),

  // GET /api/forecast/events: at most 31 days and 500 rows per answer, the last 24 hours by default.
  events: Object.freeze({
    maxDays: 31,
    maxRows: 500,
    defaultHours: 24,
  }),
});

module.exports = { FORECAST_CONFIG };
