#!/bin/sh
set -eu
case "$1" in p3-load-0|p3-load-1) ;; *) exit 2 ;; esac
doveadm import -u "$1" maildir:/tmp/phase3-import "" all
