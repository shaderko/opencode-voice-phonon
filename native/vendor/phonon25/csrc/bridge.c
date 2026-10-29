#include "phonon25.h"
#include <stdlib.h>

void p25_free(void *p) { free(p); }
void p25_set_verbose(int v) { extern int p25_verbose; p25_verbose = v; }
