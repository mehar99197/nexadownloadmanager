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
    src/main.cpp
    src/core/Database.cpp
    src/core/SegmentDownloader.cpp
    src/core/DownloadTask.cpp
    src/core/DownloadEngine.cpp
    src/grabber/HlsGrabber.cpp
    src/torrent/TorrentManager.cpp
    src/ipc/IpcServer.cpp
    src/web/WebServer.cpp
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
