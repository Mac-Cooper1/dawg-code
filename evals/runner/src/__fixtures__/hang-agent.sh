#!/usr/bin/env bash
# Starts a background child that would outlive us, records both pids, then hangs.
sleep 1000 &
echo "$!" > "$1/child.pid"
echo "$$" > "$1/parent.pid"
sleep 1000
