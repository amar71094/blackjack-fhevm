# CipherJack Frontend

React client for [CipherJack](https://cipherjack.xyz) — encrypted multiplayer blackjack on Sepolia, powered by Zama fhEVM.

**Live:** [https://cipherjack.xyz](https://cipherjack.xyz)  
**Contract:** [`0xA47190fCBBfA397D1F7A1E461Ae4fDA36b137958`](https://sepolia.etherscan.io/address/0xA47190fCBBfA397D1F7A1E461Ae4fDA36b137958) (Sepolia)  
**Monorepo docs:** [../README.md](../README.md) · [../DEPLOY.md](../DEPLOY.md)

## Features

- **FHE user-decrypt** for your live hand; public decrypt for dealer cards at showdown
- **WalletConnect + injected wallets** (MetaMask, etc.) via wagmi
- **Lobby** — browse tables, create tables, claim free chips, buy/withdraw chips
- **Live table** — up to 4 players, chip animations, turn timer, showdown overlays
- **Spectator mode** — watch a table without being seated
- **Table activity** — last 100 hands per table (via oracle activity API)
- **Bank health banner** — warns when the on-chain dealer bank is underfunded

## Routes

| Path | Page |
| --- | --- |
| `/` | Lobby — table browser, wallet panel, create/join flows |
| `/game/:tableId` | Live blackjack table |
| `*` | 404 → back to lobby |

## Gameplay Overview

1. **Connect & fund** — connect on Sepolia, claim 2,000 free promo chips (or buy with test ETH)
2. **Join a table** — set buy-in within table min/max limits
3. **Betting** — place wager before cards are dealt
4. **Encrypted turns** — approve the FHE signature prompt to decrypt your cards locally
5. **Actions** — Hit, Stand, or Double (first two cards only)
6. **Turn timer** — 60 seconds per turn; the oracle auto-stands for you on timeout
7. **Showdown** — dealer cards reveal, payouts settle on-chain, next betting phase opens

Dealer hits on 16 or less and stands on 17 or more (including soft 17).

## Getting Started

```sh
cd frontend
cp .env.example .env    # set VITE_BLACKJACK_CONTRACT + RPC + WalletConnect ID
npm install
npm run dev             # http://localhost:8080
```

The dev server sets **COOP/COEP** headers required for Zama FHE WASM. Production hosts must do the same (see `vercel.json`).

**Oracle required:** live dealing and settlement need the backend oracle running. Point `VITE_ORACLE_ACTIVITY_URL` at the oracle activity API (default `http://127.0.0.1:4001`).

### Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Vite dev server on port 8080 |
| `npm run build` | Production bundle in `dist/` |
| `npm run preview` | Preview production build |
| `npm run lint` | ESLint |

### Environment Variables

See `frontend/.env.example` and the env table in [../README.md](../README.md#-frontend).

Minimum for local dev:

- `VITE_BLACKJACK_CONTRACT` — deployed Blackjack address
- `VITE_SEPOLIA_RPC_URL` — Sepolia RPC
- `VITE_WALLETCONNECT_PROJECT_ID` — WalletConnect project ID
- FHE addresses (defaults in `.env.example` match Zama Sepolia testnet)

## Tech Stack

- React 18 + TypeScript
- Vite 5
- Tailwind CSS + shadcn/ui
- wagmi 2 + viem
- TanStack Query
- `@zama-fhe/relayer-sdk` 0.4.x

## Project Structure

```
src/
├── pages/           Index (lobby), Game, NotFound
├── hooks/           useBlackjackLobby, useBlackjackGame
├── components/
│   ├── blackjack/   Table, cards, controls, rules
│   ├── wallet/      WalletControls popover
│   └── layout/      SiteHeader, TestnetBanner, footer
└── lib/             wagmi config, contract writes, FHE helpers, toasts
```

## Deployment

```sh
npm run build
```

Deploy `dist/` to Vercel, Netlify, or similar. Ensure COOP/COEP headers are set (Vercel: use included `vercel.json`).

Set `VITE_APP_PUBLIC_URL` to your deployed origin for WalletConnect metadata.

## Troubleshooting

| Issue | Fix |
| --- | --- |
| Cards won't decrypt | Reconnect wallet, approve FHE signature, use **Retry reveal** at showdown |
| No cards dealt after bet | Confirm oracle is running and `gameOracle` matches oracle signer |
| Wrong network | Switch wallet to Sepolia |
| WASM / SharedArrayBuffer errors | Host must serve COOP/COEP headers |
| Table activity empty | Set `VITE_ORACLE_ACTIVITY_URL` and ensure oracle HTTP API is reachable |

## Contributing

1. Run `npm run lint` and `npm run build` before opening a PR
2. Match existing component patterns and copy tone
3. See [../README.md](../README.md) for full-stack setup