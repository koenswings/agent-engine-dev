#!/usr/bin/env bash
E=/home/walker/duration-evidence/${1:?run id}; P=$(cat $E/run.pid 2>/dev/null)
kill -0 "$P" 2>/dev/null && echo "RUNNING pid=$P" || echo "NOT_RUNNING pid=$P"
cat $E/LAUNCH.txt; echo "steps: $(find $E -name 'step-*' | wc -l)  last: $(ls -t $E/walk 2>/dev/null | head -1)"; tail -5 $E/run.log
