# EPOCH 3 Reinvestigation V2 — Strategy Discovery Report

Generated: 2026-05-02T09:20:56.310Z

## Data Sources
- 15m: 8174 cycles (train=4904, holdout=3270)
- 5m: 16045 cycles (train=9627, holdout=6418)
- 4h: 336 cycles (train=201, holdout=135)

## Mining Results
- Total train-selected candidates: 342
- Holdout-passing (WR≥58%, events≥5, EV>0): 134

## Top Candidates by Holdout EV

### static_grid
- Params: {"hour":17,"minute":3,"dir":"UP","pMin":0.6,"pMax":0.75}
- Train WR: 76.4%, LCB: 63.7%
- Holdout WR: 92.0%, Events: 25, Avg Entry: 0.664
- Holdout EV/trade: 0.2331

### static_grid
- Params: {"hour":17,"minute":3,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 78.3%, LCB: 64.4%
- Holdout WR: 95.2%, Events: 21, Avg Entry: 0.723
- Holdout EV/trade: 0.2076

### static_grid
- Params: {"hour":18,"minute":1,"dir":"UP","pMin":0.6,"pMax":0.75}
- Train WR: 79.5%, LCB: 64.5%
- Holdout WR: 87.0%, Events: 23, Avg Entry: 0.647
- Holdout EV/trade: 0.2003

### static_grid
- Params: {"hour":19,"minute":5,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 91.4%, LCB: 77.6%
- Holdout WR: 90.0%, Events: 20, Avg Entry: 0.704
- Holdout EV/trade: 0.1742

### static_grid
- Params: {"hour":8,"minute":1,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 86.7%, LCB: 62.1%
- Holdout WR: 90.0%, Events: 20, Avg Entry: 0.716
- Holdout EV/trade: 0.1622

### static_grid
- Params: {"hour":20,"minute":2,"dir":"DOWN","pMin":0.6,"pMax":0.75}
- Train WR: 81.4%, LCB: 67.4%
- Holdout WR: 84.0%, Events: 25, Avg Entry: 0.659
- Holdout EV/trade: 0.1582

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
- Params: {"hour":23,"minute":5,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 83.7%, LCB: 70.0%
- Holdout WR: 88.4%, Events: 43, Avg Entry: 0.713
- Holdout EV/trade: 0.1486

### static_grid
- Params: {"hour":17,"minute":4,"dir":"UP","pMin":0.6,"pMax":0.75}
- Train WR: 76.0%, LCB: 62.6%
- Holdout WR: 84.0%, Events: 25, Avg Entry: 0.670
- Holdout EV/trade: 0.1474

### static_grid
- Params: {"hour":6,"minute":5,"dir":"DOWN","pMin":0.6,"pMax":0.75}
- Train WR: 78.0%, LCB: 63.3%
- Holdout WR: 84.2%, Events: 19, Avg Entry: 0.676
- Holdout EV/trade: 0.1434

### static_grid
- Params: {"hour":22,"minute":2,"dir":"UP","pMin":0.6,"pMax":0.75}
- Train WR: 74.5%, LCB: 60.5%
- Holdout WR: 84.0%, Events: 50, Avg Entry: 0.681
- Holdout EV/trade: 0.1370

### static_grid
- Params: {"hour":19,"minute":3,"dir":"UP","pMin":0.6,"pMax":0.75}
- Train WR: 81.3%, LCB: 68.1%
- Holdout WR: 81.8%, Events: 22, Avg Entry: 0.659
- Holdout EV/trade: 0.1365

### static_grid
- Params: {"hour":21,"minute":1,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 78.6%, LCB: 60.5%
- Holdout WR: 83.3%, Events: 12, Avg Entry: 0.684
- Holdout EV/trade: 0.1270

### static_grid
- Params: {"hour":20,"minute":2,"dir":"DOWN","pMin":0.65,"pMax":0.8}
- Train WR: 82.2%, LCB: 68.7%
- Holdout WR: 85.7%, Events: 14, Avg Entry: 0.709
- Holdout EV/trade: 0.1268

### static_grid
- Params: {"hour":5,"minute":5,"dir":"DOWN","pMin":0.55,"pMax":0.7}
- Train WR: 76.3%, LCB: 60.8%
- Holdout WR: 78.6%, Events: 28, Avg Entry: 0.636
- Holdout EV/trade: 0.1266

### static_grid
- Params: {"hour":17,"minute":4,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 78.8%, LCB: 66.0%
- Holdout WR: 86.4%, Events: 22, Avg Entry: 0.716
- Holdout EV/trade: 0.1262

### static_grid
- Params: {"hour":16,"minute":5,"dir":"DOWN","pMin":0.6,"pMax":0.75}
- Train WR: 77.8%, LCB: 61.9%
- Holdout WR: 83.3%, Events: 24, Avg Entry: 0.686
- Holdout EV/trade: 0.1251

### static_grid
- Params: {"hour":6,"minute":4,"dir":"DOWN","pMin":0.65,"pMax":0.8}
- Train WR: 82.1%, LCB: 64.4%
- Holdout WR: 87.5%, Events: 32, Avg Entry: 0.730
- Holdout EV/trade: 0.1239

### static_grid
- Params: {"hour":22,"minute":3,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 85.2%, LCB: 67.5%
- Holdout WR: 88.2%, Events: 34, Avg Entry: 0.739
- Holdout EV/trade: 0.1219
