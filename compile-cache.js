// Preloaded via `node --import` so the .ts entrypoints' compiled bytecode is
// cached across runs (~50ms off every picker open, both node stages).
import { enableCompileCache } from "node:module";
enableCompileCache();
