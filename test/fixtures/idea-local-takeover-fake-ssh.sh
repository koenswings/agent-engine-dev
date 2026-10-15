#!/bin/bash
# Fake ssh for idea-local-takeover-script.test.ts (idea#203): simulates idea03/idea04 with a holder file in $FAKE_DIR; never contacts a host.
h=$1; shift; c="$*"; d=$FAKE_DIR; echo "$h: $c" >> $d/cmds
ip() { case $1 in idea03) echo 10.99.0.13;; idea04) echo 10.99.0.14;; idea01) echo 10.99.0.11;; esac; }
holder=$(cat $d/holder)
case "$c" in
  *"hostname; ip -4"*) echo $h; ip $h; echo avahi-ok; echo engine-ok; echo "[idea.local] fake";;
  "python3 - --wait"*) cat >/dev/null; echo "{\"responders\": {\"$(ip $holder)\": [\"$(ip $holder)\"]}}";;
  *"pkill -STOP"*) echo $h > $d/frozen; [ "${FAKE_NO_TAKEOVER:-0}" = 1 ] || { for x in idea03 idea04; do [ $x != $h ] && echo $x > $d/holder; done; };;
  *"pkill -CONT"*) rm -f $d/frozen;;
  *"ps -o pid=,stat="*) [ -f $d/frozen ] && [ "$(cat $d/frozen)" = $h ] && echo "123 T avahi-daemon"; true;;
  *getaddrinfo*) ip $holder;;
  *curl*) printf 200;;
  *) true;;
esac
