# Cycle Analysis Report

- **Directory**: `C:\Users\voide\Downloads\POLYPROPHET-main\POLYPROPHET-main\debug`
- **Files scanned**: 110
- **Unique cycles**: 1973

## Overall

- **Accuracy**: 72% (correct=1421, incorrect=552, unknown=0)
- **Oracle-locked accuracy**: 64.1% (n=856)

## Breakdown

### By tier
```json
{
  "CONVICTION": {
    "n": 619,
    "accuracy": 98.9,
    "correct": 612,
    "incorrect": 7,
    "unknown": 0
  },
  "NONE": {
    "n": 958,
    "accuracy": 43.9,
    "correct": 421,
    "incorrect": 537,
    "unknown": 0
  },
  "ADVISORY": {
    "n": 396,
    "accuracy": 98,
    "correct": 388,
    "incorrect": 8,
    "unknown": 0
  }
}
```

### By hour (UTC)
```json
{
  "10": {
    "n": 106,
    "accuracy": 60.4,
    "correct": 64,
    "incorrect": 42,
    "unknown": 0
  },
  "11": {
    "n": 80,
    "accuracy": 53.8,
    "correct": 43,
    "incorrect": 37,
    "unknown": 0
  },
  "12": {
    "n": 83,
    "accuracy": 72.3,
    "correct": 60,
    "incorrect": 23,
    "unknown": 0
  },
  "13": {
    "n": 76,
    "accuracy": 80.3,
    "correct": 61,
    "incorrect": 15,
    "unknown": 0
  },
  "14": {
    "n": 135,
    "accuracy": 79.3,
    "correct": 107,
    "incorrect": 28,
    "unknown": 0
  },
  "15": {
    "n": 132,
    "accuracy": 81.1,
    "correct": 107,
    "incorrect": 25,
    "unknown": 0
  },
  "16": {
    "n": 100,
    "accuracy": 80,
    "correct": 80,
    "incorrect": 20,
    "unknown": 0
  },
  "17": {
    "n": 94,
    "accuracy": 74.5,
    "correct": 70,
    "incorrect": 24,
    "unknown": 0
  },
  "18": {
    "n": 87,
    "accuracy": 78.2,
    "correct": 68,
    "incorrect": 19,
    "unknown": 0
  },
  "19": {
    "n": 102,
    "accuracy": 65.7,
    "correct": 67,
    "incorrect": 35,
    "unknown": 0
  },
  "20": {
    "n": 100,
    "accuracy": 78,
    "correct": 78,
    "incorrect": 22,
    "unknown": 0
  },
  "21": {
    "n": 73,
    "accuracy": 76.7,
    "correct": 56,
    "incorrect": 17,
    "unknown": 0
  },
  "22": {
    "n": 95,
    "accuracy": 64.2,
    "correct": 61,
    "incorrect": 34,
    "unknown": 0
  },
  "23": {
    "n": 63,
    "accuracy": 63.5,
    "correct": 40,
    "incorrect": 23,
    "unknown": 0
  },
  "08": {
    "n": 60,
    "accuracy": 78.3,
    "correct": 47,
    "incorrect": 13,
    "unknown": 0
  },
  "09": {
    "n": 110,
    "accuracy": 77.3,
    "correct": 85,
    "incorrect": 25,
    "unknown": 0
  },
  "00": {
    "n": 44,
    "accuracy": 77.3,
    "correct": 34,
    "incorrect": 10,
    "unknown": 0
  },
  "04": {
    "n": 46,
    "accuracy": 56.5,
    "correct": 26,
    "incorrect": 20,
    "unknown": 0
  },
  "05": {
    "n": 76,
    "accuracy": 67.1,
    "correct": 51,
    "incorrect": 25,
    "unknown": 0
  },
  "06": {
    "n": 77,
    "accuracy": 70.1,
    "correct": 54,
    "incorrect": 23,
    "unknown": 0
  },
  "07": {
    "n": 59,
    "accuracy": 67.8,
    "correct": 40,
    "incorrect": 19,
    "unknown": 0
  },
  "03": {
    "n": 64,
    "accuracy": 67.2,
    "correct": 43,
    "incorrect": 21,
    "unknown": 0
  },
  "01": {
    "n": 48,
    "accuracy": 66.7,
    "correct": 32,
    "incorrect": 16,
    "unknown": 0
  },
  "02": {
    "n": 63,
    "accuracy": 74.6,
    "correct": 47,
    "incorrect": 16,
    "unknown": 0
  }
}
```

### By market YES odds bucket (cycle-end yesPrice)
```json
{
  "95-100c": {
    "n": 980,
    "accuracy": 79.3,
    "correct": 777,
    "incorrect": 203,
    "unknown": 0
  },
  "<20c": {
    "n": 913,
    "accuracy": 64.5,
    "correct": 589,
    "incorrect": 324,
    "unknown": 0
  },
  "50-80c": {
    "n": 31,
    "accuracy": 80.6,
    "correct": 25,
    "incorrect": 6,
    "unknown": 0
  },
  "80-95c": {
    "n": 18,
    "accuracy": 38.9,
    "correct": 7,
    "incorrect": 11,
    "unknown": 0
  },
  "20-50c": {
    "n": 31,
    "accuracy": 74.2,
    "correct": 23,
    "incorrect": 8,
    "unknown": 0
  }
}
```

### By tier × market YES odds bucket
```json
{
  "CONVICTION": {
    "95-100c": {
      "n": 362,
      "correct": 360,
      "incorrect": 2,
      "unknown": 0,
      "accuracy": 99.4
    },
    "<20c": {
      "n": 245,
      "correct": 243,
      "incorrect": 2,
      "unknown": 0,
      "accuracy": 99.2
    },
    "50-80c": {
      "n": 2,
      "correct": 1,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 50
    },
    "20-50c": {
      "n": 6,
      "correct": 6,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "80-95c": {
      "n": 4,
      "correct": 2,
      "incorrect": 2,
      "unknown": 0,
      "accuracy": 50
    }
  },
  "NONE": {
    "95-100c": {
      "n": 397,
      "correct": 199,
      "incorrect": 198,
      "unknown": 0,
      "accuracy": 50.1
    },
    "<20c": {
      "n": 514,
      "correct": 193,
      "incorrect": 321,
      "unknown": 0,
      "accuracy": 37.5
    },
    "80-95c": {
      "n": 8,
      "correct": 0,
      "incorrect": 8,
      "unknown": 0,
      "accuracy": 0
    },
    "20-50c": {
      "n": 18,
      "correct": 12,
      "incorrect": 6,
      "unknown": 0,
      "accuracy": 66.7
    },
    "50-80c": {
      "n": 21,
      "correct": 17,
      "incorrect": 4,
      "unknown": 0,
      "accuracy": 81
    }
  },
  "ADVISORY": {
    "<20c": {
      "n": 154,
      "correct": 153,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 99.4
    },
    "95-100c": {
      "n": 221,
      "correct": 218,
      "incorrect": 3,
      "unknown": 0,
      "accuracy": 98.6
    },
    "50-80c": {
      "n": 8,
      "correct": 7,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 87.5
    },
    "80-95c": {
      "n": 6,
      "correct": 5,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 83.3
    },
    "20-50c": {
      "n": 7,
      "correct": 5,
      "incorrect": 2,
      "unknown": 0,
      "accuracy": 71.4
    }
  }
}
```

### By hour (UTC) × tier
```json
{
  "10": {
    "NONE": {
      "n": 60,
      "correct": 20,
      "incorrect": 40,
      "unknown": 0,
      "accuracy": 33.3
    },
    "CONVICTION": {
      "n": 28,
      "correct": 27,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 96.4
    },
    "ADVISORY": {
      "n": 18,
      "correct": 17,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 94.4
    }
  },
  "11": {
    "NONE": {
      "n": 52,
      "correct": 18,
      "incorrect": 34,
      "unknown": 0,
      "accuracy": 34.6
    },
    "CONVICTION": {
      "n": 22,
      "correct": 21,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 95.5
    },
    "ADVISORY": {
      "n": 6,
      "correct": 4,
      "incorrect": 2,
      "unknown": 0,
      "accuracy": 66.7
    }
  },
  "12": {
    "NONE": {
      "n": 42,
      "correct": 20,
      "incorrect": 22,
      "unknown": 0,
      "accuracy": 47.6
    },
    "ADVISORY": {
      "n": 14,
      "correct": 13,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 92.9
    },
    "CONVICTION": {
      "n": 27,
      "correct": 27,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "13": {
    "NONE": {
      "n": 39,
      "correct": 24,
      "incorrect": 15,
      "unknown": 0,
      "accuracy": 61.5
    },
    "ADVISORY": {
      "n": 17,
      "correct": 17,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "CONVICTION": {
      "n": 20,
      "correct": 20,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "14": {
    "CONVICTION": {
      "n": 43,
      "correct": 43,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "ADVISORY": {
      "n": 33,
      "correct": 33,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "NONE": {
      "n": 59,
      "correct": 31,
      "incorrect": 28,
      "unknown": 0,
      "accuracy": 52.5
    }
  },
  "15": {
    "NONE": {
      "n": 61,
      "correct": 38,
      "incorrect": 23,
      "unknown": 0,
      "accuracy": 62.3
    },
    "CONVICTION": {
      "n": 40,
      "correct": 39,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 97.5
    },
    "ADVISORY": {
      "n": 31,
      "correct": 30,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 96.8
    }
  },
  "16": {
    "NONE": {
      "n": 49,
      "correct": 29,
      "incorrect": 20,
      "unknown": 0,
      "accuracy": 59.2
    },
    "CONVICTION": {
      "n": 27,
      "correct": 27,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "ADVISORY": {
      "n": 24,
      "correct": 24,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "17": {
    "CONVICTION": {
      "n": 30,
      "correct": 29,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 96.7
    },
    "ADVISORY": {
      "n": 22,
      "correct": 22,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "NONE": {
      "n": 42,
      "correct": 19,
      "incorrect": 23,
      "unknown": 0,
      "accuracy": 45.2
    }
  },
  "18": {
    "NONE": {
      "n": 37,
      "correct": 18,
      "incorrect": 19,
      "unknown": 0,
      "accuracy": 48.6
    },
    "CONVICTION": {
      "n": 36,
      "correct": 36,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "ADVISORY": {
      "n": 14,
      "correct": 14,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "19": {
    "NONE": {
      "n": 61,
      "correct": 27,
      "incorrect": 34,
      "unknown": 0,
      "accuracy": 44.3
    },
    "CONVICTION": {
      "n": 25,
      "correct": 24,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 96
    },
    "ADVISORY": {
      "n": 16,
      "correct": 16,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "20": {
    "NONE": {
      "n": 45,
      "correct": 23,
      "incorrect": 22,
      "unknown": 0,
      "accuracy": 51.1
    },
    "CONVICTION": {
      "n": 31,
      "correct": 31,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "ADVISORY": {
      "n": 24,
      "correct": 24,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "21": {
    "NONE": {
      "n": 30,
      "correct": 14,
      "incorrect": 16,
      "unknown": 0,
      "accuracy": 46.7
    },
    "CONVICTION": {
      "n": 24,
      "correct": 23,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 95.8
    },
    "ADVISORY": {
      "n": 19,
      "correct": 19,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "22": {
    "ADVISORY": {
      "n": 20,
      "correct": 19,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 95
    },
    "CONVICTION": {
      "n": 29,
      "correct": 29,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "NONE": {
      "n": 46,
      "correct": 13,
      "incorrect": 33,
      "unknown": 0,
      "accuracy": 28.3
    }
  },
  "23": {
    "ADVISORY": {
      "n": 17,
      "correct": 17,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "NONE": {
      "n": 32,
      "correct": 9,
      "incorrect": 23,
      "unknown": 0,
      "accuracy": 28.1
    },
    "CONVICTION": {
      "n": 14,
      "correct": 14,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "08": {
    "CONVICTION": {
      "n": 22,
      "correct": 22,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "NONE": {
      "n": 25,
      "correct": 12,
      "incorrect": 13,
      "unknown": 0,
      "accuracy": 48
    },
    "ADVISORY": {
      "n": 13,
      "correct": 13,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "09": {
    "CONVICTION": {
      "n": 44,
      "correct": 44,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "NONE": {
      "n": 51,
      "correct": 26,
      "incorrect": 25,
      "unknown": 0,
      "accuracy": 51
    },
    "ADVISORY": {
      "n": 15,
      "correct": 15,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "00": {
    "NONE": {
      "n": 20,
      "correct": 10,
      "incorrect": 10,
      "unknown": 0,
      "accuracy": 50
    },
    "CONVICTION": {
      "n": 20,
      "correct": 20,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "ADVISORY": {
      "n": 4,
      "correct": 4,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "04": {
    "NONE": {
      "n": 27,
      "correct": 7,
      "incorrect": 20,
      "unknown": 0,
      "accuracy": 25.9
    },
    "CONVICTION": {
      "n": 12,
      "correct": 12,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "ADVISORY": {
      "n": 7,
      "correct": 7,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "05": {
    "NONE": {
      "n": 35,
      "correct": 10,
      "incorrect": 25,
      "unknown": 0,
      "accuracy": 28.6
    },
    "CONVICTION": {
      "n": 27,
      "correct": 27,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "ADVISORY": {
      "n": 14,
      "correct": 14,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "06": {
    "NONE": {
      "n": 29,
      "correct": 6,
      "incorrect": 23,
      "unknown": 0,
      "accuracy": 20.7
    },
    "ADVISORY": {
      "n": 22,
      "correct": 22,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "CONVICTION": {
      "n": 26,
      "correct": 26,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "07": {
    "NONE": {
      "n": 25,
      "correct": 8,
      "incorrect": 17,
      "unknown": 0,
      "accuracy": 32
    },
    "CONVICTION": {
      "n": 24,
      "correct": 23,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 95.8
    },
    "ADVISORY": {
      "n": 10,
      "correct": 9,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 90
    }
  },
  "03": {
    "NONE": {
      "n": 33,
      "correct": 12,
      "incorrect": 21,
      "unknown": 0,
      "accuracy": 36.4
    },
    "CONVICTION": {
      "n": 24,
      "correct": 24,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "ADVISORY": {
      "n": 7,
      "correct": 7,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "01": {
    "NONE": {
      "n": 27,
      "correct": 11,
      "incorrect": 16,
      "unknown": 0,
      "accuracy": 40.7
    },
    "ADVISORY": {
      "n": 14,
      "correct": 14,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "CONVICTION": {
      "n": 7,
      "correct": 7,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "02": {
    "ADVISORY": {
      "n": 15,
      "correct": 14,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 93.3
    },
    "CONVICTION": {
      "n": 17,
      "correct": 17,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "NONE": {
      "n": 31,
      "correct": 16,
      "incorrect": 15,
      "unknown": 0,
      "accuracy": 51.6
    }
  }
}
```

### By asset × tier
```json
{
  "BTC": {
    "CONVICTION": {
      "n": 27,
      "correct": 26,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 96.3
    },
    "NONE": {
      "n": 288,
      "correct": 189,
      "incorrect": 99,
      "unknown": 0,
      "accuracy": 65.6
    },
    "ADVISORY": {
      "n": 171,
      "correct": 169,
      "incorrect": 2,
      "unknown": 0,
      "accuracy": 98.8
    }
  },
  "ETH": {
    "CONVICTION": {
      "n": 65,
      "correct": 64,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 98.5
    },
    "NONE": {
      "n": 259,
      "correct": 154,
      "incorrect": 105,
      "unknown": 0,
      "accuracy": 59.5
    },
    "ADVISORY": {
      "n": 166,
      "correct": 161,
      "incorrect": 5,
      "unknown": 0,
      "accuracy": 97
    }
  },
  "SOL": {
    "CONVICTION": {
      "n": 229,
      "correct": 226,
      "incorrect": 3,
      "unknown": 0,
      "accuracy": 98.7
    },
    "NONE": {
      "n": 209,
      "correct": 77,
      "incorrect": 132,
      "unknown": 0,
      "accuracy": 36.8
    },
    "ADVISORY": {
      "n": 58,
      "correct": 57,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 98.3
    }
  },
  "XRP": {
    "NONE": {
      "n": 202,
      "correct": 1,
      "incorrect": 201,
      "unknown": 0,
      "accuracy": 0.5
    },
    "CONVICTION": {
      "n": 298,
      "correct": 296,
      "incorrect": 2,
      "unknown": 0,
      "accuracy": 99.3
    },
    "ADVISORY": {
      "n": 1,
      "correct": 1,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  }
}
```

### By asset|tier × market YES odds bucket
```json
{
  "BTC|CONVICTION": {
    "95-100c": {
      "n": 15,
      "correct": 15,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "<20c": {
      "n": 10,
      "correct": 10,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "80-95c": {
      "n": 1,
      "correct": 0,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 0
    },
    "20-50c": {
      "n": 1,
      "correct": 1,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "ETH|CONVICTION": {
    "95-100c": {
      "n": 36,
      "correct": 35,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 97.2
    },
    "<20c": {
      "n": 28,
      "correct": 28,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "80-95c": {
      "n": 1,
      "correct": 1,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "SOL|CONVICTION": {
    "95-100c": {
      "n": 138,
      "correct": 138,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "<20c": {
      "n": 88,
      "correct": 86,
      "incorrect": 2,
      "unknown": 0,
      "accuracy": 97.7
    },
    "50-80c": {
      "n": 1,
      "correct": 1,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "20-50c": {
      "n": 1,
      "correct": 1,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "80-95c": {
      "n": 1,
      "correct": 0,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 0
    }
  },
  "XRP|NONE": {
    "95-100c": {
      "n": 79,
      "correct": 0,
      "incorrect": 79,
      "unknown": 0,
      "accuracy": 0
    },
    "<20c": {
      "n": 117,
      "correct": 1,
      "incorrect": 116,
      "unknown": 0,
      "accuracy": 0.9
    },
    "80-95c": {
      "n": 3,
      "correct": 0,
      "incorrect": 3,
      "unknown": 0,
      "accuracy": 0
    },
    "20-50c": {
      "n": 3,
      "correct": 0,
      "incorrect": 3,
      "unknown": 0,
      "accuracy": 0
    }
  },
  "SOL|NONE": {
    "<20c": {
      "n": 113,
      "correct": 35,
      "incorrect": 78,
      "unknown": 0,
      "accuracy": 31
    },
    "95-100c": {
      "n": 90,
      "correct": 41,
      "incorrect": 49,
      "unknown": 0,
      "accuracy": 45.6
    },
    "80-95c": {
      "n": 4,
      "correct": 0,
      "incorrect": 4,
      "unknown": 0,
      "accuracy": 0
    },
    "20-50c": {
      "n": 2,
      "correct": 1,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 50
    }
  },
  "XRP|CONVICTION": {
    "95-100c": {
      "n": 173,
      "correct": 172,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 99.4
    },
    "<20c": {
      "n": 119,
      "correct": 119,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "20-50c": {
      "n": 4,
      "correct": 4,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "80-95c": {
      "n": 1,
      "correct": 1,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "50-80c": {
      "n": 1,
      "correct": 0,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 0
    }
  },
  "BTC|NONE": {
    "<20c": {
      "n": 136,
      "correct": 81,
      "incorrect": 55,
      "unknown": 0,
      "accuracy": 59.6
    },
    "95-100c": {
      "n": 122,
      "correct": 83,
      "incorrect": 39,
      "unknown": 0,
      "accuracy": 68
    },
    "50-80c": {
      "n": 18,
      "correct": 15,
      "incorrect": 3,
      "unknown": 0,
      "accuracy": 83.3
    },
    "20-50c": {
      "n": 12,
      "correct": 10,
      "incorrect": 2,
      "unknown": 0,
      "accuracy": 83.3
    }
  },
  "ETH|NONE": {
    "<20c": {
      "n": 148,
      "correct": 76,
      "incorrect": 72,
      "unknown": 0,
      "accuracy": 51.4
    },
    "95-100c": {
      "n": 106,
      "correct": 75,
      "incorrect": 31,
      "unknown": 0,
      "accuracy": 70.8
    },
    "20-50c": {
      "n": 1,
      "correct": 1,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "80-95c": {
      "n": 1,
      "correct": 0,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 0
    },
    "50-80c": {
      "n": 3,
      "correct": 2,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 66.7
    }
  },
  "BTC|ADVISORY": {
    "<20c": {
      "n": 63,
      "correct": 63,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "95-100c": {
      "n": 93,
      "correct": 93,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "50-80c": {
      "n": 7,
      "correct": 6,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 85.7
    },
    "80-95c": {
      "n": 3,
      "correct": 2,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 66.7
    },
    "20-50c": {
      "n": 5,
      "correct": 5,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "ETH|ADVISORY": {
    "<20c": {
      "n": 63,
      "correct": 62,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 98.4
    },
    "95-100c": {
      "n": 99,
      "correct": 96,
      "incorrect": 3,
      "unknown": 0,
      "accuracy": 97
    },
    "80-95c": {
      "n": 2,
      "correct": 2,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "20-50c": {
      "n": 1,
      "correct": 0,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 0
    },
    "50-80c": {
      "n": 1,
      "correct": 1,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "SOL|ADVISORY": {
    "<20c": {
      "n": 27,
      "correct": 27,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "95-100c": {
      "n": 29,
      "correct": 29,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    },
    "20-50c": {
      "n": 1,
      "correct": 0,
      "incorrect": 1,
      "unknown": 0,
      "accuracy": 0
    },
    "80-95c": {
      "n": 1,
      "correct": 1,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  },
  "XRP|ADVISORY": {
    "<20c": {
      "n": 1,
      "correct": 1,
      "incorrect": 0,
      "unknown": 0,
      "accuracy": 100
    }
  }
}
```

> Full machine output: `cycle_report.json`