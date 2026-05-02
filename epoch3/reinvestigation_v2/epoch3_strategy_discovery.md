# EPOCH 3 Reinvestigation V2 — Strategy Discovery Report

Generated: 2026-05-02T21:04:33.806Z

## Data Sources
- 15m: 8366 cycles (train=5019, holdout=3347)
- 5m: 16045 cycles (train=9627, holdout=6418)
- 4h: 336 cycles (train=201, holdout=135)

## Mining Results
- Total train-selected candidates: 353
- Holdout-passing (WR≥58%, events≥5, EV>0): 135

## Top Candidates by Holdout EV

### static_grid
- Params: {"hour":18,"minute":1,"dir":"UP","pMin":0.6,"pMax":0.75}
- Train WR: 79.5%, LCB: 64.5%
- Holdout WR: 88.0%, Events: 25, Avg Entry: 0.646
- Holdout EV/trade: 0.2108

### static_grid
- Params: {"hour":20,"minute":2,"dir":"DOWN","pMin":0.65,"pMax":0.8}
- Train WR: 80.9%, LCB: 67.5%
- Holdout WR: 93.8%, Events: 16, Avg Entry: 0.709
- Holdout EV/trade: 0.2067

### static_grid
- Params: {"hour":19,"minute":5,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 91.4%, LCB: 77.6%
- Holdout WR: 91.3%, Events: 23, Avg Entry: 0.698
- Holdout EV/trade: 0.1926

### static_grid
- Params: {"hour":20,"minute":2,"dir":"DOWN","pMin":0.6,"pMax":0.75}
- Train WR: 81.4%, LCB: 67.4%
- Holdout WR: 85.7%, Events: 28, Avg Entry: 0.668
- Holdout EV/trade: 0.1670

### static_grid
- Params: {"hour":8,"minute":1,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 86.7%, LCB: 62.1%
- Holdout WR: 90.0%, Events: 20, Avg Entry: 0.716
- Holdout EV/trade: 0.1622

### static_grid
- Params: {"hour":19,"minute":3,"dir":"UP","pMin":0.6,"pMax":0.75}
- Train WR: 81.3%, LCB: 68.1%
- Holdout WR: 84.0%, Events: 25, Avg Entry: 0.655
- Holdout EV/trade: 0.1619

### static_grid
- Params: {"hour":6,"minute":5,"dir":"DOWN","pMin":0.65,"pMax":0.8}
- Train WR: 82.1%, LCB: 67.3%
- Holdout WR: 89.5%, Events: 19, Avg Entry: 0.717
- Holdout EV/trade: 0.1561

### static_grid
- Params: {"hour":5,"minute":2,"dir":"DOWN","pMin":0.6,"pMax":0.75}
- Train WR: 76.3%, LCB: 64.0%
- Holdout WR: 85.4%, Events: 48, Avg Entry: 0.676
- Holdout EV/trade: 0.1558

### static_grid
- Params: {"hour":6,"minute":5,"dir":"DOWN","pMin":0.6,"pMax":0.75}
- Train WR: 78.0%, LCB: 63.3%
- Holdout WR: 84.2%, Events: 19, Avg Entry: 0.676
- Holdout EV/trade: 0.1434

### static_grid
- Params: {"hour":17,"minute":3,"dir":"UP","pMin":0.6,"pMax":0.75}
- Train WR: 76.4%, LCB: 63.7%
- Holdout WR: 82.8%, Events: 29, Avg Entry: 0.668
- Holdout EV/trade: 0.1372

### static_grid
- Params: {"hour":22,"minute":2,"dir":"UP","pMin":0.6,"pMax":0.75}
- Train WR: 75.5%, LCB: 62.4%
- Holdout WR: 84.1%, Events: 44, Avg Entry: 0.686
- Holdout EV/trade: 0.1328

### static_grid
- Params: {"hour":23,"minute":5,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 85.7%, LCB: 73.3%
- Holdout WR: 86.5%, Events: 37, Avg Entry: 0.716
- Holdout EV/trade: 0.1275

### static_grid
- Params: {"hour":5,"minute":5,"dir":"DOWN","pMin":0.55,"pMax":0.7}
- Train WR: 76.3%, LCB: 60.8%
- Holdout WR: 78.6%, Events: 28, Avg Entry: 0.636
- Holdout EV/trade: 0.1266

### static_grid
- Params: {"hour":13,"minute":1,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 100.0%, LCB: 67.6%
- Holdout WR: 84.6%, Events: 13, Avg Entry: 0.698
- Holdout EV/trade: 0.1261

### static_grid
- Params: {"hour":22,"minute":1,"dir":"UP","pMin":0.6,"pMax":0.75}
- Train WR: 76.3%, LCB: 60.8%
- Holdout WR: 82.4%, Events: 34, Avg Entry: 0.675
- Holdout EV/trade: 0.1257

### static_grid
- Params: {"hour":6,"minute":4,"dir":"DOWN","pMin":0.65,"pMax":0.8}
- Train WR: 82.1%, LCB: 64.4%
- Holdout WR: 87.5%, Events: 32, Avg Entry: 0.730
- Holdout EV/trade: 0.1239

### static_grid
- Params: {"hour":17,"minute":4,"dir":"UP","pMin":0.6,"pMax":0.75}
- Train WR: 76.0%, LCB: 62.6%
- Holdout WR: 81.5%, Events: 27, Avg Entry: 0.671
- Holdout EV/trade: 0.1209

### static_grid
- Params: {"hour":22,"minute":1,"dir":"UP","pMin":0.55,"pMax":0.7}
- Train WR: 74.6%, LCB: 62.7%
- Holdout WR: 76.3%, Events: 38, Avg Entry: 0.620
- Holdout EV/trade: 0.1200

### static_grid
- Params: {"hour":22,"minute":2,"dir":"UP","pMin":0.55,"pMax":0.7}
- Train WR: 75.0%, LCB: 61.8%
- Holdout WR: 78.4%, Events: 37, Avg Entry: 0.641
- Holdout EV/trade: 0.1195

### static_grid
- Params: {"hour":12,"minute":3,"dir":"DOWN","pMin":0.6,"pMax":0.75}
- Train WR: 80.6%, LCB: 65.0%
- Holdout WR: 81.8%, Events: 22, Avg Entry: 0.677
- Holdout EV/trade: 0.1186
