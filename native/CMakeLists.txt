cmake_minimum_required(VERSION 3.30)
project(bungee_web LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# CMake 4 scans C++20 sources for modules; Emscripten ships no clang-scan-deps.
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

option(BUNGEE_WEB_SIMD "Compile Bungee, Eigen and PFFFT for wasm SIMD128" ON)

# Bungee Basic, pinned. Upstream tags every main-branch commit; this is v2.4.30.
set(BUNGEE_GIT_TAG 8cb6977d0c1a1b411ac320493b3c7f5182ed2d22)
set(BUNGEE_VERSION 2.4.30 CACHE STRING "" FORCE)
set(BUNGEE_BUILD_SHARED_LIBRARY OFF CACHE BOOL "" FORCE)

include(FetchContent)
FetchContent_Declare(bungee
  GIT_REPOSITORY https://github.com/bungee-audio-stretch/bungee.git
  GIT_TAG ${BUNGEE_GIT_TAG}
  GIT_SUBMODULES submodules/eigen submodules/pffft submodules/cxxopts
  GIT_SUBMODULES_RECURSE OFF
  GIT_PROGRESS ON
)
FetchContent_MakeAvailable(bungee)

if(EMSCRIPTEN)
  # The upstream CLI is a native reference tool; do not build it as wasm.
  set_target_properties(bungee_executable PROPERTIES EXCLUDE_FROM_ALL TRUE)

  if(BUNGEE_WEB_SIMD)
    # -msimd128 turns on wasm SIMD; -msse4.1 makes Emscripten's xmmintrin shims
    # available so Eigen's SSE packet math vectorizes on top of it. PFFFT picks
    # its own path from __wasm_simd128__.
    set(BUNGEE_WEB_SIMD_FLAGS -msimd128 -msse4.1)
    target_compile_options(bungee_library PRIVATE ${BUNGEE_WEB_SIMD_FLAGS})
    target_compile_options(pffft PRIVATE ${BUNGEE_WEB_SIMD_FLAGS})
  else()
    target_compile_definitions(pffft PRIVATE PFFFT_SIMD_DISABLE=1)
    target_compile_definitions(bungee_library PRIVATE EIGEN_DONT_VECTORIZE=1)
  endif()
  target_compile_options(bungee_library PRIVATE -fno-exceptions -fno-rtti)

  add_executable(bungee_web bungee_web.cpp)
  target_link_libraries(bungee_web PRIVATE bungee_library)
  target_include_directories(bungee_web PRIVATE ${bungee_SOURCE_DIR})
  target_compile_options(bungee_web PRIVATE -fno-exceptions -fno-rtti $<$<BOOL:${BUNGEE_WEB_SIMD}>:${BUNGEE_WEB_SIMD_FLAGS}>)
  set_target_properties(bungee_web PROPERTIES OUTPUT_NAME bungee SUFFIX .wasm)

  # Standalone wasm: no Emscripten JS glue, so the module loads inside an
  # AudioWorkletGlobalScope with a few WASI stubs (src/wasm.ts provides them).
  target_link_options(bungee_web PRIVATE
    -sSTANDALONE_WASM=1
    --no-entry
    -sFILESYSTEM=0
    -sMALLOC=emmalloc
    -sALLOW_MEMORY_GROWTH=0
    -sINITIAL_MEMORY=16777216
    -sSTACK_SIZE=1048576
    -sEXPORTED_FUNCTIONS=_malloc,_free
    -O3
  )
endif()
