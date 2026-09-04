import type { Env as WorkerEnv } from "../src/config";

declare global {
    namespace Cloudflare {
        // Declaration-merges with @cloudflare/workers-types' empty `Cloudflare.Env`,
        // so `env` and `SELF` from "cloudflare:test" carry our actual bindings.
        interface Env extends WorkerEnv {}
    }
}
