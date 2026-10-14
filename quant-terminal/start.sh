#!/bin/sh
# Run ./start.sh to start Quant Terminal.
cd "$(dirname "$0")" && node server.js --open
