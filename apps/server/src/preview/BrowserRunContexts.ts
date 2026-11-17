import type { BrowserContext } from "playwright-core";

/**
 * A browser run's tabs share one managed context, so a sign-in carries across its pages and
 * windows, and its page code installed before load reaches every page it opens. Keyed by the
 * run's owner key; the entry goes when the context closes with the run's last tab.
 */
export class BrowserRunContexts {
  readonly #starting = new Map<string, Promise<BrowserContext>>();
  readonly #ready = new Map<string, BrowserContext>();
  readonly #scripts = new Map<string, Array<string>>();
  // A run's tabs share one context, so page code and saved logins are kept apart per run:
  // page code in any of its pages could read a login typed into another.
  readonly #pageCode = new Set<string>();
  readonly #logins = new Set<string>();

  /** The run's context, created once; a failed start leaves nothing behind for the next tab. */
  contextFor(owner: string, create: () => Promise<BrowserContext>): Promise<BrowserContext> {
    const ready = this.#ready.get(owner);
    if (ready !== undefined) return Promise.resolve(ready);
    const existing = this.#starting.get(owner);
    if (existing !== undefined) return existing;
    const started = (async () => {
      try {
        const context = await create();
        // Scripts added while it started are installed here, once, before it is shared.
        for (let index = 0; index < (this.#scripts.get(owner)?.length ?? 0); index += 1)
          await context.addInitScript(this.#scripts.get(owner)![index]!);
        this.#ready.set(owner, context);
        context.once("close", () => {
          if (this.#ready.get(owner) === context) this.#ready.delete(owner);
        });
        return context;
      } finally {
        this.#starting.delete(owner);
      }
    })();
    this.#starting.set(owner, started);
    return started;
  }

  /** Whether `context` is a browser run's, whose tabs also report uncaught page errors. */
  holds(context: BrowserContext): boolean {
    return [...this.#ready.values()].includes(context);
  }

  /** Records that the run runs page code; refused once it has typed a saved login. */
  usePageCode(owner: string): void {
    if (this.#logins.has(owner))
      throw new Error("Page code is refused in a browser run after a saved login was typed in it.");
    this.#pageCode.add(owner);
  }

  /** Records that the run types a saved login; refused once it has run page code. */
  useLogin(owner: string): void {
    if (this.#pageCode.has(owner))
      throw new Error("A saved login is refused in a browser run that has run page code.");
    this.#logins.add(owner);
  }

  /** Drops what the run left here when it ends, whether or not it ever opened a tab. */
  forget(owner: string): void {
    this.#scripts.delete(owner);
    this.#pageCode.delete(owner);
    this.#logins.delete(owner);
  }

  /** Installs page code for the run's later loads, including in a context it has not opened yet. */
  async addInitScript(owner: string, script: string): Promise<void> {
    this.usePageCode(owner);
    this.#scripts.set(owner, [...(this.#scripts.get(owner) ?? []), script]);
    await this.#ready.get(owner)?.addInitScript(script);
  }
}
