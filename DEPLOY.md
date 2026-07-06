# CipherJack Sepolia Deployment Runbook

Use this checklist before demo filming or Zama Builder Track submission.

## 1. Deploy contract

```bash
cd backend
cp .env.example .env   # if needed
npm install --legacy-peer-deps
npm run compile
npm run deploy:sepolia
```

`deploy:sepolia` writes `backend/deployments/sepolia.json` and prints the contract address.

Ensure `BANK_FUND_ETH` in `.env` funds the dealer bank so `getBankHealth().solvent` is true.

## 2. Sync ABI to frontend

```bash
cd backend
npm run sync-abi
```

## 3. Configure environment

**backend/.env**

| Variable | Purpose |
| --- | --- |
| `BLACKJACK_CONTRACT_ADDRESS` | Deployed Blackjack address |
| `ORACLE_PRIVATE_KEY` | Must match on-chain `gameOracle()` |
| `SEPOLIA_RPC_URL` | Public Sepolia RPC (free tier OK) |
| `ORACLE_RPC_FALLBACKS` | Optional comma-separated backup RPC URLs |

**frontend/.env**

| Variable | Purpose |
| --- | --- |
| `VITE_BLACKJACK_CONTRACT` | Same as `BLACKJACK_CONTRACT_ADDRESS` |
| `VITE_SEPOLIA_RPC_URL` | Sepolia RPC for wagmi reads |
| `VITE_FHE_RPC_URL` | Relayer SDK network URL (can match Sepolia RPC) |
| `VITE_WALLETCONNECT_PROJECT_ID` | WalletConnect project id |
| `VITE_APP_PUBLIC_URL` | Deployed site URL (e.g. Vercel) |
| `VITE_ORACLE_ACTIVITY_URL` | Oracle activity API (e.g. `http://127.0.0.1:4001`) |

If deployer is not the oracle signer:

```bash
# cast or hardhat console
blackjack.setGameOracle(<oracleSignerAddress>)
```

## 4. Start oracle (required for live play)

```bash
cd backend
npm run oracle
```

Startup must log:

- Contract bytecode found
- `Signer ... is gameOracle` (no mismatch)
- Polling interval

Keep **one** oracle process running (enforced via `oracle/.oracle.lock`). Persist `oracle/.sessions.json`, `oracle/.commitment-seeds.json`, and `oracle/.hand-history.json` across restarts.

The oracle serves **table activity history** (last 100 hands per table) at `http://127.0.0.1:4001/tables/:id/activity`. Set `ORACLE_ACTIVITY_HOST=0.0.0.0` for remote frontends and point `VITE_ORACLE_ACTIVITY_URL` at that host.

The oracle **auto-advances timed-out player turns** (calls `forceAdvanceOnTimeout` after 60s) — no manual “Force Advance” button in the UI.

## 5. Run frontend

```bash
cd frontend
npm install
npm run dev        # local
npm run build      # production bundle
```

Production hosting must serve COOP/COEP headers (see `frontend/vercel.json`).

## 6. Smoke test before recording

1. Connect wallet on **Sepolia**
2. Claim free chips / join table
3. Place bet → wait for oracle deal
4. Hit or stand → player cards decrypt in UI
5. Showdown → dealer cards reveal (use **Retry reveal** if RPC is slow)
6. Acknowledge result → next hand

## Free public RPC tips (testnet)

- No paid RPC required for Sepolia demo
- Oracle rotates through `ORACLE_RPC_FALLBACKS` + built-in public endpoints on rate limits
- If decrypt stalls, use **Retry reveal** or `resetDecryption` in the game UI
- Avoid running multiple oracle instances

## Security

- Never commit `.env`, `oracle/.sessions.json`, `oracle/.commitment-seeds.json`, or `oracle/.hand-history.json`
- Rotate any key that was ever shared or committed
- Use a dedicated `ORACLE_PRIVATE_KEY` in production (do not set `ALLOW_DEPLOYER_ORACLE_KEY`)