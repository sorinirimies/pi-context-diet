// Safety net, loaded before every test file (see bunfig.toml): no test may ever read or write the real
// ~/.pi/agent. A test that persists config (a command handler) used to be able to leak settings into a
// real installation; now the config dir is a throw-away temp dir unless a test redirects it itself.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-test-agent-"));
