/*
 * mmap-append-probe — real `mmap(MAP_SHARED)` append measurement for DB-SUPA-7.
 *
 * Node has no mmap API for files, so the storage-modes harness compiles this
 * probe (when a C compiler is available) to obtain a REAL mmap datapoint
 * instead of a proxy. It is a timing instrument only: it writes a fixed byte
 * pattern and prints one line of JSON. It never touches anything but the file
 * path it is given (the harness passes a path under an isolated /tmp workdir).
 *
 * Build:  cc -O2 -o mmap-append-probe mmap-append-probe.c
 * Usage:  ./mmap-append-probe <file> <records> <record_bytes> <msync_every> [warmup]
 *
 *   msync_every = 0  -> no barrier (page-cache write, buffered-equivalent RPO)
 *   msync_every = N  -> msync(MS_SYNC) on the touched page range every N records
 *                       (the mmap analogue of one fdatasync per batch)
 *
 * Output (stdout, single line): {"ok":true,"mode":"mmap","msync_every":N,...}
 * Timing unit: nanoseconds (CLOCK_MONOTONIC). Record latencies are measured for
 * the records only; warmup records are written but excluded from the sample.
 *
 * Exit codes: 0 ok, 1 runtime failure (JSON error line on stdout), 2 usage.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static long ns_now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long)ts.tv_sec * 1000000000L + (long)ts.tv_nsec;
}

static int cmp_long(const void *a, const void *b) {
  long x = *(const long *)a, y = *(const long *)b;
  return x < y ? -1 : (x > y ? 1 : 0);
}

static long pct(const long *sorted, long n, double p) {
  if (n <= 0) return 0;
  long idx = (long)(p * (double)(n - 1) + 0.5);
  if (idx < 0) idx = 0;
  if (idx > n - 1) idx = n - 1;
  return sorted[idx];
}

int main(int argc, char **argv) {
  if (argc < 5) {
    fprintf(stderr,
            "usage: %s <file> <records> <record_bytes> <msync_every> [warmup]\n",
            argv[0]);
    return 2;
  }
  const char *path = argv[1];
  long records = atol(argv[2]);
  long record_bytes = atol(argv[3]);
  long msync_every = atol(argv[4]);
  long warmup = (argc > 5) ? atol(argv[5]) : 0;
  if (records <= 0 || record_bytes <= 0) {
    fprintf(stderr, "records and record_bytes must be > 0\n");
    return 2;
  }

  long total = records + warmup;
  off_t file_size = (off_t)total * (off_t)record_bytes;
  long page = sysconf(_SC_PAGESIZE);
  if (page <= 0) page = 4096;

  int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    printf("{\"ok\":false,\"mode\":\"mmap\",\"stage\":\"open\",\"errno\":%d,"
           "\"error\":\"%s\"}\n",
           errno, strerror(errno));
    return 1;
  }
  if (ftruncate(fd, file_size) != 0) {
    printf("{\"ok\":false,\"mode\":\"mmap\",\"stage\":\"ftruncate\",\"errno\":%d,"
           "\"error\":\"%s\"}\n",
           errno, strerror(errno));
    close(fd);
    return 1;
  }

  void *base = mmap(NULL, (size_t)file_size, PROT_READ | PROT_WRITE, MAP_SHARED,
                    fd, 0);
  if (base == MAP_FAILED) {
    printf("{\"ok\":false,\"mode\":\"mmap\",\"stage\":\"mmap\",\"errno\":%d,"
           "\"error\":\"%s\"}\n",
           errno, strerror(errno));
    close(fd);
    return 1;
  }

  char *pattern = malloc((size_t)record_bytes);
  if (!pattern) {
    printf("{\"ok\":false,\"mode\":\"mmap\",\"stage\":\"malloc\"}\n");
    return 1;
  }
  memset(pattern, 'x', (size_t)record_bytes);

  long *lat = malloc(sizeof(long) * (size_t)records);
  if (!lat) {
    printf("{\"ok\":false,\"mode\":\"mmap\",\"stage\":\"malloc-lat\"}\n");
    return 1;
  }

  long msync_calls = 0;

  for (long i = 0; i < total; i++) {
    char *dst = (char *)base + (off_t)i * (off_t)record_bytes;
    long t0 = ns_now();
    memcpy(dst, pattern, (size_t)record_bytes);
    if (msync_every > 0 && (i + 1) % msync_every == 0) {
      /* msync the page-aligned range covering the region just written */
      char *start = (char *)((unsigned long)dst & ~(unsigned long)(page - 1));
      size_t len = (size_t)((dst + record_bytes) - start);
      len = ((len + (size_t)page - 1) / (size_t)page) * (size_t)page;
      if (msync(start, len, MS_SYNC) != 0) {
        printf("{\"ok\":false,\"mode\":\"mmap\",\"stage\":\"msync\",\"errno\":%d,"
               "\"error\":\"%s\"}\n",
               errno, strerror(errno));
        return 1;
      }
      msync_calls++;
    }
    long t2 = ns_now();
    if (i >= warmup) {
      lat[i - warmup] = t2 - t0;
    }
  }

  /* Flush whatever the last incomplete batch left dirty (mirror the tail of a
   * batch protocol), then count it. */
  if (msync_every > 0 && (total % msync_every) != 0) {
    if (msync(base, (size_t)file_size, MS_SYNC) != 0) {
      printf("{\"ok\":false,\"mode\":\"mmap\",\"stage\":\"msync-tail\",\"errno\":%d,"
             "\"error\":\"%s\"}\n",
             errno, strerror(errno));
      return 1;
    }
    msync_calls++;
  }

  long long sum = 0;
  long max = 0;
  for (long i = 0; i < records; i++) {
    sum += lat[i];
    if (lat[i] > max) max = lat[i];
  }
  long *sorted = malloc(sizeof(long) * (size_t)records);
  memcpy(sorted, lat, sizeof(long) * (size_t)records);
  qsort(sorted, (size_t)records, sizeof(long), cmp_long);

  double mean = (double)sum / (double)records;
  double throughput = mean > 0 ? 1e9 / mean : 0.0;

  printf("{\"ok\":true,\"mode\":\"mmap\",\"driver\":\"c-mmap\","
         "\"records\":%ld,\"record_bytes\":%ld,\"warmup\":%ld,"
         "\"msync_every\":%ld,\"msync_calls\":%ld,"
         "\"p50_ns\":%ld,\"p95_ns\":%ld,\"p99_ns\":%ld,\"max_ns\":%ld,"
         "\"mean_ns\":%.1f,\"throughput_rec_per_s\":%.1f,"
         "\"bytes_written\":%lld}\n",
         records, record_bytes, warmup, msync_every, msync_calls,
         pct(sorted, records, 0.50), pct(sorted, records, 0.95),
         pct(sorted, records, 0.99), max, mean, throughput,
         (long long)file_size);

  munmap(base, (size_t)file_size);
  close(fd);
  free(sorted);
  free(lat);
  free(pattern);
  return 0;
}
