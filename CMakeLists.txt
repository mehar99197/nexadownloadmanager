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
    src/core/RateLimiter.cpp
    src/core/UpdateChecker.cpp
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
    src/ui/SettingsDialog.cpp
    src/ui/ClipboardMonitor.cpp
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

# ---------------------------------------------------------------------------
# Desktop integration files (Linux). These are installed relative to the
# install prefix (/usr for a .deb), giving the standard XDG locations:
#   /usr/share/applications/nexa.desktop
#   /usr/share/icons/hicolor/256x256/apps/nexa.png
#   /usr/share/pixmaps/nexa.png   (fallback for older menus)
# ---------------------------------------------------------------------------
if(NOT WIN32)
    install(FILES packaging/nexa.desktop
        DESTINATION share/applications)
    install(FILES assets/nexa-256.png
        DESTINATION share/icons/hicolor/256x256/apps
        RENAME nexa.png)
    install(FILES assets/nexa.png
        DESTINATION share/pixmaps)
endif()

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

    # Formatter tests (humanSize/humanSpeed/humanTime). UiHelpers pulls Widgets.
    add_executable(nexa_format_test
        tests/FormatTest.cpp
        src/ui/UiHelpers.cpp
    )
    target_include_directories(nexa_format_test PRIVATE src)
    target_link_libraries(nexa_format_test PRIVATE Qt6::Core Qt6::Widgets)

    enable_testing()
    add_test(NAME auth   COMMAND nexa_auth_test)
    add_test(NAME format COMMAND nexa_format_test)
endif()

# ===========================================================================
# Packaging (CPack): Debian .deb on Linux, NSIS .exe installer on Windows.
# ===========================================================================
set(CPACK_PACKAGE_NAME "nexa")
set(CPACK_PACKAGE_VENDOR "Nexa")
set(CPACK_PACKAGE_VERSION_MAJOR "${PROJECT_VERSION_MAJOR}")
set(CPACK_PACKAGE_VERSION_MINOR "${PROJECT_VERSION_MINOR}")
set(CPACK_PACKAGE_VERSION_PATCH "${PROJECT_VERSION_PATCH}")
set(CPACK_PACKAGE_VERSION "${PROJECT_VERSION}")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "Nexa Download Manager")
set(CPACK_PACKAGE_DESCRIPTION
    "Nexa is a fast multi-protocol download manager supporting HTTP/HTTPS \
segmented downloads, HLS video streams, BitTorrent, and site-specific media \
extraction via yt-dlp. It ships with a Qt6 GUI and a native-messaging host \
for browser integration.")
set(CPACK_PACKAGE_CONTACT "Nexa Maintainers <tauseeqtufail649@gmail.com>")
set(CPACK_PACKAGE_HOMEPAGE_URL "https://github.com/")
set(CPACK_RESOURCE_FILE_LICENSE "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE")
set(CPACK_PACKAGE_INSTALL_DIRECTORY "Nexa")
set(CPACK_PACKAGING_INSTALL_PREFIX "/usr")

if(WIN32)
    # -----------------------------------------------------------------------
    # Windows: NSIS installer (.exe). Build this ON Windows after running
    # windeployqt against the installed nexa.exe so the Qt6 runtime DLLs and
    # plugins are co-located before CPack collects them. See packaging notes.
    # -----------------------------------------------------------------------
    set(CPACK_GENERATOR "NSIS")
    set(CPACK_NSIS_PACKAGE_NAME "Nexa Download Manager")
    set(CPACK_NSIS_DISPLAY_NAME "Nexa Download Manager")
    set(CPACK_NSIS_MODIFY_PATH ON)
    set(CPACK_NSIS_ENABLE_UNINSTALL_BEFORE_INSTALL ON)
    set(CPACK_NSIS_INSTALLED_ICON_NAME "bin\\\\nexa.exe")
    set(CPACK_NSIS_HELP_LINK "${CPACK_PACKAGE_HOMEPAGE_URL}")
    set(CPACK_NSIS_URL_INFO_ABOUT "${CPACK_PACKAGE_HOMEPAGE_URL}")
    # Start-menu / desktop shortcut to the GUI.
    set(CPACK_PACKAGE_EXECUTABLES "nexa" "Nexa Download Manager")
    set(CPACK_CREATE_DESKTOP_LINKS "nexa")
else()
    # -----------------------------------------------------------------------
    # Linux: Debian .deb.
    # -----------------------------------------------------------------------
    set(CPACK_GENERATOR "DEB")
    set(CPACK_DEBIAN_PACKAGE_MAINTAINER "${CPACK_PACKAGE_CONTACT}")
    set(CPACK_DEBIAN_PACKAGE_SECTION "net")
    set(CPACK_DEBIAN_PACKAGE_PRIORITY "optional")
    set(CPACK_DEBIAN_PACKAGE_HOMEPAGE "${CPACK_PACKAGE_HOMEPAGE_URL}")
    # Auto-resolve library shlib deps from the linked ELF binaries, then add
    # the explicit runtime tools/libraries Nexa shells out to or links against.
    set(CPACK_DEBIAN_PACKAGE_SHLIBDEPS ON)
    set(CPACK_DEBIAN_PACKAGE_DEPENDS
        "libqt6core6t64 (>= 6.4.0) | libqt6core6, \
libqt6network6 (>= 6.4.0), \
libqt6widgets6 (>= 6.4.0), \
libqt6sql6 (>= 6.4.0), \
libqt6sql6-sqlite (>= 6.4.0), \
libtorrent-rasterbar2.0t64 (>= 2.0) | libtorrent-rasterbar2.0, \
ffmpeg, \
yt-dlp, \
aria2")
    # Maintainer scripts to refresh the desktop/icon caches.
    set(CPACK_DEBIAN_PACKAGE_CONTROL_EXTRA
        "${CMAKE_CURRENT_SOURCE_DIR}/packaging/postinst;\
${CMAKE_CURRENT_SOURCE_DIR}/packaging/postrm")
endif()

include(CPack)
