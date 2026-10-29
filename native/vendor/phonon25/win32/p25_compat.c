#include "p25_win32.h"
int clock_gettime(int id, struct timespec *ts) {
    (void)id; LARGE_INTEGER f, c; QueryPerformanceFrequency(&f); QueryPerformanceCounter(&c);
    ts->tv_sec = (time_t)(c.QuadPart / f.QuadPart);
    ts->tv_nsec = (long)(((c.QuadPart % f.QuadPart) * 1000000000LL) / f.QuadPart);
    return 0;
}
int setenv(const char *name, const char *value, int overwrite) { (void)overwrite; return _putenv_s(name, value); }
