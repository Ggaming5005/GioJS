#!/usr/bin/env node
'use strict';
/**
 * giojs/bin/giojs-server.js
 *
 * The `giojs-server` bin: starts the server exactly as it always has -
 * NODE_ENV is the caller's (`cross-env NODE_ENV=development giojs-server`
 * in older scaffolds' scripts), arguments go to the binary, no command
 * parsing. New projects use `gio dev` / `gio start`.
 */
require('./lib/server').runCompatServer(process.argv.slice(2));
