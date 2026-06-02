cmake_minimum_required(VERSION 3.21)
project(Nexa VERSION 0.1.0 LANGUAGES CXX DESCRIPTION "Nexa Download Manager")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)
set(CMAKE_AUTOUIC ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Qt6 REQUIRED COMPONENTS Core Network Widgets Sql)

# BitTorrent support via libtorrent-rasterbar (pkg-config).
find_package(PkgConfig REQUIRED)
pkg_check_modules(LIBTORRENT REQUIRED IMPORTED_TARGET libtorrent-rasterbar)

add_executable(nexa
    resources.qrc
    src/main.cpp
    src/core/Database.cpp
    src/core/SegmentDownloader.cpp
    src/core/DownloadTask.cpp
    src/core/DownloadEngine.cpp
    src/grabber/HlsGrabber.cpp
    src/torrent/TorrentManager.cpp
    src/site/YtDlpGrabber.cpp
    src/auth/CookieFile.cpp
    src/auth/AuthUtils.cpp
    src/auth/AuthenticationManager.cpp
    src/ai/AiClient.cpp
    src/ipc/IpcServer.cpp
    src/web/WebServer.cpp
    src/ui/UiHelpers.cpp
    src/ui/DownloadDetailsDialog.cpp
    src/ui/SiteLoginsDialog.cpp
    src/ui/MainWindow.cpp
)

target_include_directories(nexa PRIVATE src)
target_link_libraries(nexa PRIVATE
    Qt6::Core
    Qt6::Network
    Qt6::Widgets
    Qt6::Sql
    PkgConfig::LIBTORRENT
)

# Native messaging bridge — a tiny standalone exe the browsers launch.
add_executable(nexa-host
    native-host/nexa-host.cpp
)
target_link_libraries(nexa-host PRIVATE
    Qt6::Core
    Qt6::Network
)

install(TARGETS nexa nexa-host RUNTIME DESTINATION bin)

# Auth-layer unit tests (built opt-in: cmake -DNEXA_BUILD_TESTS=ON). Run with
# ./build/nexa_auth_test — no QtTest dependency, exits non-zero on any failure.
option(NEXA_BUILD_TESTS "Build Nexa unit tests" OFF)
if(NEXA_BUILD_TESTS)
    add_executable(nexa_auth_test
        tests/AuthTest.cpp
        src/auth/CookieFile.cpp
        src/auth/AuthUtils.cpp
        src/auth/AuthenticationManager.cpp
    )
    target_include_directories(nexa_auth_test PRIVATE src)
    target_link_libraries(nexa_auth_test PRIVATE Qt6::Core Qt6::Network)
    enable_testing()
    add_test(NAME auth COMMAND nexa_auth_test)
endif()
