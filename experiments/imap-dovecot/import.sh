#!/bin/sh
set -eu
mkdir -p /tmp/maildock-fixture
tar -xf /tmp/maildock-fixture.tar -C /tmp/maildock-fixture
doveadm import -u fixture maildir:/tmp/maildock-fixture "" all
