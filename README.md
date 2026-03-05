# Meteora-Alpha-Vault-Bundler

**Support:** [Pio-ne-er](https://t.me/hi_3333)

---

## What is Alpha Vault?

**Alpha Vault** is Meteora’s new **stealth bundling** method for token launches. It ties an Alpha Vault to a Meteora DAMM v2 pool so liquidity is locked and early supporters (including dev wallets) can receive tokens at a single, fair price.

### How it works

1. **Pool + Alpha Vault**  
   A DAMM v2 pool is created with Alpha Vault support (`CONNECT_ALPHA_VAULT_POOL=true`). The pool is linked to an Alpha Vault; liquidity in the pool can be locked.

2. **Early supporters**  
   Early supporter wallets (including multiple dev wallets) are connected to the same Alpha Vault. They are the only addresses that can participate in the initial distribution window.

3. **Same-price distribution**  
   The dev (or designated buyer) buys the token from the pool. Token supply is then distributed to supporter wallets **at the same price** as that buy—no front-running or different entry prices for insiders.

4. **Stealth bundling**  
   Because the flow uses a single vault linked to one pool with locked liquidity and a controlled participant set, it behaves like a “stealth” bundle: fair, same-price allocation to supporters without exposing the launch to arbitrary snipers or uneven pricing.

### In this repo

- **DAMM v2 launch** creates the pool with `hasAlphaVault: true` and optional liquidity lock.
- **Alpha Vault (FCFS)** creates a First-Come-First-Served vault for that pool with configurable depositing window, vesting (start/end), caps, and whitelist mode (permissionless, merkle, or authority).
- Supporters deposit quote (e.g. WSOL/USDC) into the FCFS vault before the depositing deadline; tokens vest over the configured period.

---

## DAMM v2 Launch

1. Install dependencies:
   - `npm install`
2. Copy env template:
   - `cp .env.example .env`
3. Fill values in `.env`.
4. Run dry-run first:
   - `npm run launch:dammv2`

Script path: `src/damm-v2-launch.ts`
Output: `data/latest-pool.json`

## Token Mint

Use `npm run mint:token` to:
- create token mint (`SPL` or `Token-2022`)
- write output JSON (`data/latest-token-mint.json`)

## Alpha Vault (FCFS)

Use `npm run create:alpha-vault:fcfs` to:
- create FCFS (First-Come-First-Served) Alpha Vault for the DAMM v2 pool
- use token mint from `TOKEN_MINT_OUTPUT_PATH`
- use pool address from `POOL_OUTPUT_PATH`
- write output JSON (`data/latest-alpha-vault.json`)

The FCFS vault defines a **depositing window** (quote only), **vesting** (start/end timestamps), **caps** (total and per-wallet), and **whitelist mode** (permissionless, merkle proof, or authority). Early supporters deposit quote into the vault; they receive the project token at the same price, with vesting applied.

---