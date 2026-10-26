#!/usr/bin/env node
import path from "node:path";
import { generateTypes } from "./index.js";

const root = path.resolve(process.argv[2] ?? process.cwd());
for (const file of generateTypes(root)) console.log(`Generated ${path.relative(root, file)}`);
