# Debug Audit Report

- **Directory**: `C:\Users\voide\Downloads\POLYPROPHET-main\POLYPROPHET-main\debug`
- **Files scanned**: 112
- **Unique trades**: 376
- **Closed trades**: 366
- **Win/Loss/Flat**: 199/142/25
- **Win rate**: 54.4%
- **Total P/L**: £3011697729.38
- **Avg P/L per trade**: £8228682.32
- **Median P/L per trade**: £0.28

## Config versions seen

```json
{
  "39": 2,
  "40": 1,
  "42": 29,
  "unknown": 80
}
```

## Breakdown

### By tier
```json
{
  "UNKNOWN": 313,
  "CONVICTION": 50,
  "ADVISORY": 3
}
```

### By asset
```json
{
  "SOL": 70,
  "ETH": 76,
  "BTC": 94,
  "XRP": 126
}
```

### By entry bucket
```json
{
  "50–80¢": 210,
  "80–95¢": 2,
  "20–50¢": 77,
  "<20¢": 77
}
```

## Sample trades

```json
[
  {
    "id": "SOL_1766010265273",
    "asset": "SOL",
    "side": "UP",
    "entry": 0.59,
    "exit": 1,
    "pnl": 0.7644067796610171,
    "time": "2025-12-17T22:24:25.274Z",
    "closeTime": "2025-12-17T22:30:00.169Z",
    "reason": "ORACLE WIN ✅",
    "firstSeenIn": "polyprophet_debug_2025-12-18T10-59-02-670Z.json"
  },
  {
    "id": "ETH_1766010840359",
    "asset": "ETH",
    "side": "UP",
    "entry": 0.58,
    "exit": 0,
    "pnl": -1.1,
    "time": "2025-12-17T22:34:00.359Z",
    "closeTime": "2025-12-17T22:45:00.327Z",
    "reason": "ORACLE LOSS ❌",
    "firstSeenIn": "polyprophet_debug_2025-12-18T10-59-02-670Z.json"
  },
  {
    "id": "BTC_1766010841353",
    "asset": "BTC",
    "side": "UP",
    "entry": 0.52,
    "exit": 0,
    "pnl": -1.1,
    "time": "2025-12-17T22:34:01.353Z",
    "closeTime": "2025-12-17T22:45:00.324Z",
    "reason": "ORACLE LOSS ❌",
    "firstSeenIn": "polyprophet_debug_2025-12-18T10-59-02-670Z.json"
  },
  {
    "id": "XRP_1766011745495",
    "asset": "XRP",
    "side": "UP",
    "entry": 0.67,
    "exit": 1,
    "pnl": 0.5417910447761194,
    "time": "2025-12-17T22:49:05.496Z",
    "closeTime": "2025-12-17T23:00:00.423Z",
    "reason": "ORACLE WIN ✅",
    "firstSeenIn": "polyprophet_debug_2025-12-18T10-59-02-670Z.json"
  },
  {
    "id": "BTC_1766011746496",
    "asset": "BTC",
    "side": "UP",
    "entry": 0.53,
    "exit": 1,
    "pnl": 0.9754716981132074,
    "time": "2025-12-17T22:49:06.497Z",
    "closeTime": "2025-12-17T23:00:00.418Z",
    "reason": "ORACLE WIN ✅",
    "firstSeenIn": "polyprophet_debug_2025-12-18T10-59-02-670Z.json"
  }
]
```

> Full details in `audit_report.json`.