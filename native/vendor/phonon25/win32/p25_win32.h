#pragma once
#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS
#endif
#define NOMINMAX
#include <windows.h>
#include <process.h>
#include <io.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <time.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>

/* ---- pthread subset ---- */
typedef HANDLE pthread_t;
typedef CRITICAL_SECTION pthread_mutex_t;
typedef CONDITION_VARIABLE pthread_cond_t;
typedef INIT_ONCE pthread_once_t;
typedef DWORD pthread_key_t;
#define PTHREAD_ONCE_INIT INIT_ONCE_STATIC_INIT

typedef struct { void *(*fn)(void *); void *arg; } p25_thr_ctx;
static unsigned __stdcall p25_thr_tramp(void *p) {
    p25_thr_ctx *c = (p25_thr_ctx *)p;
    void *(*fn)(void *) = c->fn; void *arg = c->arg; free(c); fn(arg); return 0;
}
static int pthread_create(pthread_t *t, const void *attr, void *(*fn)(void *), void *arg) {
    (void)attr; p25_thr_ctx *c = (p25_thr_ctx *)malloc(sizeof(*c)); if (!c) return -1;
    c->fn = fn; c->arg = arg;
    uintptr_t h = _beginthreadex(NULL, 0, p25_thr_tramp, c, 0, NULL);
    if (!h) { free(c); return -1; } *t = (HANDLE)h; return 0;
}
static int pthread_join(pthread_t t, void **ret) { (void)ret; WaitForSingleObject(t, INFINITE); CloseHandle(t); return 0; }
static int pthread_mutex_init(pthread_mutex_t *m, const void *a) { (void)a; InitializeCriticalSection(m); return 0; }
static int pthread_mutex_destroy(pthread_mutex_t *m) { DeleteCriticalSection(m); return 0; }
static int pthread_mutex_lock(pthread_mutex_t *m) { EnterCriticalSection(m); return 0; }
static int pthread_mutex_unlock(pthread_mutex_t *m) { LeaveCriticalSection(m); return 0; }
static int pthread_cond_init(pthread_cond_t *c, const void *a) { (void)a; InitializeConditionVariable(c); return 0; }
static int pthread_cond_destroy(pthread_cond_t *c) { (void)c; return 0; }
static int pthread_cond_wait(pthread_cond_t *c, pthread_mutex_t *m) { SleepConditionVariableCS(c, m, INFINITE); return 0; }
static int pthread_cond_broadcast(pthread_cond_t *c) { WakeAllConditionVariable(c); return 0; }
static BOOL CALLBACK p25_once_cb(PINIT_ONCE o, PVOID p, PVOID *ctx) { (void)o; (void)ctx; ((void (*)(void))p)(); return TRUE; }
static int pthread_once(pthread_once_t *o, void (*fn)(void)) { InitOnceExecuteOnce(o, p25_once_cb, (PVOID)fn, NULL); return 0; }
static int pthread_key_create(pthread_key_t *k, void (*destr)(void *)) { (void)destr; *k = TlsAlloc(); return *k == TLS_OUT_OF_INDEXES ? -1 : 0; }
static void *pthread_getspecific(pthread_key_t k) { return TlsGetValue(k); }
static int pthread_setspecific(pthread_key_t k, const void *v) { return TlsSetValue(k, (LPVOID)v) ? 0 : -1; }
#define __thread __declspec(thread)
#define sched_yield() SwitchToThread()
#define _SC_NPROCESSORS_ONLN 0
static long sysconf(int name) { (void)name; SYSTEM_INFO si; GetSystemInfo(&si); return (long)si.dwNumberOfProcessors; }

/* ---- POSIX file APIs ---- */
#define open _open
#define close _close
#define fstat _fstat64
#define stat _stat64
#ifndef PROT_READ
#define PROT_READ 1
#define MAP_PRIVATE 2
#define MAP_FAILED ((void *)0)
#endif
static void *p25_mmap_fd(int fd, size_t len) {
    HANDLE h = (HANDLE)_get_osfhandle(fd);
    if (h == INVALID_HANDLE_VALUE) return NULL;
    HANDLE m = CreateFileMappingA(h, NULL, PAGE_READONLY, 0, 0, NULL);
    if (!m) return NULL;
    void *p = MapViewOfFile(m, FILE_MAP_READ, 0, 0, len);
    CloseHandle(m);
    return p;
}
#define mmap(addr, len, prot, flags, fd, off) p25_mmap_fd((fd), (len))
#define munmap(addr, len) (UnmapViewOfFile((addr)) ? 0 : -1)


/* ---- Windows shims implemented in p25_compat.c ---- */
int clock_gettime(int id, struct timespec *ts);
int setenv(const char *name, const char *value, int overwrite);
#define p25_aligned_alloc(a, s) _aligned_malloc((s), (a))
#define p25_aligned_free(p) _aligned_free(p)
