cmake_minimum_required(VERSION 2.6)

PROJECT(cgi-swupdate C)

INCLUDE(CheckFunctionExists)

FIND_PATH(ubus_include_dir libubus.h)
FIND_PATH(swupdate_include_dir network_ipc.h)
FIND_LIBRARY(ubox NAMES ubox)
FIND_LIBRARY(ubus NAMES ubus)
FIND_LIBRARY(swupdate NAMES swupdate)
INCLUDE_DIRECTORIES(${ubus_include_dir})
INCLUDE_DIRECTORIES(${swupdate_include_dir})

ADD_DEFINITIONS(-Os -Wall -Werror -Wextra --std=gnu99 -g3)
ADD_DEFINITIONS(-Wno-unused-parameter -Wmissing-declarations)

SET(CMAKE_SHARED_LIBRARY_LINK_C_FLAGS "")

ADD_EXECUTABLE(cgi-swupdate main.c multipart_parser.c)
TARGET_LINK_LIBRARIES(cgi-swupdate pthread ${ubox} ${ubus} ${swupdate})

INSTALL(TARGETS cgi-swupdate RUNTIME DESTINATION sbin)
