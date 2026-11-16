#!/usr/bin/env node
import { main } from "./main.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => { console.error(`udmp: ${err?.message ?? err}`); process.exit(2); },
);
