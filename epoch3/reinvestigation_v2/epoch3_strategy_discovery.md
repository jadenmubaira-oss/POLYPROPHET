# EPOCH 3 Reinvestigation V2 — Strategy Discovery Report

Generated: 2026-04-28T08:47:11.278Z

## Data Sources
- 15m: 6404 cycles (train=3842, holdout=2562)
- 5m: 16045 cycles (train=9627, holdout=6418)
- 4h: 336 cycles (train=201, holdout=135)

## Mining Results
- Total train-selected candidates: 324
- Holdout-passing (WR≥58%, events≥5, EV>0): 128

## Top Candidates by Holdout EV

### static_grid
- Params: {"hour":15,"minute":3,"dir":"DOWN","pMin":0.55,"pMax":0.7}
- Train WR: 78.6%, LCB: 60.5%
- Holdout WR: 95.0%, Events: 20, Avg Entry: 0.653
- Holdout EV/trade: 0.2743

### static_grid
- Params: {"hour":15,"minute":3,"dir":"DOWN","pMin":0.6,"pMax":0.75}
- Train WR: 82.6%, LCB: 62.9%
- Holdout WR: 96.3%, Events: 27, Avg Entry: 0.683
- Holdout EV/trade: 0.2579

### static_grid
- Params: {"hour":15,"minute":3,"dir":"DOWN","pMin":0.65,"pMax":0.8}
- Train WR: 87.0%, LCB: 67.9%
- Holdout WR: 100.0%, Events: 28, Avg Entry: 0.721
- Holdout EV/trade: 0.2571

### static_grid
- Params: {"hour":22,"minute":3,"dir":"DOWN","pMin":0.6,"pMax":0.75}
- Train WR: 80.8%, LCB: 62.1%
- Holdout WR: 87.5%, Events: 16, Avg Entry: 0.649
- Holdout EV/trade: 0.2035

### static_grid
- Params: {"hour":6,"minute":2,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 89.7%, LCB: 73.6%
- Holdout WR: 93.8%, Events: 16, Avg Entry: 0.725
- Holdout EV/trade: 0.1911

### static_grid
- Params: {"hour":7,"minute":3,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 84.2%, LCB: 62.4%
- Holdout WR: 90.9%, Events: 11, Avg Entry: 0.699
- Holdout EV/trade: 0.1885

### static_grid
- Params: {"hour":1,"minute":2,"dir":"DOWN","pMin":0.55,"pMax":0.7}
- Train WR: 73.0%, LCB: 61.0%
- Holdout WR: 82.6%, Events: 23, Avg Entry: 0.631
- Holdout EV/trade: 0.1720

### static_grid
- Params: {"hour":22,"minute":3,"dir":"DOWN","pMin":0.65,"pMax":0.8}
- Train WR: 86.7%, LCB: 70.3%
- Holdout WR: 88.9%, Events: 9, Avg Entry: 0.696
- Holdout EV/trade: 0.1708

### static_grid
- Params: {"hour":6,"minute":2,"dir":"UP","pMin":0.6,"pMax":0.75}
- Train WR: 78.4%, LCB: 62.8%
- Holdout WR: 85.7%, Events: 14, Avg Entry: 0.666
- Holdout EV/trade: 0.1686

### static_grid
- Params: {"hour":9,"minute":4,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 80.8%, LCB: 62.1%
- Holdout WR: 88.9%, Events: 9, Avg Entry: 0.701
- Holdout EV/trade: 0.1659

### static_grid
- Params: {"hour":15,"minute":2,"dir":"DOWN","pMin":0.65,"pMax":0.8}
- Train WR: 88.9%, LCB: 67.2%
- Holdout WR: 89.5%, Events: 19, Avg Entry: 0.711
- Holdout EV/trade: 0.1617

### static_grid
- Params: {"hour":5,"minute":2,"dir":"DOWN","pMin":0.6,"pMax":0.75}
- Train WR: 76.3%, LCB: 64.0%
- Holdout WR: 85.4%, Events: 48, Avg Entry: 0.676
- Holdout EV/trade: 0.1558

### static_grid
- Params: {"hour":15,"minute":2,"dir":"UP","pMin":0.6,"pMax":0.75}
- Train WR: 78.8%, LCB: 62.2%
- Holdout WR: 81.0%, Events: 21, Avg Entry: 0.632
- Holdout EV/trade: 0.1544

### static_grid
- Params: {"hour":22,"minute":1,"dir":"UP","pMin":0.55,"pMax":0.7}
- Train WR: 74.5%, LCB: 60.5%
- Holdout WR: 78.1%, Events: 32, Avg Entry: 0.619
- Holdout EV/trade: 0.1393

### static_grid
- Params: {"hour":23,"minute":5,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 83.8%, LCB: 68.9%
- Holdout WR: 88.0%, Events: 25, Avg Entry: 0.719
- Holdout EV/trade: 0.1391

### static_grid
- Params: {"hour":7,"minute":3,"dir":"DOWN","pMin":0.65,"pMax":0.8}
- Train WR: 94.1%, LCB: 80.9%
- Holdout WR: 88.0%, Events: 25, Avg Entry: 0.720
- Holdout EV/trade: 0.1383

### static_grid
- Params: {"hour":1,"minute":4,"dir":"DOWN","pMin":0.65,"pMax":0.8}
- Train WR: 77.5%, LCB: 62.5%
- Holdout WR: 88.2%, Events: 17, Avg Entry: 0.723
- Holdout EV/trade: 0.1383

### static_grid
- Params: {"hour":14,"minute":3,"dir":"UP","pMin":0.65,"pMax":0.8}
- Train WR: 85.7%, LCB: 70.6%
- Holdout WR: 87.5%, Events: 16, Avg Entry: 0.718
- Holdout EV/trade: 0.1357

### static_grid
- Params: {"hour":18,"minute":4,"dir":"UP","pMin":0.6,"pMax":0.75}
- Train WR: 79.3%, LCB: 61.6%
- Holdout WR: 84.0%, Events: 25, Avg Entry: 0.683
- Holdout EV/trade: 0.1344

### static_grid
- Params: {"hour":20,"minute":2,"dir":"DOWN","pMin":0.6,"pMax":0.75}
- Train WR: 85.7%, LCB: 70.6%
- Holdout WR: 82.4%, Events: 17, Avg Entry: 0.672
- Holdout EV/trade: 0.1291
