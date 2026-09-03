# Third-party notices

`dist/bungee.wasm` is compiled from the following, all fetched unmodified at the revisions pinned
in `native/CMakeLists.txt`. The wrapper that exposes them, `native/bungee_web.cpp`, and everything
else in this repository is MIT (see `LICENSE`).

## Bungee Basic

Copyright (C) 2020-2026 Parabola Research Limited. Licensed under the Mozilla Public License 2.0:
<https://mozilla.org/MPL/2.0/>. Source Code Form: <https://github.com/bungee-audio-stretch/bungee>,
commit `8cb6977d0c1a1b411ac320493b3c7f5182ed2d22` (v2.4.30). No Bungee file is modified here; the
build sets compiler flags only.

## Eigen

Licensed under the Mozilla Public License 2.0: <https://mozilla.org/MPL/2.0/>. Source Code Form:
<https://gitlab.com/libeigen/eigen>, commit `c29c800126982c561e8d0b9255dc65474cd98de3`, as Bungee's
`submodules/eigen`. Bungee uses only Eigen's MPL-2.0 core; the LGPL-licensed parts of Eigen are not
compiled in.

## PFFFT

Source: <https://bitbucket.org/jpommier/pffft>, commit `02fe7715a5bf8bfd914681c53429600f94e0f536`,
as Bungee's `submodules/pffft`. Its notice, reproduced as its license requires:

```
/* Copyright (c) 2013  Julien Pommier ( pommier@modartt.com )

   Based on original fortran 77 code from FFTPACKv4 from NETLIB,
   authored by Dr Paul Swarztrauber of NCAR, in 1985.

   As confirmed by the NCAR fftpack software curators, the following
   FFTPACKv5 license applies to FFTPACKv4 sources. My changes are
   released under the same terms.

   FFTPACK license:

   http://www.cisl.ucar.edu/css/software/fftpack5/ftpk.html

   Copyright (c) 2004 the University Corporation for Atmospheric
   Research ("UCAR"). All rights reserved. Developed by NCAR's
   Computational and Information Systems Laboratory, UCAR,
   www.cisl.ucar.edu.

   Redistribution and use of the Software in source and binary forms,
   with or without modification, is permitted provided that the
   following conditions are met:

   - Neither the names of NCAR's Computational and Information Systems
   Laboratory, the University Corporation for Atmospheric Research,
   nor the names of its sponsors or contributors may be used to
   endorse or promote products derived from this Software without
   specific prior written permission.

   - Redistributions of source code must retain the above copyright
   notices, this list of conditions, and the disclaimer below.

   - Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions, and the disclaimer below in the
   documentation and/or other materials provided with the
   distribution.

   THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
   EXPRESS OR IMPLIED, INCLUDING, BUT NOT LIMITED TO THE WARRANTIES OF
   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
   NONINFRINGEMENT. IN NO EVENT SHALL THE CONTRIBUTORS OR COPYRIGHT
   HOLDERS BE LIABLE FOR ANY CLAIM, INDIRECT, INCIDENTAL, SPECIAL,
   EXEMPLARY, OR CONSEQUENTIAL DAMAGES OR OTHER LIABILITY, WHETHER IN AN
   ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
   CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS WITH THE
   SOFTWARE.
*/
```

## Emscripten runtime

The module links Emscripten's `emmalloc`, parts of its musl-based libc, and libc++. Emscripten is
MIT and University of Illinois/NCSA licensed, musl is MIT, and libc++ is Apache-2.0 with the LLVM
exception: <https://github.com/emscripten-core/emscripten/blob/main/LICENSE>.
