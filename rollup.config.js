import { readFileSync, readdirSync } from "fs";
import { basename } from "path";

// Lê o metablock ==UserScript== de um ficheiro fonte
function readMetablock(filePath) {
    const src = readFileSync(filePath, "utf8");
    const match = src.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);
    return match ? match[0] : "";
}

// Auto-descoberta de serviços: qualquer src/services/*.js exceto *.test.js.
// Novo serviço só precisa de um ficheiro em src/services/ — sem tocar neste config.
const SERVICES_DIR = "src/services";
const SERVICES = readdirSync(SERVICES_DIR)
    .filter(f => f.endsWith(".js") && !f.endsWith(".test.js"))
    .map(f => basename(f, ".js"))
    .sort();

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
    },
    // Suppress "MODULE_LEVEL_DIRECTIVE" warnings from core modules
    onwarn(warning, warn) {
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
    },
}));
