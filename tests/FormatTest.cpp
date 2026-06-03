// Self-contained tests for the human-readable formatters in UiHelpers
// (humanSize / humanSpeed / humanTime). No QtTest; a tiny CK macro keeps it
// buildable with Qt6::Core + Qt6::Widgets. Run via the `nexa_format_test` target.

#include "ui/UiHelpers.h"
#include <cstdio>

using namespace nexa;

static int g_fail = 0, g_pass = 0;
#define CK(cond, msg) do { \
    if (cond) { ++g_pass; } \
    else { ++g_fail; std::fprintf(stderr, "FAIL: %s  (%s:%d)\n", msg, __FILE__, __LINE__); } \
} while (0)

int main()
{
    // humanSize: integer bytes, 1 decimal once past B.
    CK(humanSize(0)    == QStringLiteral("0 B"),   "0 -> 0 B");
    CK(humanSize(512)  == QStringLiteral("512 B"), "512 -> 512 B");
    CK(humanSize(1536) == QStringLiteral("1.5 KB"),"1536 -> 1.5 KB");
    CK(humanSize(5LL * 1024 * 1024) == QStringLiteral("5.0 MB"), "5 MiB -> 5.0 MB");
    CK(humanSize(-1)   == QStringLiteral("?"),     "negative -> ?");

    // humanSpeed: blank below 1 B/s, else humanSize + "/s".
    CK(humanSpeed(0.5).isEmpty(),                  "sub-1 B/s -> blank");
    CK(humanSpeed(2048.0) == QStringLiteral("2.0 KB/s"), "2048 B/s -> 2.0 KB/s");

    // humanTime: em-dash for negative; s / m s / h m / d h buckets.
    CK(humanTime(-1)   == QStringLiteral("—"), "negative time -> em-dash");
    CK(humanTime(12)   == QStringLiteral("12s"),    "12 -> 12s");
    CK(humanTime(83)   == QStringLiteral("1m 23s"), "83 -> 1m 23s");
    CK(humanTime(3661) == QStringLiteral("1h 01m"), "3661 -> 1h 01m");

    std::printf("\nFORMAT TESTS: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
