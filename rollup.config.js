import { readFileSync } from "fs";

// Reads the ==UserScript== metablock from a source file
function readMetablock(filePath) {
    const src = readFileSync(filePath, "utf8");
    const match = src.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);
    return match ? match[0] : "";
}

const SERVICES = ["filmin", "filmtwist", "pandaplus"];

const targetService = process.env.SERVICE;
const activeServices = targetService ? [targetService] : SERVICES;

export default activeServices.map((name) => ({
    input: `src/services/${name}.js`,
    output: {
        file: `dist/${name}.user.js`,
        format: "iife",
        name: `__${name}Script`,
        // The metablock must live OUTSIDE the IIFE — banner is injected before it
        banner: readMetablock(`src/services/${name}.js`),
        // "use strict" is already in the IIFE via the intro
        intro: '"use strict";',
    },
    // Suppress "use strict" inside the IIFE (it's in intro)
    onwarn(warning, warn) {
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
    },
}));
