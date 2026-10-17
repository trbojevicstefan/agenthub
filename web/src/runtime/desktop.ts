// The desktop modules the web server reuses (CommonJS, from the repository's desktop/ folder).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const desktopModule = <T = any>(name: string): T => require(`../../../desktop/${name}`) as T;
