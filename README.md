# hardbasis-bot

A **reference API client** for the [HardBasis](https://docs.hardbasis.com) perpetual-futures
API, and a **continuous soak** that exercises every public endpoint over both transports,
around the clock, asserting the API's own documented invariants as it goes.

It exists to prove three things at once: that the [public docs](https://docs.hardbasis.com)
are sufficient to build a real client from (this bot is built from the docs and
[`/openapi.json`](https://docs.hardbasis.com/openapi.json) alone — nothing else), that the
API behaves the way the docs say under days of real traffic, and that an agent can go from
**nothing but a base URL** to a live, self-limiting trading loop with **no human step**.

> **What this is not.** This is a reference/demonstration client on **testnet**, where test
> sats have no value. It is **not a trading strategy, not investment advice, and carries no
> expectation of profit** — the "strategy" is a deliberately dumb oscillator chosen for
> coverage and endurance, not returns. Running it against anything of value is entirely the
> operator's risk. It refuses to trade off testnet unless you explicitly override that.

---

## One command

The documented on-ramp is the deploy path — the same command a stranger runs and the same
command the maintainers run on the VM. On a clean box with Docker:

```bash
git clone https://github.com/HardBasis/hardbasis-bot.git
cd hardbasis-bot
cp .env.example .env          # the defaults already point at testnet
docker compose up -d
docker compose logs -f        # structured JSON; watch it bootstrap and trade
```

That's it. You provision **no key**. On first run the bot performs the quickstart loop
itself — signup → faucet → mint its own `trade`-scoped delegate — and persists the
credentials to a gitignored `state/` file with mode `0600`. Subsequent runs reuse it.

### Without Docker

Node 22+ and [pnpm](https://pnpm.io):

```bash
pnpm install
cp .env.example .env
pnpm start           # unattended loop
pnpm start -- --once # a single full pass (bootstrap → coverage → probes → drills), then exit
```

---

## What it does

- **Self-bootstraps** its account, faucet grant, and a `read`+`trade` delegate key. The
  full-scope master key stays cold (used only to mint delegates); the loop runs on the
  delegate, which cannot touch your balance.
- **Maintains a small oscillating position** on the venue's first market, driven by the
  oracle price stream (a slow EMA with a hysteresis band), sized in the low thousands of
  sats under self-enforced position and daily-turnover caps.
- **Exercises the conditional-order surface** — stop, take-profit, and bracket triggers —
  and cancels most of them.
- **Keeps `cancel-all-after` armed** and refreshed, and **deliberately lets it fire once**
  to prove the dead-man's-switch works in production.
- **Runs a withdrawal check** over the Spark rail (a tiny self-send that settles to
  `paid`), using a separate `withdraw`-scoped key.
- **Covers every public endpoint** over REST and WebSocket, walking every cursor to
  exhaustion.
- **Asserts eight invariant families continuously** (below). Each violation is a structured
  finding with the offending request/response captured verbatim.

### The invariants it asserts

1. **Error codes match the docs** — provokes each documented `ErrorCode` and checks the
   returned `code`.
2. **Rate limits** — headers agree with `GET /v1/limits`; `429` carries `Retry-After` and
   `code:"rate_limited"`; exhausting the order budget never blocks a withdrawal.
3. **Money never loses precision** — every `…Msat`/`…Q8`/`…Q9`/`…Ms`/`seq`/`…Contracts`
   field is an exact wire integer; a JSON number where money belongs is a stop-everything
   finding.
4. **Sequencing** — the account `seq` is monotonic, and the history↔live dedup rule holds
   across a reconnect.
5. **Envelopes & units** — cursor lists return named-key `{items, nextBeforeSeq}` envelopes.
6. **Funding** — settles hourly; an idle session still sees a fresh stats frame.
7. **Dead-man's-switch** — after a deliberate expiry, resting orders cancel with
   `reason:"deadman"`.
8. **Staleness honesty** — stale vs live is decided from served values
   (`oracleStalenessMs`), never a hardcoded threshold.

---

## Configuration

Everything is env-driven; see [`.env.example`](.env.example). The only value you might change
is `HB_BASE_URL` (already defaulted to testnet). Highlights:

| variable                          | default                          | meaning                                             |
| --------------------------------- | -------------------------------- | --------------------------------------------------- |
| `HB_BASE_URL`                     | `https://testnet.hardbasis.com`  | gateway base URL                                    |
| `HB_ALLOW_NON_TESTNET`            | `0`                              | must be `1` to run anywhere `GET /deployment` ≠ testnet |
| `HB_MAX_POSITION_CONTRACTS`       | `2000`                           | absolute position cap                               |
| `HB_MAX_DAILY_TURNOVER_CONTRACTS` | `200000`                         | rolling-24h turnover cap                            |
| `HB_ORDER_CONTRACTS`              | `500`                            | order size per flip                                 |
| `HB_TICK_MS`                      | `15000`                          | trading-loop cadence                                |
| `HB_DEADMAN_MS`                   | `60000`                          | cancel-all-after deadline kept armed                |
| `HB_LOG_MAX_BYTES` / `_FILES`     | `5000000` / `5`                  | per-file log rotation cap                           |
| `HB_ALERT_WEBHOOK_URL`            | *(empty)*                        | optional: POST alerts here                          |
| `HB_ALERT_NTFY_URL`               | *(empty)*                        | optional: [ntfy](https://ntfy.sh) topic for alerts  |

---

## Safety

- **Refuses to trade off testnet.** On startup it calls `GET /deployment`; anything that is
  not `testnet` exits immediately unless you pass `--allow-non-testnet` (or set
  `HB_ALLOW_NON_TESTNET=1`) and accept the risk.
- **No secrets, ever.** Keys come from the bot's own bootstrap into `state/` (gitignored,
  `0600`) or from your `.env`. The repo ships `.env.example` only. **CI fails on any string
  matching `hb_[0-9a-f]{32}`** ([`scripts/check-no-keys.sh`](scripts/check-no-keys.sh)).
- **Self-limiting by default** — position size, daily turnover, signup count, and faucet
  draws are all capped.
- **The master key stays cold.** The trading loop runs on a `trade`-scoped delegate; a
  stolen delegate can lose a position but never withdraw.

---

## Running it unattended (the VM)

The maintainers run the long-lived instance on a small VM, built on the box straight from
this repo — so every deploy dogfoods this README.

- **systemd** — a proposed unit is in [`deploy/hardbasis-bot.service`](deploy/hardbasis-bot.service)
  (`Restart=always`, `WantedBy=multi-user.target`). Install it yourself; the bot never
  installs itself.
- **Logs are bounded.** Structured JSON, size-capped and rotated (`activity.log`), with a
  separate low-volume `findings.log`. Container logs are size-capped in
  [`docker-compose.yml`](docker-compose.yml) too, so a 1 GB droplet can't fill.
- **Alerts escape the box.** An invariant violation emits an `ALERT`-class line and, if you
  set `HB_ALERT_WEBHOOK_URL` or `HB_ALERT_NTFY_URL`, pushes a notification — so you learn of
  a violation without SSHing in. Optional: a public user is never forced into it.

---

## Development

```bash
pnpm run typecheck        # tsc --noEmit
pnpm test                 # unit tests (pure logic; no network, no credentials)
pnpm run check-no-keys    # the committed-key scan
pnpm run ci               # all three, in order — what CI runs
HB_LIVE=1 pnpm test       # additionally run the live testnet reachability smoke
pnpm run fetch-spec       # refresh spec/openapi.json from the live docs
```

Types (`src/types.ts`) are hand-derived from the vendored [`spec/openapi.json`](spec/openapi.json),
which is fetched verbatim from the public URL. Nothing in this repo imports from the
HardBasis monorepo — by construction, since it is a separate repository.

## License

[MIT](LICENSE).
